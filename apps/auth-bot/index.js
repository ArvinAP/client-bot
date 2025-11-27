const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client, GatewayIntentBits, PermissionsBitField, Partials } = require('discord.js');
const https = require('https');

// Env config
const TOKEN = process.env.TOKEN;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || '';
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID || '';
const MEMBER_ROLE_NAME = process.env.MEMBER_ROLE_NAME || '';
const REMOVE_MISSING = String(process.env.NDA_REMOVE_MISSING || '').toLowerCase() === 'true';
const ENABLE_NDA_SYNC = String(process.env.ENABLE_NDA_SYNC || '').toLowerCase() === 'true';
const USE_GUILD_MEMBERS_INTENT = String(process.env.USE_GUILD_MEMBERS_INTENT || 'true').toLowerCase() === 'true';
const NDA_SYNC_INTERVAL_MS = Number(process.env.NDA_SYNC_INTERVAL_MS || 10_000);
const DEFAULT_GUILD_ID = process.env.GUILD_ID || null; // optional, will sync all guilds by default
const BAN_NON_SIGNED = String(process.env.NDA_BAN_NON_SIGNED || '').toLowerCase() === 'true';
const BAN_REASON = process.env.NDA_BAN_REASON || 'NDA not signed (sheet sync)';
const REMOVE_DENIED = String(process.env.NDA_REMOVE_DENIED || 'true').toLowerCase() === 'true';
// Column selection (either by header name or 1-based index)
const COL_ID_FIELD = (process.env.NDA_ID_FIELD || '').trim();
const COL_SIGNED_FIELD = (process.env.NDA_SIGNED_FIELD || 'ndaSigned').trim();
const COL_GUILDID_FIELD = (process.env.NDA_GUILDID_FIELD || '').trim();
const COL_ID_INDEX = Number(process.env.NDA_ID_COL_INDEX || 4); // 1-based, 0=disabled
const COL_SIGNED_INDEX = Number(process.env.NDA_SIGNED_COL_INDEX || 5);
const COL_GUILDID_INDEX = Number(process.env.NDA_GUILDID_COL_INDEX || 0);

if (!TOKEN) {
  console.error('[auth-bot] TOKEN is required');
  process.exit(1);
}
if (!SHEET_CSV_URL) {
  console.warn('[auth-bot] SHEET_CSV_URL is not set. /nda-sync will fail until configured.');
}

const client = new Client({
  intents: USE_GUILD_MEMBERS_INTENT
    ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    : [GatewayIntentBits.Guilds],
  partials: [Partials.GuildMember],
});

// In-memory memo to avoid repeated no-op work across frequent polls
const lastSyncState = new Map(); // guildId -> { allowedKey, holdersKey, deniedKey }

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      u.searchParams.set('_cb', Date.now().toString());
      url = u.toString();
    } catch {}
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
        return resolve(fetchCSV(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk.toString('utf8')));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSVToArrays(text) {
  // Robust-ish CSV parser: handles commas within quotes and double-quote escapes
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { // escaped quote
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    rows.push(parseLine(lines[i]).map((c) => (c ?? '').trim()));
  }
  return { headers, rows };
}

function getCell(row, headers, fieldName, index1Based) {
  if (index1Based && !isNaN(index1Based) && index1Based > 0) {
    return row[index1Based - 1] ?? '';
  }
  if (fieldName) {
    const i = headers.findIndex((h) => h === fieldName);
    if (i >= 0) return row[i] ?? '';
  }
  return '';
}

function parseBool(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function isExplicitNo(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'false' || s === '0' || s === 'no' || s === 'n';
}

async function readSheetArrays() {
  if (!SHEET_CSV_URL) throw new Error('SHEET_CSV_URL not configured');
  const csv = await fetchCSV(SHEET_CSV_URL);
  return parseCSVToArrays(csv);
}

async function resolveMemberRole(guild) {
  let role = null;
  if (MEMBER_ROLE_ID) role = guild.roles.cache.get(MEMBER_ROLE_ID) || null;
  if (!role && MEMBER_ROLE_NAME) {
    role = guild.roles.cache.find((r) => r.name === MEMBER_ROLE_NAME) || null;
  }
  return role;
}

async function syncGuildFromSheet(guild, options = {}) {
  const dryRun = !!options.dryRun;
  const role = await resolveMemberRole(guild);
  if (!role) throw new Error(`Member role not found (id=${MEMBER_ROLE_ID||'n/a'} name=${MEMBER_ROLE_NAME||'n/a'}) in guild ${guild.id}`);

  let haveMembersIntent = USE_GUILD_MEMBERS_INTENT;
  let members = null;
  if (haveMembersIntent) {
    // Full fetch (requires privileged intent). Fallback to per-ID mode on timeout.
    try {
      members = await guild.members.fetch();
    } catch (e) {
      haveMembersIntent = false;
      members = null;
      console.warn('[auth-bot] members.fetch failed, falling back to per-ID mode:', e?.message || e);
    }
  }

  const sheet = await readSheetArrays();
  const rows = sheet.rows;
  const headers = sheet.headers;
  // Expected columns: discordId (or configured), ndaSigned, optional guildId
  const allowed = new Set();
  const denied = new Set();
  const limitToGuild = !!(COL_GUILDID_FIELD || COL_GUILDID_INDEX);
  for (const r of rows) {
    const idRaw = String(getCell(r, headers, COL_ID_FIELD || 'discordId', COL_ID_INDEX)).trim();
    if (!idRaw) continue;
    // Only accept numeric Discord IDs to avoid usernames corrupting sets
    const id = /^\d+$/.test(idRaw) ? idRaw : '';
    if (!id) {
      if (String(process.env.LOG_SYNC || '').toLowerCase() === 'true') {
        console.warn('[auth-bot][warn] Ignoring non-numeric discordId value:', idRaw);
      }
      continue;
    }
    if (limitToGuild) {
      const gid = String(getCell(r, headers, COL_GUILDID_FIELD || 'guildId', COL_GUILDID_INDEX)).trim();
      if (gid && gid !== guild.id) continue;
    }
    const signedVal = getCell(r, headers, COL_SIGNED_FIELD || 'ndaSigned', COL_SIGNED_INDEX);
    const signed = parseBool(signedVal);
    if (signed) {
      allowed.add(id);
    } else if (isExplicitNo(signedVal)) {
      denied.add(id);
    }
  }

  // Determine current role holders (only if we have members intent)
  const holders = new Set();
  if (haveMembersIntent && members) {
    members
      .filter((m) => m.roles.cache.has(role.id))
      .forEach((m) => holders.add(m.id));
  }

  // no kick feature

  // Skip if nothing has changed compared to last run
  const allowedKey = Array.from(allowed).sort().join(',');
  const deniedKey = Array.from(denied).sort().join(',');
  const holdersKey = haveMembersIntent ? Array.from(holders).sort().join(',') : '';
  const prev = lastSyncState.get(guild.id);
  if (!dryRun && prev) {
    const sameAllowed = prev.allowedKey === allowedKey;
    // Denied deltas matter if we either ban non-signed or remove denied users
    const denyMatters = BAN_NON_SIGNED || REMOVE_DENIED;
    const sameDenied = denyMatters ? (prev.deniedKey === deniedKey) : true;
    const sameHolders = haveMembersIntent ? (prev.holdersKey === holdersKey) : true;
    if (sameAllowed && sameDenied && sameHolders) {
      return { added: 0, removed: 0, banned: 0, toAdd: [], toRemove: [], toBan: [], dryRun: false, skipped: true };
    }
  }

  const toAdd = [];
  const toRemove = [];

  if (haveMembersIntent && members) {
    // Verify up-to-date role presence by fetching the member to avoid stale cache
    for (const id of allowed) {
      try {
        const m = members.get(id) || await guild.members.fetch(id);
        if (!m.roles.cache.has(role.id)) toAdd.push(id);
      } catch (_) {
        // Not in guild or not fetchable; ignore
      }
    }
  } else {
    // Lite mode: check membership per ID without full member list
    for (const id of allowed) {
      try {
        const m = await guild.members.fetch(id);
        if (!m.roles.cache.has(role.id)) toAdd.push(id);
      } catch (_) {
        // Not in guild or not fetchable; ignore
      }
    }
  }

  // Optionally remove from those who have role but not allowed
  if (REMOVE_MISSING) {
    if (haveMembersIntent && holders.size) {
      for (const id of holders) {
        if (!allowed.has(id)) toRemove.push(id);
      }
    } else {
      console.warn('[auth-bot] REMOVE_MISSING requested but Guild Members intent is disabled; skip removals.');
    }
  }

  // Explicitly remove role from users marked as denied (NDA=no)
  if (REMOVE_DENIED) {
    if (haveMembersIntent) {
      // With members intent, schedule all denied IDs; removal will no-op if role not present
      for (const id of denied) {
        if (!toRemove.includes(id)) toRemove.push(id);
      }
    } else {
      // Lite mode: check denied users individually
      for (const id of denied) {
        try {
          const m = await guild.members.fetch(id);
          if (m.roles.cache.has(role.id) && !toRemove.includes(id)) toRemove.push(id);
        } catch (_) {}
      }
    }
  }

  // Prepare punishment list (ban only if enabled)
  let toBan = [];
  if (BAN_NON_SIGNED) {
    if (haveMembersIntent && members) {
      toBan = Array.from(denied).filter((id) => members.has(id));
    } else {
      for (const id of denied) { try { await guild.members.fetch(id); toBan.push(id); } catch (_) {} }
    }
  }

  if (String(process.env.LOG_SYNC || '').toLowerCase() === 'true') {
    console.log(`[auth-bot][debug] allowed=${allowed.size} denied=${denied.size} candAdd=${toAdd.length} candRemove=${toRemove.length} candBan=${toBan.length}`);
    try {
      const allowedList = Array.from(allowed);
      const deniedList = Array.from(denied);
      const holdersList = Array.from(holders || []);
      console.log(`[auth-bot][debug] allowedIDs=${allowedList.join(',')}`);
      console.log(`[auth-bot][debug] deniedIDs=${deniedList.join(',')}`);
      if (haveMembersIntent) console.log(`[auth-bot][debug] holdersIDs=${holdersList.join(',')}`);
      if (toAdd.length) console.log(`[auth-bot][debug] toAddIDs=${toAdd.join(',')}`);
      if (toRemove.length) console.log(`[auth-bot][debug] toRemoveIDs=${toRemove.join(',')}`);
    } catch {}
  }
  if (dryRun) {
    return { added: 0, removed: 0, banned: 0, toAdd, toRemove, toBan, dryRun: true };
  }

  // Execute with small concurrency
  let added = 0, removed = 0;
  let hadErrors = false;
  const runPool = async (ids, fn) => {
    const max = 3;
    let idx = 0;
    const next = async () => {
      if (idx >= ids.length) return;
      const id = ids[idx++];
      try { await fn(id); } catch (e) { hadErrors = true; console.warn('[auth-bot] role op failed:', e.message); }
      return next();
    };
    const tasks = [];
    for (let i = 0; i < Math.min(max, ids.length); i++) tasks.push(next());
    await Promise.all(tasks);
  };

  await runPool(toAdd, async (id) => {
    let m = null;
    try {
      m = members ? members.get(id) : null;
      if (!m) m = await guild.members.fetch(id);
    } catch (_) { m = null; }
    if (!m) return;
    if (String(process.env.LOG_SYNC || '').toLowerCase() === 'true') {
      console.log(`[auth-bot][op] add role ${role.id}:${role.name} -> member ${id}`);
    }
    let m2 = null;
    try {
      m2 = await m.roles.add(role, 'NDA signed (sheet sync)');
      let ok = m2.roles?.cache?.has?.(role.id);
      if (!ok) {
        try { m2 = await m2.fetch(); ok = m2.roles?.cache?.has?.(role.id); } catch {}
      }
      if (!ok) { hadErrors = true; console.warn('[auth-bot] verify add failed: role not present after add for', id); }
      else if (String(process.env.LOG_SYNC || '').toLowerCase() === 'true') {
        console.log(`[auth-bot][verify] add ok: member ${id} has role ${role.id}`);
      }
    } catch (e) {
      hadErrors = true;
      console.warn('[auth-bot] verify add error:', e.message);
    }
    added++;
  });

  await runPool(toRemove, async (id) => {
    let m = null;
    try { m = members ? members.get(id) : null; if (!m) m = await guild.members.fetch(id); } catch (_) { m = null; }
    if (!m) return;
    if (String(process.env.LOG_SYNC || '').toLowerCase() === 'true') {
      console.log(`[auth-bot][op] remove role ${role.id}:${role.name} -> member ${id}`);
    }
    let m3 = null;
    try {
      m3 = await m.roles.remove(role, 'NDA not signed (sheet sync)');
      let ok = !m3.roles?.cache?.has?.(role.id);
      if (!ok) {
        try { m3 = await m3.fetch(); ok = !m3.roles?.cache?.has?.(role.id); } catch {}
      }
      if (!ok) { hadErrors = true; console.warn('[auth-bot] verify remove failed: role still present after remove for', id); }
      else if (String(process.env.LOG_SYNC || '').toLowerCase() === 'true') {
        console.log(`[auth-bot][verify] remove ok: member ${id} no longer has role ${role.id}`);
      }
    } catch (e) {
      hadErrors = true;
      console.warn('[auth-bot] verify remove error:', e.message);
    }
    removed++;
  });

  let banned = 0;
  if (toBan.length) {
    await runPool(toBan, async (id) => {
      if (String(process.env.LOG_SYNC || '').toLowerCase() === 'true') {
        console.log(`[auth-bot][op] ban member ${id} reason="${BAN_REASON}"`);
      }
      try {
        await guild.members.ban(id, { reason: BAN_REASON });
        banned++;
      } catch (e) {
        hadErrors = true;
        console.warn('[auth-bot] ban failed:', e.message);
      }
    });
  }

  // Remember last state to short-circuit future runs only if no errors
  if (!hadErrors) {
    lastSyncState.set(guild.id, { allowedKey, holdersKey, deniedKey });
  }

  return { added, removed, banned, toAdd, toRemove, toBan, dryRun: false, hadErrors };
}

function buildCommands() {
  return [
    {
      name: 'nda-sync',
      description: 'Sync NDA role assignments from the configured sheet',
      options: [
        { name: 'dryrun', type: 5, description: 'Only show changes, do not modify roles', required: false },
      ],
    },
  ];
}

async function registerCommandsForGuild(guild) {
  try {
    await guild.commands.set(buildCommands());
    console.log(`[auth-bot] Registered commands in guild ${guild.id}`);
  } catch (e) {
    console.warn('[auth-bot] command register failed:', e.message);
  }
}

client.on('ready', async () => {
  console.log(`[auth-bot] Logged in as ${client.user.tag}`);
  // Register commands on all accessible guilds
  try {
    const guilds = await client.guilds.fetch();
    for (const [gid] of guilds) {
      const g = await client.guilds.fetch(gid).catch(() => null);
      if (g) await registerCommandsForGuild(g);
    }
  } catch {}

  if (ENABLE_NDA_SYNC) {
    setInterval(async () => {
      try {
        const guilds = [];
        if (DEFAULT_GUILD_ID) {
          const g = await client.guilds.fetch(DEFAULT_GUILD_ID).catch(() => null);
          if (g) guilds.push(await g.fetch());
        } else {
          const col = await client.guilds.fetch();
          for (const [gid] of col) {
            const g = await client.guilds.fetch(gid).catch(() => null);
            if (g) guilds.push(await g.fetch());
          }
        }
        for (const guild of guilds) {
          try {
            const res = await syncGuildFromSheet(guild, { dryRun: false });
            console.log(`[auth-bot][sync] guild=${guild.id} added=${res.added} removed=${res.removed} banned=${res.banned||0} toAdd=${res.toAdd.length} toRemove=${res.toRemove.length} toBan=${(res.toBan||[]).length}${res.skipped? ' skipped=true':''}`);
          } catch (e) {
            console.warn('[auth-bot][sync] failed for guild', guild?.id, e.message);
          }
        }
      } catch (e) {
        console.warn('[auth-bot] periodic sync error:', e.message);
      }
    }, NDA_SYNC_INTERVAL_MS);
    console.log(`[auth-bot] Periodic NDA sync enabled, interval=${NDA_SYNC_INTERVAL_MS}ms`);
  }
});

client.on('guildCreate', async (guild) => {
  await registerCommandsForGuild(guild);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'nda-sync') return;

    // Admin-only: require Administrator permission
    const perms = interaction.memberPermissions || interaction.member?.permissions;
    const isAdmin = perms && typeof perms.has === 'function' && perms.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin) return interaction.reply({ content: 'Admin only.', ephemeral: true });

    const dryRun = interaction.options.getBoolean('dryrun') || false;
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    if (!guild) return interaction.editReply('Not in a guild.');

    const res = await syncGuildFromSheet(guild, { dryRun });
    const summary = `NDA sync ${dryRun ? '(dry-run)' : ''}`
      + `\nAdded: ${res.added} (${res.toAdd.length} candidates)`
      + `\nRemoved: ${res.removed} (${res.toRemove.length} candidates)`
      + (BAN_NON_SIGNED ? `\nBanned: ${res.banned} (${res.toBan.length} candidates)` : '')
      + (res.skipped ? `\nSkipped: no changes` : '');
    return interaction.editReply(summary);
  } catch (e) {
    console.warn('[auth-bot] /nda-sync failed:', e.message);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'Sync failed', ephemeral: true }); } catch {}
    }
  }
});

client.login(TOKEN);

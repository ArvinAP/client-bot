require("dotenv" ).config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require("discord.js");
const chrono = require('chrono-node');
const { formatFormMessage } = require("./formatter");
const { getDb } = require("../../packages/firebase");
const TENANT_GUILD_ID = process.env.TENANT_GUILD_ID || null;
const TENANT_CHANNEL_ID = process.env.TENANT_CHANNEL_ID || null;
const BOT_AUDIENCE = (process.env.BOT_AUDIENCE || 'client').toLowerCase(); // 'client' or 'employee'

function safeText(s) {
  // prevent accidental mentions by inserting zero-width space after '@'
  return String(s ?? "").replace(/@/g, "@\u200b");
}

// Create Discord client EARLY so all handlers can reference it
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.login(process.env.TOKEN);

// ---- Wizard (message-driven) ----
const sessions = new Map(); // key: `${guildId}:${channelId}:${userId}` -> session state

const WIZ_STEPS = [
  { key: 'type', prompt: 'Enter an event type (or type `skip`). Example: Meeting, Playtest, Raid', required: false, transform: (v)=> v.toLowerCase()==='skip' ? '' : v },
  { key: 'title', prompt: 'Enter a title for this event.', required: true, validate: (v)=>v.trim().length>0 || 'Title is required.' },
  { key: 'description', prompt: 'Enter a description for this event (or type `skip`).', required: false, transform: (v)=> v.toLowerCase()==='skip' ? '' : v },
  { key: 'startsAt', prompt: 'Enter the start time (examples: "tomorrow 8pm", "next Fri 19:30", "Nov 23 7pm", "in 2 hours"; optional timezone at end: "Asia/Manila").', required: true, validate: (v)=>{ const d=chrono.parseDate(v); return d? true : 'Could not parse date/time. Examples: tomorrow 8pm, next Fri 19:30, Nov 23 7pm, in 2 hours, tomorrow 8pm Asia/Manila'; } },
  { key: 'timeZone', prompt: 'Enter a time zone label to display (or type `skip`).', required: false, transform: (v)=> v.toLowerCase()==='skip' ? '' : v },
  { key: 'remindOffsetMinutes', prompt: 'Enter remind offset in minutes (or type `skip`).', required: false, transform: (v)=> v.toLowerCase()==='skip' ? '' : v, validate: (v)=>{ if(!v||v.toLowerCase()==='skip') return true; return isNaN(Number(v))? 'Please enter a number of minutes, e.g., 15' : true; } },
  { key: 'mentionHere', prompt: 'Ping @here? Type `yes` or `no`.', required: true, transform: (v)=> ['yes','y','true'].includes(v.toLowerCase())? 'yes':'no' }
];

async function startWizard(inter, preset = {}) {
  const key = `${inter.guildId}:${inter.channelId}:${inter.user.id}`;
  const baseGuild = TENANT_GUILD_ID || inter.guildId;
  const baseChannel = TENANT_CHANNEL_ID || inter.channelId;
  const base = { channelId: baseChannel, guildId: baseGuild, ...(preset || {}) };
  const session = { step: 0, data: base, expiresAt: Date.now()+5*60_000 };
  sessions.set(key, session);

  // If preset.type provided, try to apply template defaults now so they appear as Current values
  if (base.type) {
    try {
      const db = getDb();
      if (db) {
        const snapT = await db
          .collection('event_templates')
          .where('lowerName', '==', String(base.type).toLowerCase())
          .limit(1)
          .get();
        if (!snapT.empty) {
          const t = snapT.docs[0].data() || {};
          if (!session.data.title && t.title) session.data.title = t.title;
          if (!session.data.description && t.description) session.data.description = t.description;
          if (!session.data.timeZone && t.timeZone) session.data.timeZone = t.timeZone;
          if ((session.data.remindOffsetMinutes===undefined || session.data.remindOffsetMinutes==='') && typeof t.remindOffsetMinutes==='number') session.data.remindOffsetMinutes = String(t.remindOffsetMinutes);
          if (!session.data.mentionHere && t.mentionHere) session.data.mentionHere = 'yes';
        }
      }
    } catch (e) {
      console.warn('[wizard] preset template apply error:', e.message);
    }
  }

  sendStepPrompt(inter.channel, inter.user, key);
  inter.followUp({ content: 'Wizard started. I will ask for details in this channel.', ephemeral: true });
}

function buildNavRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wiz_back').setStyle(ButtonStyle.Secondary).setLabel('Back'),
    new ButtonBuilder().setCustomId('wiz_cancel').setStyle(ButtonStyle.Danger).setLabel('Cancel')
  );
}

async function sendStepPrompt(channel, user, key) {
  const session = sessions.get(key);
  if (!session) return;
  if (Date.now()>session.expiresAt) { sessions.delete(key); return channel.send(`<@${user.id}> Wizard expired.`); }
  const step = WIZ_STEPS[session.step];
  await channel.send({ content: `<@${user.id}> ${step.prompt}${session.data[step.key]? `\nCurrent: ${safeText(String(session.data[step.key]))}`: ''}`, components: [buildNavRow()] });
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId;
    const key = `${interaction.guildId}:${interaction.channelId}:${interaction.user.id}`;
    const session = sessions.get(key);
    if (!session) return interaction.reply({ content: 'No active wizard.', ephemeral: true });
    if (id==='wiz_cancel') {
      sessions.delete(key);
      return interaction.reply({ content: 'Wizard cancelled.', ephemeral: true });
    }
    if (id==='wiz_back') {
      session.step = Math.max(0, session.step-1);
      session.expiresAt = Date.now()+5*60_000;
      await interaction.deferUpdate();
      return sendStepPrompt(interaction.channel, interaction.user, key);
    }
  } catch (e) {
    console.warn('[wizard button] error:', e.message);
  }
});

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;
    const key = `${msg.guild.id}:${msg.channel.id}:${msg.author.id}`;
    const session = sessions.get(key);
    if (!session) return;
    const stepDef = WIZ_STEPS[session.step];
    const raw = msg.content.trim();
    // validate/transform
    if (stepDef.validate) {
      const res = stepDef.validate(raw);
      if (res!==true) {
        return msg.channel.send(`<@${msg.author.id}> ${res}`);
      }
    }
    let value = stepDef.transform ? stepDef.transform(raw) : raw;
    // Special handling for startsAt: parse natural language and set ISO, infer timezone label if present
    if (stepDef.key === 'startsAt') {
      const parsed = chrono.parseDate(raw);
      if (!parsed) {
        return msg.channel.send(`<@${msg.author.id}> Could not parse date/time. Examples: tomorrow 8pm, next Fri 19:30, Nov 23 7pm, in 2 hours, tomorrow 8pm Asia/Manila`);
      }
      value = new Date(parsed).toISOString();
      // Infer a timezone label like Region/City if user appended it
      const tzMatch = raw.match(/([A-Za-z_]+\/[A-Za-z_]+)/);
      if (tzMatch && !session.data.timeZone) {
        session.data.timeZone = tzMatch[1];
      }
    }
    session.data[stepDef.key] = value;
    // If user just set type, try to apply template defaults now
    if (stepDef.key === 'type' && value) {
      try {
        const db = getDb();
        if (db) {
          const snapT = await db
            .collection('event_templates')
            .where('lowerName', '==', String(value).toLowerCase())
            .limit(1)
            .get();
          if (!snapT.empty) {
            const t = snapT.docs[0].data() || {};
            if (!session.data.title && t.title) session.data.title = t.title;
            if (!session.data.description && t.description) session.data.description = t.description;
            if (!session.data.timeZone && t.timeZone) session.data.timeZone = t.timeZone;
            if ((session.data.remindOffsetMinutes===undefined || session.data.remindOffsetMinutes==='') && typeof t.remindOffsetMinutes==='number') session.data.remindOffsetMinutes = String(t.remindOffsetMinutes);
            if (!session.data.mentionHere && t.mentionHere) session.data.mentionHere = 'yes';
          }
        }
      } catch (e) {
        console.warn('[wizard] inline template apply error:', e.message);
      }
    }
    session.step++;
    session.expiresAt = Date.now()+5*60_000;
    if (session.step < WIZ_STEPS.length) {
      return sendStepPrompt(msg.channel, msg.author, key);
    }
    // finalize
    const db = getDb();
    if (!db) { sessions.delete(key); return msg.channel.send('DB unavailable.'); }
    const nowIso = new Date().toISOString();
    const startsAt = session.data.startsAt;
    let remindAt = null;
    const offRaw = session.data.remindOffsetMinutes;
    const off = offRaw!=='' && offRaw!==undefined ? Number(offRaw) : (Number(process.env.REMINDER_OFFSET_MINUTES) || null);
    try { if (off!==null && !isNaN(off)) remindAt = new Date(new Date(startsAt).getTime() - off * 60_000).toISOString(); } catch {}
    let doc = {
      title: session.data.title,
      type: session.data.type || null,
      description: session.data.description || '',
      startsAt,
      endsAt: null,
      timeZone: session.data.timeZone || null,
      guildId: TENANT_GUILD_ID || session.data.guildId,
      channelId: TENANT_CHANNEL_ID || session.data.channelId,
      mentionHere: session.data.mentionHere==='yes',
      remindOffsetMinutes: (off!==null&&!isNaN(off)?off:null),
      remindAt,
      notifiedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      audience: BOT_AUDIENCE,
      isCompany: (BOT_AUDIENCE !== 'client'),
    };

    // Apply template defaults if type provided
    if (doc.type) {
      try {
        const snapT = await db
          .collection('event_templates')
          .where('lowerName', '==', String(doc.type).toLowerCase())
          .limit(1)
          .get();
        if (!snapT.empty) {
          const t = snapT.docs[0].data() || {};
          if (!doc.description) doc.description = t.description || '';
          if (!doc.timeZone) doc.timeZone = t.timeZone || null;
          if (doc.remindOffsetMinutes === null || isNaN(Number(doc.remindOffsetMinutes))) {
            if (typeof t.remindOffsetMinutes === 'number') {
              doc.remindOffsetMinutes = t.remindOffsetMinutes;
            }
          }
          if (!doc.mentionHere && t.mentionHere) doc.mentionHere = true;
          if (!doc.remindAt && doc.remindOffsetMinutes !== null && !isNaN(Number(doc.remindOffsetMinutes))) {
            const startD = new Date(String(doc.startsAt));
            doc.remindAt = new Date(startD.getTime() - Number(doc.remindOffsetMinutes) * 60_000).toISOString();
          }
        }
      } catch (e) {
        console.warn('[wizard template] apply error:', e.message);
      }
    }
    const ref = await db.collection('events').add(doc);
    sessions.delete(key);
    const descLine = doc.description ? `\n${safeText(doc.description)}` : '';
    const ts = Math.floor(new Date(startsAt).getTime() / 1000);
    await msg.channel.send(`Event created — ${safeText(doc.title)} @ <t:${ts}:f>${descLine}`);
  } catch (e) {
    console.warn('[wizard] error:', e.message);
  }
});

// Handle modal submissions
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== 'eventCreateModal') return;
    const db = getDb();
    if (!db) return interaction.reply({ content: 'DB unavailable', ephemeral: true });
    const title = interaction.fields.getTextInputValue('title');
    const startsAt = interaction.fields.getTextInputValue('startsat');
    const description = interaction.fields.getTextInputValue('description') || '';
    const timeZone = interaction.fields.getTextInputValue('timezone') || null;
    const offsetStr = interaction.fields.getTextInputValue('remindoffset') || '';
    const remindOffset = offsetStr.trim() ? Number(offsetStr.trim()) : null;
    const nowIso = new Date().toISOString();
    let remindAt = null;
    const off = (remindOffset !== null && remindOffset !== undefined) ? Number(remindOffset) : (Number(process.env.REMINDER_OFFSET_MINUTES) || null);
    try { if (off !== null && !isNaN(off)) remindAt = new Date(new Date(startsAt).getTime() - off * 60_000).toISOString(); } catch {}
    const doc = { title, description, startsAt, endsAt: null, timeZone, guildId: (TENANT_GUILD_ID || interaction.guildId), channelId: (TENANT_CHANNEL_ID || interaction.channelId), mentionHere: false, remindOffsetMinutes: (off!==null&&!isNaN(off)?off:null), remindAt, notifiedAt: null, createdAt: nowIso, updatedAt: nowIso, audience: BOT_AUDIENCE, isCompany: (BOT_AUDIENCE !== 'client') };
    const ref = await db.collection('events').add(doc);
    const descLine = description ? `\n${safeText(description)}` : '';
    return interaction.reply({ content: `Event created — ${safeText(title)} @ ${startsAt}${descLine}`, ephemeral: true });
  } catch (e) {
    console.warn('[modal] handler error:', e.message);
    try { await interaction.reply({ content: 'Failed to create event', ephemeral: true }); } catch {}
  }
});

client.login(process.env.TOKEN);

// ---- Slash commands ----
function buildCommands() {
  return [
    { name: 'event-list', description: 'List upcoming events' },
    {
      name: 'event-remind', description: 'Send a reminder now',
      options: [
        { name: 'id', type: 3, description: 'Event ID', required: true },
        { name: 'mentionhere', type: 5, description: 'Ping @here', required: false },
      ],
    },
    {
      name: 'template-delete', description: 'Delete a template by ID',
      options: [{ name: 'id', type: 3, description: 'Template ID', required: true }],
    },
    {
      name: 'set-channel', description: 'Set the default channel for this server',
      options: [ { name: 'channel', type: 7, description: 'Target text channel', required: true } ],
    },
    { name: 'get-channel', description: 'Show the default channel for this server' },
    { name: 'clear-channel', description: 'Clear the default channel for this server' },
  ];
}

async function tryRegisterCommands() {
  try {
    const guildId = process.env.GUILD_ID || TENANT_GUILD_ID;
    const commands = buildCommands();
    // Register in a configured guild (fast) and also globally (may take up to 1 hour)
    if (guildId) {
      try {
        const guild = await client.guilds.fetch(guildId);
        if (guild) {
          await guild.commands.set(commands);
          console.log(`[commands] Registered ${commands.length} commands in guild ${guildId}`);
        }
      } catch (e) { console.warn('[commands] guild register error:', e.message); }
    } else {
      console.warn('[commands] GUILD_ID not set; skipping guild-scoped registration');
    }
    if (client.application) {
      try {
        await client.application.commands.set(commands);
        console.log('[commands] Submitted global commands');
      } catch (e) { console.warn('[commands] global register error:', e.message); }
    }
  } catch (e) {
    console.warn("[commands] register error:", e.message);
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;
    const db = getDb();
    if (!db) return interaction.reply({ content: 'DB unavailable', ephemeral: true });

    // Role-based access gate (optional). Configure allowed roles via env:
    // ALLOWED_ROLE_IDS: comma-separated role IDs
    // ALLOWED_ROLE_NAMES: comma-separated role names (case-insensitive)
    try {
      const idsRaw = String(process.env.ALLOWED_ROLE_IDS || '').trim();
      const namesRaw = String(process.env.ALLOWED_ROLE_NAMES || '').trim();
      const allowIds = idsRaw ? idsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const allowNames = namesRaw ? namesRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
      const allowAdminPerm = String(process.env.ALLOW_PERMISSION_ADMIN || '').toLowerCase() === 'true';
      if (allowIds.length || allowNames.length || allowAdminPerm) {
        // Normalize member role IDs and names regardless of structure
        let memberRoleIds = [];
        let memberRoleNames = [];
        const mr = interaction.member?.roles;
        if (mr && typeof mr.cache === 'object') {
          // GuildMemberRoleManager
          memberRoleIds = Array.from(mr.cache.keys());
          memberRoleNames = Array.from(mr.cache.values()).map(r => String(r.name || '').toLowerCase());
        } else if (Array.isArray(mr)) {
          // APIGuildMember roles: string[] of role IDs
          memberRoleIds = mr.map(id => String(id));
          memberRoleNames = memberRoleIds
            .map(id => interaction.guild?.roles?.cache?.get(id))
            .filter(Boolean)
            .map(r => String(r.name || '').toLowerCase());
        }

        const permittedById = allowIds.length ? memberRoleIds.some(id => allowIds.includes(id)) : false;
        const permittedByName = allowNames.length ? memberRoleNames.some(n => allowNames.includes(n)) : false;
        let permittedByPerms = false;
        try {
          const perms = interaction.memberPermissions || interaction.member?.permissions;
          if (allowAdminPerm && perms && typeof perms.has === 'function') {
            permittedByPerms = perms.has(PermissionsBitField.Flags.Administrator);
          }
        } catch {}
        const permitted = permittedByPerms || permittedById || permittedByName;

        if (String(process.env.LOG_ROLE_GATE || '').toLowerCase() === 'true') {
          try {
            const roleNamesDbg = memberRoleNames.join(', ') || 'none';
            console.log(`[role-gate] user=${interaction.user.id} guild=${interaction.guildId} roleIds=[${memberRoleIds.join(',')}] roleNames=[${roleNamesDbg}] allowIds=[${allowIds.join(',')}] allowNames=[${allowNames.join(',')}] allowAdminPerm=${allowAdminPerm} permitted=${permitted}`);
          } catch {}
        }
        if (!permitted) {
          return interaction.reply({ content: 'You do not have permission to use this bot.', ephemeral: true });
        }
      }
    } catch {}

    if (name === 'event-list') {
      const now = new Date();
      const to = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      let col = db.collection('events');
      if (TENANT_GUILD_ID) col = col.where('guildId', '==', TENANT_GUILD_ID);
      // Clients should not see company/internal events
      if (BOT_AUDIENCE === 'client') {
        col = col.where('isCompany', '==', false);
      }
      const snap = await col
        .where('startsAt', '>=', now.toISOString())
        .where('startsAt', '<=', to.toISOString())
        .orderBy('startsAt', 'asc')
        .limit(10)
        .get();
      if (snap.empty) return interaction.reply({ content: 'No upcoming events', ephemeral: true });
      const lines = [];
      snap.forEach((d) => {
        const e = d.data();
        const start = e.startsAt ? new Date(e.startsAt) : null;
        const ts = start ? Math.floor(start.getTime() / 1000) : null;
        lines.push(`• ${safeText(e.title)} @ ${ts?`<t:${ts}:f>`:'unknown time'}`);
      });
      return interaction.reply({ content: lines.join('\n'), ephemeral: true, allowedMentions: { parse: [] } });
    }

    if (name === 'event-remind') {
      const id = interaction.options.getString('id', true);
      const mentionHere = interaction.options.getBoolean('mentionhere') || false;
      const ref = await db.collection('events').doc(id).get();
      if (!ref.exists) return interaction.reply({ content: 'Event not found', ephemeral: true });
      const ev = ref.data() || {};
      if (TENANT_GUILD_ID && ev.guildId && ev.guildId !== TENANT_GUILD_ID) return interaction.reply({ content: 'Forbidden', ephemeral: true });
      const start = ev.startsAt ? new Date(ev.startsAt) : null;
      const ts = start ? Math.floor(start.getTime() / 1000) : null;
      const prefix = (mentionHere || ev.mentionHere || String(process.env.MENTION_HERE).toLowerCase()==='true') ? '@here ' : '';
      const descLine = ev.description ? `\n${safeText(ev.description)}` : '';
      await sendPlainToDiscord(`${prefix}Reminder: **${safeText(ev.title || 'Event')}** at ${ts?`<t:${ts}:f>`:'unknown time'}${descLine}`, TENANT_CHANNEL_ID || ev.channelId || interaction.channelId);
      await db.collection('events').doc(id).set({ notifiedAt: new Date().toISOString() }, { merge: true });
      return interaction.reply({ content: 'Reminder sent', ephemeral: true });
    }

    

    if (name === 'template-delete') {
      const id = interaction.options.getString('id', true);
      await db.collection('event_templates').doc(id).delete();
      return interaction.reply({ content: `Template deleted`, ephemeral: true });
    }

    if (name === 'set-channel') {
      const ch = interaction.options.getChannel('channel', true);
      if (!ch || !('send' in ch)) return interaction.reply({ content: 'Please select a text channel.', ephemeral: true });
      await db.collection('guild_settings').doc(interaction.guildId).set({ defaultChannelId: ch.id, updatedAt: new Date().toISOString() }, { merge: true });
      return interaction.reply({ content: `Default channel set to <#${ch.id}>`, ephemeral: true, allowedMentions: { parse: [] } });
    }
    if (name === 'get-channel') {
      const doc = await db.collection('guild_settings').doc(interaction.guildId).get();
      const id = doc.exists ? (doc.data().defaultChannelId || null) : null;
      return interaction.reply({ content: id ? `Default channel: <#${id}>` : 'No default channel set.', ephemeral: true, allowedMentions: { parse: [] } });
    }
    if (name === 'clear-channel') {
      await db.collection('guild_settings').doc(interaction.guildId).set({ defaultChannelId: null, updatedAt: new Date().toISOString() }, { merge: true });
      return interaction.reply({ content: 'Default channel cleared.', ephemeral: true });
    }
  } catch (e) {
    console.warn('[commands] handler error:', e.message);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'Command failed', ephemeral: true }); } catch {}
    }
  }
});

client.once("ready", () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  tryStartReminderPoller();
  tryRegisterCommands();
  try {
    const idsRaw = String(process.env.ALLOWED_ROLE_IDS || '').trim();
    const namesRaw = String(process.env.ALLOWED_ROLE_NAMES || '').trim();
    const allowIds = idsRaw ? idsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const allowNames = namesRaw ? namesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    console.log(`[startup] role gate allowIds=[${allowIds.join(',')}] allowNames=[${allowNames.join(',')}]`);
  } catch {}
});

// Ensure commands are updated immediately when the bot joins a new server
client.on('guildCreate', async (guild) => {
  try {
    const commands = buildCommands();
    await guild.commands.set(commands);
    console.log(`[commands] Registered ${commands.length} commands in new guild ${guild.id}`);
  } catch (e) {
    console.warn('[commands] guildCreate register error:', e.message);
  }
});

async function sendFormDataToDiscord(data, channelOverride) {
  try {
    const targetId = channelOverride || process.env.TARGET_CHANNEL;
    if (!targetId) throw new Error("TARGET_CHANNEL is not set and no override provided");

    const channel = await client.channels.fetch(targetId);
    if (!channel || !channel.isTextBased()) throw new Error("Target channel not found or not text-based");

    const message = formatFormMessage(data);

    // Split message into chunks (<=2000 chars) while keeping question/answer pairs together
    const MAX = 2000;
    const lines = message.split("\n");

    // Build logical blocks: pair '**Title:**' with next '-# answer' line when present
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("**") && i + 1 < lines.length && lines[i + 1].startsWith("-# ")) {
        blocks.push(line + "\n" + lines[i + 1]);
        i++;
      } else {
        blocks.push(line);
      }
    }

    const chunks = [];
    let buf = "";
    for (const block of blocks) {
      const addition = (buf ? "\n" : "") + block;
      if ((buf + addition).length > MAX) {
        if (buf) {
          chunks.push(buf);
          buf = "";
        }
        if (block.length > MAX) {
          // As a last resort, hard-split very long single block (rare)
          let start = 0;
          while (start < block.length) {
            chunks.push(block.slice(start, start + MAX));
            start += MAX;
          }
        } else {
          buf = block;
        }
      } else {
        buf = buf + addition;
      }
    }
    if (buf) chunks.push(buf);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        // Add a small continuation marker before subsequent chunks
        await channel.send({ content: "(cont.)", allowedMentions: { parse: [] } });
      }
      await channel.send({ content: safeText(chunks[i]), allowedMentions: { parse: [] } });
    }
    console.log(`Form submission forwarded to Discord in ${chunks.length} message(s) to ${channel.id}`);
  } catch (err) {
    console.error("Failed to send form data to Discord:", err.message);
    throw err;
  }
}

async function sendPlainToDiscord(content, channelId) {
  const target = channelId || process.env.TARGET_CHANNEL;
  if (!target) throw new Error("TARGET_CHANNEL is not set");
  const channel = await client.channels.fetch(target);
  if (!channel || !channel.isTextBased()) throw new Error("Target channel not found or not text-based");
  let msg = String(content ?? "");
  if (msg.startsWith('@here ') || msg.startsWith('@everyone ')) {
    const firstSpace = msg.indexOf(' ');
    const prefix = msg.slice(0, firstSpace); // '@here' or '@everyone'
    const rest = msg.slice(firstSpace + 1);
    // 1) send only the prefix to produce a single ping
    await channel.send({ content: prefix, allowedMentions: { parse: ['everyone'] } });
    // 2) send the remainder sanitized with mentions disabled
    if (rest && rest.trim().length) {
      await channel.send({ content: safeText(rest), allowedMentions: { parse: [] } });
    }
  } else {
    await channel.send({ content: safeText(msg), allowedMentions: { parse: [] } });
  }
}

module.exports = { sendFormDataToDiscord, sendPlainToDiscord };

// Start Express server and inject the sender
try {
  const { createServer } = require("./server");
  createServer(sendFormDataToDiscord, sendPlainToDiscord);
} catch (e) {
  console.error("Failed to start server:", e.message);
}

// ---- Simple reminder poller ----
function tryStartReminderPoller() {
  const db = getDb();
  if (!db) {
    console.warn("[reminder] Firestore not configured; reminder poller disabled");
    return;
  }

  const offsetMin = Number(process.env.REMINDER_OFFSET_MINUTES) || 15; // minutes before start
  const pollMs = Number(process.env.REMINDER_POLL_MS) || 60_000; // 60s

  setInterval(async () => {
    try {
      const now = new Date();
      const windowEnd = new Date(now.getTime() + pollMs + 5_000);
      const tasks = [];

      // 1) Prefer explicit remindAt window
      const remindIsoA = now.toISOString();
      const remindIsoB = windowEnd.toISOString();
      let colA = db.collection("events");
      if (TENANT_GUILD_ID) colA = colA.where('guildId', '==', TENANT_GUILD_ID);
      let snap = await colA
        .where("remindAt", ">=", remindIsoA)
        .where("remindAt", "<=", remindIsoB)
        .where("notifiedAt", "==", null)
        .limit(50)
        .get()
        .catch(async () => {
          // Fallback: without notifiedAt filter
          let colAFallback = db.collection("events");
          if (TENANT_GUILD_ID) colAFallback = colAFallback.where('guildId', '==', TENANT_GUILD_ID);
          return await colAFallback
            .where("remindAt", ">=", remindIsoA)
            .where("remindAt", "<=", remindIsoB)
            .limit(50)
            .get();
        });

      if (snap.empty) {
        // 2) Fallback: env-offset based window using startsAt
        const targetStart = new Date(now.getTime() + offsetMin * 60_000);
        const startIsoA = targetStart.toISOString();
        const startIsoB = new Date(targetStart.getTime() + pollMs + 5_000).toISOString();
        let colB = db.collection("events");
        if (TENANT_GUILD_ID) colB = colB.where('guildId', '==', TENANT_GUILD_ID);
        snap = await colB
          .where("startsAt", ">=", startIsoA)
          .where("startsAt", "<=", startIsoB)
          .where("notifiedAt", "==", null)
          .limit(50)
          .get()
          .catch(async () => {
            let colBFallback = db.collection("events");
            if (TENANT_GUILD_ID) colBFallback = colBFallback.where('guildId', '==', TENANT_GUILD_ID);
            return await colBFallback
              .where("startsAt", ">=", startIsoA)
              .where("startsAt", "<=", startIsoB)
              .limit(50)
              .get();
          });
      }

      if (!snap.empty) {
        snap.forEach((doc) => {
          const ev = doc.data() || {};
          tasks.push(handleReminder(doc.id, ev));
        });
      }
      if (tasks.length) await Promise.allSettled(tasks);
    } catch (err) {
      console.warn("[reminder] poll error:", err.message);
    }
  }, pollMs);
}

async function handleReminder(id, ev) {
  try {
    const db = getDb();
    if (!db) return;
    const start = ev.startsAt ? new Date(ev.startsAt) : null;
    const ts = start ? Math.floor(start.getTime() / 1000) : null;
    const title = ev.title || "Event";
    const prefix = (ev.mentionHere || String(process.env.MENTION_HERE).toLowerCase()==='true') ? '@here ' : '';
    const descLine = ev.description ? `\n${safeText(ev.description)}` : '';
    const content = `${prefix}Reminder: **${safeText(title)}** at ${ts?`<t:${ts}:f>`:'unknown time'}${descLine}`;
    let targetChannel = ev.channelId || null;
    if (!targetChannel && ev.guildId) {
      try {
        const gs = await db.collection('guild_settings').doc(ev.guildId).get();
        targetChannel = gs.exists ? (gs.data().defaultChannelId || null) : null;
      } catch {}
    }
    await sendPlainToDiscord(content, TENANT_CHANNEL_ID || targetChannel || process.env.TARGET_CHANNEL);

    await db.collection("events").doc(id).set({ notifiedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    console.warn("[reminder] failed to notify for event", id, err.message);
  }
}

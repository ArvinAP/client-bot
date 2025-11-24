require("dotenv").config();
const express = require("express");
const { getDb } = require("../../packages/firebase");
const TENANT_GUILD_ID = process.env.TENANT_GUILD_ID || null;
const TENANT_CHANNEL_ID = process.env.TENANT_CHANNEL_ID || null;

/**
 * Creates and starts the Express server.
 * @param {(data: object) => Promise<void>} sendFormDataToDiscord
 * @param {(content: string, channelId?: string) => Promise<void>} sendPlainToDiscord
 */
function createServer(sendFormDataToDiscord, sendPlainToDiscord) {
  const app = express();
  app.use(express.json());
  // Global CORS middleware for browser requests (handles preflight)
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // Remind now for a specific event
  app.post("/events/:id/remind", async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return res.status(204).end();

      const db = getDb();
      if (!db) return res.status(404).json({ error: "Not found" });
      const ref = await db.collection("events").doc(req.params.id).get();
      if (!ref.exists) return res.status(404).json({ error: "Not found" });
      const ev = ref.data() || {};
      if (TENANT_GUILD_ID && ev.guildId && ev.guildId !== TENANT_GUILD_ID) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const start = ev.startsAt ? new Date(ev.startsAt) : null;
      const ts = start ? Math.floor(start.getTime() / 1000) : null;
      const title = ev.title || "Event";
      const channelId = TENANT_CHANNEL_ID || req.body?.channelId || ev.channelId || null;
      const withHere = (req.body?.mentionHere === true) || !!ev.mentionHere || String(process.env.MENTION_HERE).toLowerCase() === 'true';
      const prefix = withHere ? '@here ' : '';
      const descLine = ev.description ? `\n${ev.description}` : '';
      await sendPlainToDiscord(`${prefix}Reminder: **${title}** at ${ts?`<t:${ts}:f>`:'unknown time'}${descLine}`, channelId);
      await db.collection("events").doc(req.params.id).set({ notifiedAt: new Date().toISOString() }, { merge: true });

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("POST /events/:id/remind error:", err.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/webhook/form", async (req, res) => {
    try {
      const body = req.body || {};

      // Accept any payload and forward; no required fields enforced

      // Store submission in Firestore if configured
      try {
        const db = getDb();
        if (db) {
          const doc = {
            receivedAt: new Date().toISOString(),
            data: body,
            guildId: TENANT_GUILD_ID || null,
          };
          await db.collection("submissions").add(doc);
        }
      } catch (fbErr) {
        console.warn("[firebase] Failed to store submission:", fbErr.message);
      }

      // Determine target channel (tenant enforced first)
      let targetChannel = null;
      const q = req.query || {};
      const channelFromReq = q.channelId || body.channelId || null;
      const guildFromReq = q.guildId || body.guildId || null;
      if (TENANT_CHANNEL_ID) {
        targetChannel = String(TENANT_CHANNEL_ID);
      } else if (channelFromReq) {
        targetChannel = String(channelFromReq);
      } else if (guildFromReq) {
        try {
          const db = getDb();
          if (db) {
            const resolvedGuild = TENANT_GUILD_ID || String(guildFromReq);
            const gs = await db.collection('guild_settings').doc(String(resolvedGuild)).get();
            if (gs.exists && gs.data().defaultChannelId) targetChannel = gs.data().defaultChannelId;
          }
        } catch {}
      }

      await sendFormDataToDiscord(body, targetChannel || undefined);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("/webhook/form error:", err.message);
      return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
  });

  // Lightweight CORS for the submissions listing (dashboard fetch)
  app.get("/submissions", async (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") return res.status(204).end();

      const db = getDb();
      if (!db) return res.status(200).json({ items: [] });

      let col = db.collection("submissions");
      if (TENANT_GUILD_ID) col = col.where('guildId', '==', TENANT_GUILD_ID);
      const snap = await col.orderBy("receivedAt", "desc").limit(50).get();

      const items = [];
      snap.forEach((doc) => {
        const data = doc.data() || {};
        const receivedAt = data.receivedAt || null;
        const email = data.data?.Email || data.data?.["Email address"] || "Unknown";
        const title = `Submission - ${email}`;
        items.push({ id: doc.id, receivedAt, title, data: data.data || {} });
      });

      return res.status(200).json({ items });
    } catch (err) {
      console.error("/submissions error:", err.message);
      return res.status(500).json({ items: [], error: "Internal Server Error" });
    }
  });

  // ------ Events CRUD (no RSVP) ------
  function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  // Create event
  app.post("/events", async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return res.status(204).end();

      const { title, startsAt, description, endsAt, timeZone, guildId, channelId, remindOffsetMinutes, mentionHere, type } = req.body || {};
      if (!title || !startsAt) {
        return res.status(400).json({ error: "title and startsAt are required" });
      }

      const db = getDb();
      if (!db) return res.status(500).json({ error: "Firestore not configured" });

      const nowIso = new Date().toISOString();
      // compute remindAt if provided, else fallback to env default
      let remindAt = null;
      const offsetMin = (remindOffsetMinutes !== undefined && remindOffsetMinutes !== null)
        ? Number(remindOffsetMinutes)
        : (Number(process.env.REMINDER_OFFSET_MINUTES) || null);
      try {
        if (!isNaN(offsetMin) && offsetMin !== null) {
          const startD = new Date(String(startsAt));
          remindAt = new Date(startD.getTime() - offsetMin * 60_000).toISOString();
        }
      } catch (_) {}

      // Base doc (will be updated with template defaults if applicable)
      const doc = {
        title: String(title),
        description: description ? String(description) : "",
        type: type ? String(type) : null,
        startsAt: String(startsAt),
        endsAt: endsAt ? String(endsAt) : null,
        timeZone: timeZone ? String(timeZone) : null,
        guildId: TENANT_GUILD_ID || guildId || null,
        channelId: TENANT_CHANNEL_ID || channelId || null,
        mentionHere: !!mentionHere,
        remindOffsetMinutes: (offsetMin !== null && !isNaN(offsetMin)) ? offsetMin : null,
        remindAt,
        notifiedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      // If no explicit channelId but we have a guildId, try to default from guild_settings
      if (!doc.channelId && doc.guildId) {
        try {
          const gs = await db.collection('guild_settings').doc(String(doc.guildId)).get();
          if (gs.exists && gs.data().defaultChannelId) {
            doc.channelId = gs.data().defaultChannelId;
          }
        } catch {}
      }

      // If a type is provided, try to apply a matching template's defaults for missing fields
      if (doc.type) {
        try {
          const snapT = await db
            .collection('event_templates')
            .where('lowerName', '==', String(doc.type).toLowerCase())
            .limit(1)
            .get();
          if (!snapT.empty) {
            const t = snapT.docs[0].data() || {};
            if (!doc.title && t.title) doc.title = t.title;
            if (!doc.description) doc.description = t.description || '';
            if (!doc.timeZone) doc.timeZone = t.timeZone || null;
            if (doc.remindOffsetMinutes === null || isNaN(Number(doc.remindOffsetMinutes))) {
              if (typeof t.remindOffsetMinutes === 'number') {
                doc.remindOffsetMinutes = t.remindOffsetMinutes;
              }
            }
            if (!doc.mentionHere && t.mentionHere) doc.mentionHere = true;
            // recompute remindAt if we got a template-driven offset
            if (!doc.remindAt && doc.remindOffsetMinutes !== null && !isNaN(Number(doc.remindOffsetMinutes))) {
              const startD = new Date(String(doc.startsAt));
              doc.remindAt = new Date(startD.getTime() - Number(doc.remindOffsetMinutes) * 60_000).toISOString();
            }
          }
        } catch (e) {
          console.warn('[templates] failed to apply template defaults:', e.message);
        }
      }

      const ref = await db.collection("events").add(doc);

      // Optional announce-on-create (env or request body)
      const announce = (req.body?.announce === true) || String(process.env.ANNOUNCE_ON_CREATE).toLowerCase() === 'true';
      if (announce) {
        try {
          const when = new Date(doc.startsAt).toLocaleString();
          const tz = doc.timeZone ? ` (${doc.timeZone})` : '';
          const prefix = (doc.mentionHere || String(process.env.MENTION_HERE).toLowerCase() === 'true') ? '@here ' : '';
          const descLine = doc.description ? `\n${doc.description}` : '';
          await sendPlainToDiscord(`${prefix}Event created — ${doc.title} @ ${when}${tz}${descLine}`, doc.channelId || null);
        } catch (e) {
          console.warn('announce-on-create failed:', e.message);
        }
      }

      return res.status(201).json({ id: ref.id, ...doc });
    } catch (err) {
      console.error("POST /events error:", err.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ---------- Event Templates CRUD ----------
  // Create template
  app.post('/templates', async (req, res) => {
    try {
      setCors(res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      const db = getDb();
      if (!db) return res.status(500).json({ error: 'Firestore not configured' });
      const { name, title, description, timeZone, remindOffsetMinutes, mentionHere } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const now = new Date().toISOString();
      const doc = {
        name: String(name),
        lowerName: String(name).toLowerCase(),
        title: title ? String(title) : '',
        description: description ? String(description) : '',
        timeZone: timeZone ? String(timeZone) : null,
        remindOffsetMinutes: (remindOffsetMinutes !== undefined && remindOffsetMinutes !== null) ? Number(remindOffsetMinutes) : null,
        mentionHere: !!mentionHere,
        guildId: TENANT_GUILD_ID || null,
        createdAt: now,
        updatedAt: now,
      };
      const ref = await db.collection('event_templates').add(doc);
      return res.status(201).json({ id: ref.id, ...doc });
    } catch (err) {
      console.error('POST /templates error:', err.message);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // List templates
  app.get('/templates', async (req, res) => {
    try {
      setCors(res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      const db = getDb();
      if (!db) return res.status(200).json({ items: [] });
      let col = db.collection('event_templates');
      if (TENANT_GUILD_ID) col = col.where('guildId', '==', TENANT_GUILD_ID);
      const snap = await col.orderBy('name', 'asc').limit(200).get();
      const items = [];
      snap.forEach((d) => items.push({ id: d.id, ...(d.data() || {}) }));
      return res.status(200).json({ items });
    } catch (err) {
      console.error('GET /templates error:', err.message);
      return res.status(500).json({ items: [], error: 'Internal Server Error' });
    }
  });

  // Update template
  app.put('/templates/:id', async (req, res) => {
    try {
      setCors(res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      const db = getDb();
      if (!db) return res.status(404).json({ error: 'Not found' });
      const updates = {};
      ['name','title','description','timeZone','remindOffsetMinutes','mentionHere'].forEach((k) => {
        if (req.body && k in req.body) updates[k] = req.body[k];
      });
      if ('name' in updates) {
        updates.lowerName = String(updates.name || '').toLowerCase();
      }
      updates.updatedAt = new Date().toISOString();
      await db.collection('event_templates').doc(req.params.id).set(updates, { merge: true });
      const doc = await db.collection('event_templates').doc(req.params.id).get();
      return res.status(200).json({ id: doc.id, ...(doc.data() || {}) });
    } catch (err) {
      console.error('PUT /templates/:id error:', err.message);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Delete template
  app.delete('/templates/:id', async (req, res) => {
    try {
      setCors(res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      const db = getDb();
      if (!db) return res.status(404).json({ error: 'Not found' });
      await db.collection('event_templates').doc(req.params.id).delete();
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('DELETE /templates/:id error:', err.message);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // List events in a date range
  app.get("/events", async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return res.status(204).end();

      const db = getDb();
      if (!db) return res.status(200).json({ items: [] });

      const now = new Date();
      const from = req.query.from ? new Date(String(req.query.from)) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const to = req.query.to ? new Date(String(req.query.to)) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      // Firestore string-ordered by ISO timestamps with tenant filter
      let col = db.collection("events");
      if (TENANT_GUILD_ID) col = col.where('guildId', '==', TENANT_GUILD_ID);
      const snap = await col
        .where("startsAt", ">=", from.toISOString())
        .where("startsAt", "<=", to.toISOString())
        .orderBy("startsAt", "asc")
        .limit(200)
        .get();

      const items = [];
      snap.forEach((doc) => items.push({ id: doc.id, ...(doc.data() || {}) }));
      return res.status(200).json({ items });
    } catch (err) {
      console.error("GET /events error:", err.message);
      return res.status(500).json({ items: [], error: "Internal Server Error" });
    }
  });

  // Read one event
  app.get("/events/:id", async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return res.status(204).end();

      const db = getDb();
      if (!db) return res.status(404).json({ error: "Not found" });
      const ref = await db.collection("events").doc(req.params.id).get();
      if (!ref.exists) return res.status(404).json({ error: "Not found" });
      const data = ref.data() || {};
      if (TENANT_GUILD_ID && data.guildId && data.guildId !== TENANT_GUILD_ID) return res.status(403).json({ error: 'Forbidden' });
      return res.status(200).json({ id: ref.id, ...data });
    } catch (err) {
      console.error("GET /events/:id error:", err.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Update event
  app.put("/events/:id", async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return res.status(204).end();

      const db = getDb();
      if (!db) return res.status(404).json({ error: "Not found" });

      const updates = {};
      ["title", "description", "type", "startsAt", "endsAt", "timeZone", "guildId", "channelId", "remindOffsetMinutes", "mentionHere"].forEach((k) => {
        if (req.body && k in req.body) updates[k] = req.body[k];
      });
      updates.updatedAt = new Date().toISOString();

      // enforce tenant guild/channel if configured
      if (TENANT_GUILD_ID) updates.guildId = TENANT_GUILD_ID;
      if (TENANT_CHANNEL_ID) updates.channelId = TENANT_CHANNEL_ID;

      // recompute remindAt if startsAt or remindOffsetMinutes are provided
      if ("startsAt" in updates || "remindOffsetMinutes" in updates) {
        try {
          const doc = await db.collection("events").doc(req.params.id).get();
          const cur = doc.exists ? (doc.data() || {}) : {};
          if (TENANT_GUILD_ID && cur.guildId && cur.guildId !== TENANT_GUILD_ID) {
            return res.status(403).json({ error: 'Forbidden' });
          }
          const startsAt = (
            ("startsAt" in updates ? updates.startsAt : cur.startsAt)
          );
          const offsetMinRaw = ("remindOffsetMinutes" in updates ? updates.remindOffsetMinutes : cur.remindOffsetMinutes);
          const offsetMin = (offsetMinRaw !== undefined && offsetMinRaw !== null) ? Number(offsetMinRaw) : (Number(process.env.REMINDER_OFFSET_MINUTES) || null);
          let remindAt = null;
          if (startsAt && offsetMin !== null && !isNaN(offsetMin)) {
            const startD = new Date(String(startsAt));
            remindAt = new Date(startD.getTime() - offsetMin * 60_000).toISOString();
          }
          updates.remindOffsetMinutes = (offsetMin !== null && !isNaN(offsetMin)) ? offsetMin : null;
          updates.remindAt = remindAt;
          // reset notification if timing changed
          updates.notifiedAt = null;
        } catch (_) {}
      }

      await db.collection("events").doc(req.params.id).set(updates, { merge: true });
      const ref = await db.collection("events").doc(req.params.id).get();
      return res.status(200).json({ id: ref.id, ...(ref.data() || {}) });
    } catch (err) {
      console.error("PUT /events/:id error:", err.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Delete event
  app.delete("/events/:id", async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return res.status(204).end();

      const db = getDb();
      if (!db) return res.status(404).json({ error: "Not found" });
      const ref = await db.collection("events").doc(req.params.id).get();
      if (!ref.exists) return res.status(404).json({ error: 'Not found' });
      const data = ref.data() || {};
      if (TENANT_GUILD_ID && data.guildId && data.guildId !== TENANT_GUILD_ID) return res.status(403).json({ error: 'Forbidden' });
      await db.collection("events").doc(req.params.id).delete();
      return res.status(204).end();
    } catch (err) {
      console.error("DELETE /events/:id error:", err.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Optional health endpoint for readiness checks
  app.get("/health", (req, res) => {
    res.status(200).json({ ok: true });
  });

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Express listening on port ${port}`);
  });

  return app;
}

module.exports = { createServer };

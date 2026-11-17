// taskscapture.js - AutoTasks CRM captures (extension 1.4+).
//
// WHAT THIS IS
//   AutoTasks only knows one CRM. A tester on another CRM signs in to the extension, opens four pages in their
//   CRM (task list, a customer, the text window, the email window) and taps Capture on each. The extension
//   (capture.js) sends a MAP of the page here: tags, ids, classes, data- attributes, button and field labels,
//   frames and address patterns. That is what we need to write the adapter for their CRM.
//
// WHAT IT IS NOT
//   Not customer data. The extension masks names, numbers, emails, notes and messages into x's and 9's inside
//   the page before sending. This file never logs a capture's contents, only who sent it and how big it was.
//
// ROUTES
//   POST /api/tasks/capture                 the extension sends one capture (Bearer AutoTasks token, or install id)
//   GET  /api/tasks/captures?secret=        list (newest first; ?crm= and ?email= filter)      ADMIN_SECRET
//   GET  /api/tasks/captures/:id?secret=    one capture as a .json download                    ADMIN_SECRET
//   POST /api/tasks/captures/:id/done?secret=   mark it handled                                ADMIN_SECRET
//
// TABLE  autotasks_captures (created on first use)

const express = require('express');
const crypto = require('crypto');

const INSTALL_RE = /^at_[a-f0-9]{32}$/;
const KINDS = ['tasks', 'customer', 'text', 'email', 'other'];
const MAX_BYTES = 3 * 1024 * 1024;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = function createTasksCapture({ pool, verifyToken, notify, adminSecret }) {
  const router = express.Router();

  let schemaReady = null;
  function initSchema() {
    if (!pool) return Promise.reject(new Error('no database'));
    schemaReady ||= pool.query(`
      CREATE TABLE IF NOT EXISTS autotasks_captures (
        id SERIAL PRIMARY KEY,
        email TEXT,
        install TEXT,
        crm TEXT,
        host TEXT,
        kind TEXT,
        note TEXT,
        ext_version TEXT,
        bytes INTEGER,
        payload JSONB NOT NULL,
        handled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS autotasks_captures_crm_idx ON autotasks_captures (LOWER(crm), created_at DESC);`)
      .catch((e) => { schemaReady = null; throw e; });
    return schemaReady;
  }

  router.use('/api/tasks/capture', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const hits = new Map(); // sender -> [times]: a tester sends a handful, never hundreds
  function tooMany(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 3600000);
    if (list.length >= 40) return true;
    hits.set(key, list.concat(now));
    return false;
  }

  router.post('/api/tasks/capture', express.json({ limit: MAX_BYTES }), async (req, res) => {
    const b = req.body || {};
    if (b.app !== 'autotasks' || !Array.isArray(b.pages) || !b.pages.length) {
      return res.status(400).json({ success: false, error: 'That is not an AutoTasks capture.' });
    }
    // Who sent it: a signed-in tester (their AutoTasks token; a tester does not need a paid account to send a
    // capture, only a real sign-in), or at least a real install id.
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    let email = '';
    if (token) {
      const v = verifyToken ? verifyToken(token) : { valid: false };
      if (!v.valid) return res.status(401).json({ success: false, error: 'Your sign-in expired. Sign in again, then tap Capture.' });
      email = String(v.session.email || '').toLowerCase();
    } else if (!INSTALL_RE.test(String(b.install || ''))) {
      return res.status(401).json({ success: false, error: 'Sign in to AutoTasks first, then tap Capture.' });
    }
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (tooMany(email || b.install || ip)) return res.status(429).json({ success: false, error: 'That is a lot of captures. Try again in an hour.' });

    const kind = KINDS.includes(b.kind) ? b.kind : 'other';
    const crm = clean(b.crm, 80);
    const host = clean(b.host, 200).toLowerCase();
    const note = clean(b.note, 1000);
    const version = clean(b.version, 20);
    const payload = { ...b, email: undefined }; // the row has the verified email; never trust the one in the body
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    try {
      await initSchema();
      const r = await pool.query(
        `INSERT INTO autotasks_captures (email, install, crm, host, kind, note, ext_version, bytes, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [email || null, clean(b.install, 40) || null, crm, host, kind, note, version, bytes, JSON.stringify(payload)]);
      const id = r.rows[0].id;
      console.log(`[taskscapture] #${id} ${kind} page of "${crm}" (${host}) from ${email || 'install ' + clean(b.install, 12)}, ${Math.round(bytes / 1024)} KB`);
      if (email && notify && notify.captureLead) {
        notify.captureLead({ email, source: 'autotasks', notes: `CRM capture #${id}: ${crm || host}, ${kind} page. /api/tasks/captures/${id}` })
          .catch((e) => console.error('[taskscapture] alert failed:', e.message));
      }
      return res.json({ success: true, id });
    } catch (e) {
      console.error('[taskscapture] save failed:', e.message);
      return res.status(503).json({ success: false, error: "AutoTasks couldn't save it right now. Use Save file and email it to us." });
    }
  });

  // ---- owner only
  function admin(req, res, next) {
    const given = req.query.secret || req.get('x-admin-secret') || '';
    if (!adminSecret || !safeEqual(given, adminSecret)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  router.get('/api/tasks/captures', admin, async (req, res) => {
    try {
      await initSchema();
      const where = [];
      const args = [];
      if (req.query.crm) { args.push(`%${String(req.query.crm).toLowerCase()}%`); where.push(`(LOWER(crm) LIKE $${args.length} OR host LIKE $${args.length})`); }
      if (req.query.email) { args.push(String(req.query.email).toLowerCase()); where.push(`email = $${args.length}`); }
      const r = await pool.query(
        `SELECT id, created_at, email, crm, host, kind, note, ext_version, bytes, handled_at FROM autotasks_captures
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`, args);
      // one line per CRM on top: which pages we have so far
      const byCrm = {};
      for (const row of r.rows) {
        const k = (row.crm || row.host || '?').toLowerCase();
        byCrm[k] ||= { crm: row.crm || row.host, hosts: new Set(), testers: new Set(), pages: new Set(), captures: 0 };
        byCrm[k].hosts.add(row.host); byCrm[k].pages.add(row.kind); byCrm[k].captures++;
        if (row.email) byCrm[k].testers.add(row.email);
      }
      res.json({
        crms: Object.values(byCrm).map((c) => ({ crm: c.crm, captures: c.captures, pages: [...c.pages], missing: KINDS.slice(0, 4).filter((k) => !c.pages.has(k)), hosts: [...c.hosts], testers: [...c.testers] })),
        captures: r.rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/tasks/captures/:id', admin, async (req, res) => {
    try {
      await initSchema();
      const r = await pool.query('SELECT * FROM autotasks_captures WHERE id = $1', [Number(req.params.id) || 0]);
      if (!r.rows.length) return res.status(404).json({ error: 'No such capture' });
      const row = r.rows[0];
      const slug = String(row.crm || row.host || 'crm').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      res.set('Content-Disposition', `attachment; filename="capture-${row.id}-${slug}-${row.kind}.json"`);
      res.json({ id: row.id, created_at: row.created_at, email: row.email, ...row.payload });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/tasks/captures/:id/done', admin, async (req, res) => {
    try {
      await initSchema();
      const r = await pool.query('UPDATE autotasks_captures SET handled_at = NOW() WHERE id = $1 RETURNING id', [Number(req.params.id) || 0]);
      res.json({ success: !!r.rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { router };
};

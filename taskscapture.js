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
//   POST /api/tasks/diagnostic              the extension's "Run diagnostic": all steps, events and screenshots at once
//   GET  /api/tasks/diagnostics?secret=                 list, with readiness (can we code this CRM from it?)
//   GET  /api/tasks/diagnostics/:id/report?secret=      the paste-able text report + the readiness checklist
//   GET  /api/tasks/diagnostics/:id/view?secret=        the same report with the screenshots, in a browser
//   GET  /api/tasks/diagnostics/:id/bundle?secret=      the full JSON (screenshots included), for replay tools
//   GET  /api/tasks/diagnostics/:id/shot/:n.jpg?secret= one screenshot
//   POST /api/tasks/capture                 (older) the extension sends one capture (Bearer AutoTasks token, or install id)
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

  let diagReady = null;
  function initDiag() {
    if (!pool) return Promise.reject(new Error('no database'));
    diagReady ||= pool.query(`
      CREATE TABLE IF NOT EXISTS autotasks_diagnostics (
        id SERIAL PRIMARY KEY,
        email TEXT, install TEXT, crm TEXT, host TEXT, note TEXT, ext_version TEXT,
        steps INTEGER, bytes INTEGER, ready BOOLEAN, gaps INTEGER,
        payload JSONB NOT NULL,
        shots JSONB,
        handled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`).catch((e) => { diagReady = null; throw e; });
    return diagReady;
  }
  let reportLib = null;
  const lib = async () => (reportLib ||= await import('./diagreport.mjs'));

  router.use(['/api/tasks/capture', '/api/tasks/diagnostic'], (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const hits = new Map(); // sender -> [times]: a tester sends a handful, never hundreds
  function tooMany(key, max = 40) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 3600000);
    if (list.length >= max) return true;
    hits.set(key, list.concat(now));
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
    return false;
  }
  // SECURITY (2.2): a made-up install id is not a sender. Uploads are big (a diagnostic can be 25 MB) and land in the
  // same Neon database AutoPost runs on, so only a real AutoTasks sign-in may send them, braked per person AND per
  // network address (the last x-forwarded-for entry, which Railway's edge adds; earlier ones are the caller's).
  // TASKS_AUTH_REQUIRED=0 lets the old install ids through again, like the AI relay.
  const AUTH_REQUIRED = !/^(0|false|no|off)$/i.test(String(process.env.TASKS_AUTH_REQUIRED || '').trim());
  const ipOf = (req) => {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    return fwd[fwd.length - 1] || String(req.ip || '');
  };

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
    } else if (AUTH_REQUIRED || !INSTALL_RE.test(String(b.install || ''))) {
      return res.status(401).json({ success: false, error: 'Sign in to AutoTasks first, then tap Capture.' });
    }
    const ip = ipOf(req);
    if (tooMany(email || b.install || ip, 20) || tooMany('ip:' + ip, 30)) return res.status(429).json({ success: false, error: 'That is a lot of captures. Try again in an hour.' });

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

  router.post('/api/tasks/diagnostic', express.json({ limit: '25mb' }), async (req, res) => {
    const b = req.body || {};
    if (b.app !== 'autotasks' || b.kind !== 'diagnostic' || !Array.isArray(b.steps) || !b.steps.length) {
      return res.status(400).json({ success: false, error: 'That is not an AutoTasks diagnostic.' });
    }
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    let email = '';
    if (token) {
      const v = verifyToken ? verifyToken(token) : { valid: false };
      if (!v.valid) return res.status(401).json({ success: false, error: 'Your sign-in expired. Sign in again, then press Submit.' });
      email = String(v.session.email || '').toLowerCase();
    } else if (AUTH_REQUIRED || !INSTALL_RE.test(String(b.install || ''))) {
      return res.status(401).json({ success: false, error: 'Sign in to AutoTasks first, then press Submit.' });
    }
    if (tooMany('diag:' + (email || b.install), 6) || tooMany('diag-ip:' + ipOf(req), 10)) return res.status(429).json({ success: false, error: 'That is a lot of diagnostics. Try again in an hour.' });
    try {
      await initDiag();
      // screenshots live in their own column so lists stay light
      const shots = [];
      const steps = b.steps.slice(0, 12).map((s, si) => ({
        ...s,
        shots: (s.shots || []).slice(0, 4).map((x) => {
          const jpg = String(x.jpg || '');
          if (jpg.length > 4e6) return { window: x.window, w: x.w, h: x.h, url: x.url, dropped: true };
          shots.push({ step: s.id, label: s.label, window: x.window, w: x.w, h: x.h, url: x.url, jpg });
          return { window: x.window, w: x.w, h: x.h, url: x.url, n: shots.length - 1 };
        }),
      }));
      const payload = { ...b, email: undefined, steps };
      const bytes = Buffer.byteLength(JSON.stringify(payload)) + shots.reduce((n, x) => n + x.jpg.length, 0);
      const a = (await lib()).analyze(payload);
      const r = await pool.query(
        `INSERT INTO autotasks_diagnostics (email, install, crm, host, note, ext_version, steps, bytes, ready, gaps, payload, shots)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [email || null, clean(b.install, 40) || null, clean(b.crm, 80), clean(b.host, 200).toLowerCase(), clean(b.note, 2000), clean(b.version, 20),
          steps.length, bytes, a.ready, a.missing.length, JSON.stringify(payload), JSON.stringify(shots)]);
      const id = r.rows[0].id;
      console.log(`[taskscapture] DIAGNOSTIC #${id} "${clean(b.crm, 80)}" (${clean(b.host, 80)}) from ${email || 'install'}: ${steps.length} steps, ${shots.length} shots, ${Math.round(bytes / 1024)} KB, ${a.ready ? 'READY' : a.missing.length + ' gaps'}`);
      if (notify && notify.captureLead) {
        notify.captureLead({ email: email || undefined, source: 'autotasks',
          notes: `CRM DIAGNOSTIC #${id}: ${clean(b.crm, 60) || clean(b.host, 60)}, ${steps.length} steps, ${a.ready ? 'READY TO CODE' : a.missing.length + ' gaps'}. /api/tasks/diagnostics/${id}/view` })
          .catch((e) => console.error('[taskscapture] alert failed:', e.message));
      }
      return res.json({ success: true, id, ready: a.ready });
    } catch (e) {
      console.error('[taskscapture] diagnostic save failed:', e.message);
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

  async function diagRow(id, withShots) {
    await initDiag();
    const r = await pool.query(`SELECT id, created_at, email, crm, host, payload${withShots ? ', shots' : ''} FROM autotasks_diagnostics WHERE id = $1`, [Number(id) || 0]);
    return r.rows[0] || null;
  }
  router.get('/api/tasks/diagnostics', admin, async (req, res) => {
    try {
      await initDiag();
      const r = await pool.query(`SELECT id, created_at, email, crm, host, ext_version, steps, bytes, ready, gaps, handled_at FROM autotasks_diagnostics ORDER BY created_at DESC LIMIT 100`);
      res.json({ diagnostics: r.rows.map((x) => ({ ...x, kb: Math.round(x.bytes / 1024), view: `/api/tasks/diagnostics/${x.id}/view` })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/api/tasks/diagnostics/:id/report', admin, async (req, res) => {
    try {
      const row = await diagRow(req.params.id, false);
      if (!row) return res.status(404).send('No such diagnostic');
      res.type('text/plain').send((await lib()).buildReport({ ...row.payload, email: row.email }));
    } catch (e) { res.status(500).send(e.message); }
  });
  router.get('/api/tasks/diagnostics/:id/bundle', admin, async (req, res) => {
    try {
      const row = await diagRow(req.params.id, true);
      if (!row) return res.status(404).json({ error: 'No such diagnostic' });
      const slug = String(row.crm || row.host || 'crm').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      res.set('Content-Disposition', `attachment; filename="diagnostic-${row.id}-${slug}.json"`);
      res.json({ id: row.id, created_at: row.created_at, ...row.payload, email: row.email, screenshots: row.shots || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/api/tasks/diagnostics/:id/shot/:n.jpg', admin, async (req, res) => {
    try {
      const row = await diagRow(req.params.id, true);
      const s = row && (row.shots || [])[Number(req.params.n)];
      if (!s) return res.status(404).send('No such screenshot');
      res.type('image/jpeg').send(Buffer.from(s.jpg, 'base64'));
    } catch (e) { res.status(500).send(e.message); }
  });
  router.get('/api/tasks/diagnostics/:id/view', admin, async (req, res) => {
    try {
      const row = await diagRow(req.params.id, true);
      if (!row) return res.status(404).send('No such diagnostic');
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const q = `secret=${encodeURIComponent(req.query.secret || '')}`;
      const imgs = (row.shots || []).map((s, i) => `<figure><img src="/api/tasks/diagnostics/${row.id}/shot/${i}.jpg?${q}" style="max-width:520px;border:1px solid #444"><figcaption>${esc(s.label)} (${esc(s.window)})</figcaption></figure>`).join('');
      const report = (await lib()).buildReport({ ...row.payload, email: row.email });
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Diagnostic #${row.id}</title><body style="font:13px system-ui;background:#111;color:#ddd;margin:20px"><h2>Diagnostic #${row.id}: ${esc(row.crm || row.host)}</h2><p><a style="color:#8cf" href="report?${q}">plain text</a> · <a style="color:#8cf" href="bundle?${q}">full JSON</a></p><div style="display:flex;flex-wrap:wrap;gap:12px">${imgs}</div><pre style="white-space:pre-wrap;font:12px ui-monospace,monospace">${esc(report)}</pre>`);
    } catch (e) { res.status(500).send(e.message); }
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

// tasksbugs.js - AutoTasks "Report a bug" (extension 2.1+, Troubleshoot > Report a bug).
//
// 2.1 shipped the button but the server never had this route, so every report failed with a 404.
//
// WHO CAN SEND: a signed-in AutoTasks user only (their AutoTasks token as Bearer). Braked per person and per
// network address, and every field is cut to size, so it can't be used to fill the database.
// WHAT IS KEPT: what they typed, which area, the extension version, the CRM's web address (host only) and, if they
//   ticked it, the diagnostic report (diag.js builds it from fixed words; no customer names, numbers or messages).
// THE OWNER HEARS ABOUT IT: one ntfy push (NTFY_TOPIC) that says only "bug #id, area". Nothing the user typed rides
//   through ntfy.
//
// ROUTES
//   POST /api/tasks/bugs                        the extension sends one report -> { success, id }
//   GET  /api/tasks/bugs/board?secret=          the owner's list (ADMIN_SECRET), newest first, open ones on top
//   POST /api/tasks/bugs/:id/done?secret=       mark one handled
//
// TABLE autotasks_bugs (created on first use)

const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const AREAS = ['drafts', 'sending', 'crm', 'voice', 'settings', 'signin', 'other']; // the extension's #bug-area options
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = function createTasksBugs({ pool, verifyToken, adminSecret }) {
  const router = express.Router();

  let ready = null;
  function initSchema() {
    if (!pool) return Promise.reject(new Error('no database'));
    ready ||= pool.query(`
      CREATE TABLE IF NOT EXISTS autotasks_bugs (
        id SERIAL PRIMARY KEY,
        email TEXT,
        ext_version TEXT,
        area TEXT,
        what TEXT,
        expected TEXT,
        report TEXT,
        crm_host TEXT,
        done BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`).catch((e) => { ready = null; throw e; });
    return ready;
  }

  const hits = new Map();
  function tooMany(key, max) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 3600000);
    if (list.length >= max) return true;
    hits.set(key, list.concat(now));
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
    return false;
  }
  const ipOf = (req) => {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    return fwd[fwd.length - 1] || String(req.ip || '');
  };
  const isAdmin = (req) => !!adminSecret && safeEqual(String(req.query.secret || req.get('x-admin-secret') || ''), adminSecret);

  router.use('/api/tasks/bugs', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  async function ping(id, area) {
    const topic = String(process.env.NTFY_TOPIC || '').trim();
    if (!topic) return;
    const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
    const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const headers = { Title: `AutoTasks bug #${id}`, Tags: 'bug' };
    if (base) headers.Click = `${base}/api/tasks/bugs/board`; // no secret in the push; the owner adds it
    await fetch(`${server}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body: `New AutoTasks bug report (${area}).` });
  }

  router.post('/api/tasks/bugs', express.json({ limit: '200kb' }), async (req, res) => {
    const b = req.body || {};
    if (b.app !== 'autotasks') return res.status(400).json({ success: false, error: 'That is not an AutoTasks report.' });
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const v = token && verifyToken ? verifyToken(token) : { valid: false };
    if (!v.valid) return res.status(401).json({ success: false, error: 'Sign in to AutoTasks first, then send it again.' });
    const email = String(v.session.email || '').toLowerCase();
    if (tooMany('u:' + email, 10) || tooMany('ip:' + ipOf(req), 20)) {
      return res.status(429).json({ success: false, error: "That's a lot of reports. Email tryautopost@gmail.com instead." });
    }
    const what = clean(b.what, 4000);
    if (what.length < 3) return res.status(400).json({ success: false, error: 'Say what happened first.' });
    const area = AREAS.includes(b.area) ? b.area : 'other';
    let host = '';
    try { host = b.crmHost ? new URL(`https://${clean(b.crmHost, 200)}`).hostname : ''; } catch { host = ''; }
    try {
      await initSchema();
      const r = await pool.query(
        `INSERT INTO autotasks_bugs (email, ext_version, area, what, expected, report, crm_host)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [email, clean(b.version, 20), area, what, clean(b.expected, 2000), clean(b.report, 60000), host]);
      const id = r.rows[0].id;
      console.log(`[tasksbugs] #${id} ${area} from ${email} (v${clean(b.version, 20)})`); // never what they typed
      ping(id, area).catch((e) => console.error('[tasksbugs] ntfy failed:', e.message));
      return res.json({ success: true, id });
    } catch (e) {
      console.error('[tasksbugs] save failed:', e.message);
      return res.status(503).json({ success: false, error: "AutoTasks couldn't save it right now. Use Email us instead." });
    }
  });

  router.get('/api/tasks/bugs/board', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    if (!isAdmin(req)) return res.status(401).type('text').send('Add ?secret= (ADMIN_SECRET).');
    try {
      await initSchema();
      const { rows } = await pool.query('SELECT * FROM autotasks_bugs ORDER BY done ASC, id DESC LIMIT 200');
      const s = encodeURIComponent(String(req.query.secret || ''));
      const cards = rows.map((r) => `
        <article class="${r.done ? 'done' : ''}">
          <header><b>#${r.id}</b> <span>${esc(r.area)}</span> <span>v${esc(r.ext_version)}</span> <span>${esc(r.email)}</span>
            <span>${esc(r.crm_host)}</span> <time>${esc(new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Denver' }))}</time>
            ${r.done ? '<em>handled</em>' : `<form method="post" action="/api/tasks/bugs/${r.id}/done?secret=${s}"><button>Mark handled</button></form>`}</header>
          <p>${esc(r.what)}</p>
          ${r.expected ? `<p class="exp"><b>Expected:</b> ${esc(r.expected)}</p>` : ''}
          ${r.report ? `<details><summary>Diagnostic report</summary><pre>${esc(r.report)}</pre></details>` : ''}
        </article>`).join('');
      res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoTasks bugs</title><style>
:root{color-scheme:dark}body{margin:0;padding:24px 16px;background:#000;color:rgba(244,239,226,.84);font:15px/1.5 system-ui,sans-serif}
h1{margin:0 0 16px;font-size:22px;color:#f4efe2}h1 i{font-style:normal;background:linear-gradient(100deg,#2fd2ee,#3b7bf5 26%,#8b5cf6 50%,#ee3f8e 74%,#f79a2b);-webkit-background-clip:text;background-clip:text;color:transparent}
article{max-width:860px;margin:0 0 12px;padding:14px 16px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.04)}
article.done{opacity:.5}header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px;color:rgba(244,239,226,.62)}
header b{color:#2fd2ee}form{margin:0 0 0 auto}button{background:#2fd2ee;color:#07090b;border:0;border-radius:999px;padding:5px 12px;font-weight:600;cursor:pointer}
em{margin-left:auto;font-style:normal;color:#8b5cf6}p{margin:8px 0 0;white-space:pre-wrap;color:#f4efe2}.exp{color:rgba(244,239,226,.62)}
pre{white-space:pre-wrap;font-size:12px;background:rgba(255,255,255,.04);padding:10px;border-radius:10px;overflow:auto}
</style><h1>AutoTasks <i>bugs</i> (${rows.filter((r) => !r.done).length} open)</h1>${cards || '<p>No reports yet.</p>'}`);
    } catch (e) {
      res.status(503).type('text').send('Database unavailable: ' + e.message);
    }
  });

  router.post('/api/tasks/bugs/:id/done', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ success: false });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false });
    try {
      await initSchema();
      await pool.query('UPDATE autotasks_bugs SET done = TRUE WHERE id = $1', [id]);
      return res.redirect(303, `/api/tasks/bugs/board?secret=${encodeURIComponent(String(req.query.secret || ''))}`);
    } catch (e) {
      return res.status(503).json({ success: false });
    }
  });

  return { router };
};

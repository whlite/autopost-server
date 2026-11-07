// tasksauth.js - AutoTasks sign-in. Its OWN Clerk application, separate from AutoPost.
//
// WHY A SECOND CLERK APP
//   AutoPost and AutoTasks are sold separately. Each has its own Clerk application, so each has its own
//   user list: an AutoPost account cannot sign in to AutoTasks and an AutoTasks account cannot sign in to
//   AutoPost. AutoPost keeps CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY; AutoTasks reads only these:
//     TASKS_CLERK_SECRET_KEY        sk_... of the AutoTasks Clerk application
//     TASKS_CLERK_PUBLISHABLE_KEY   pk_... of the AutoTasks Clerk application
//   The two session tokens can't cross either: AutoTasks tokens are signed with their own secret
//   (TASKS_SESSION_SECRET, or one derived from SESSION_SECRET) and have a different shape ("att1.body.sig"),
//   so AutoPost's /verify-session rejects them and this file rejects AutoPost's.
//
// FLOW
//   1. The side panel opens  GET /tasks/login?extensionId=<extension id>  (public/tasks-login.html, AutoPost's
//      extension-login page in AutoTasks colors, same flow: Sign In / Create Account, then Connect).
//   2. That page loads Clerk with the AutoTasks publishable key; the rep signs in or creates an account.
//   3. The page posts its Clerk session JWT to  POST /api/tasks/auth/create-token  (Authorization: Bearer).
//   4. This file verifies it with the AutoTasks secret key, and returns an AutoTasks token (30 days).
//   5. The page hands the token to the extension (chrome.runtime.sendMessage, externally_connectable).
//   6. The extension sends that token as its "API key" to the AI relay (tasksai.js), which checks it here,
//      and re-checks it on every panel open with  POST /api/tasks/auth/verify.
//
// ACCESS (same rule as AutoPost: signing in proves WHO you are, not THAT you're allowed in)
//   Every AutoTasks sign-in gets a row in Neon table  autotasks_users  (subscription_status starts 'inactive')
//   and the owner gets a signup alert (notify.js, source 'autotasks'). Only 'active' or 'trialing' unlocks
//   AutoTasks. The owner turns someone on in Neon:
//     UPDATE autotasks_users SET subscription_status = 'active', updated_at = NOW() WHERE email = 'rep@x.com';
//   Owner comps without a row edit: TASKS_ACTIVE_EMAILS (comma-separated). Blocks: TASKS_BLOCKED_EMAILS.
//   Status is re-checked on every panel open and every AI call (cached 60s), so switching someone back to
//   'inactive' cuts them off within a minute. No database = nobody gets in.
//
// ROUTES
//   GET  /tasks/login                    the sign-in page
//   GET  /api/tasks/auth/config          { configured, publishableKey }
//   POST /api/tasks/auth/create-token    Clerk session JWT -> { token, expiresInSeconds, user }
//   POST /api/tasks/auth/verify          { token } -> { valid, user }

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { verifyToken, createClerkClient } = require('@clerk/backend');

const SECRET_KEY = process.env.TASKS_CLERK_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.TASKS_CLERK_PUBLISHABLE_KEY || '';
const TTL_MS = 30 * 24 * 3600 * 1000;
const PREFIX = 'att1';
const STATUS_CACHE_MS = 60 * 1000;
const NOT_ACTIVE = "You're signed up, but we don't have a payment for this account yet. AutoTasks unlocks once you've paid. After paying, come back here and click Connect.";

function signingSecret(sessionSecret) {
  if (process.env.TASKS_SESSION_SECRET) return process.env.TASKS_SESSION_SECRET;
  // Derived, so it is never equal to AutoPost's SESSION_SECRET even when only that one is set.
  return crypto.createHmac('sha256', String(sessionSecret || 'autotasks')).update('autotasks-session-v1').digest('hex');
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
// The owner. Permanent access, always: no payment row needed, can't be blocked, not removable by any env var.
const OWNER_EMAILS = ['oldfnew@gmail.com'];
const isOwner = (email) => OWNER_EMAILS.includes(normEmail(email));
const blockedList = () => String(process.env.TASKS_BLOCKED_EMAILS || '').split(',').map(normEmail).filter(Boolean);
const isBlocked = (email) => !!email && !isOwner(email) && blockedList().includes(normEmail(email));
const compList = () => OWNER_EMAILS.concat(String(process.env.TASKS_ACTIVE_EMAILS || '').split(',').map(normEmail).filter(Boolean));
const isAllowedStatus = (st) => ['active', 'trialing'].includes(String(st || '').toLowerCase());

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = function createTasksAuth({ sessionSecret, pool, notify }) {
  const SECRET = signingSecret(sessionSecret);
  const clerk = SECRET_KEY ? createClerkClient({ secretKey: SECRET_KEY }) : null;
  const router = express.Router();

  const sign = (session) => {
    const body = Buffer.from(JSON.stringify(session)).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(`${PREFIX}.${body}`).digest('base64url');
    return `${PREFIX}.${body}.${sig}`;
  };

  // ---- Neon: who is allowed in
  let schemaReady = null;
  function initSchema() {
    if (!pool) return Promise.resolve();
    schemaReady ||= pool.query(`
      CREATE TABLE IF NOT EXISTS autotasks_users (
        id SERIAL PRIMARY KEY,
        clerk_user_id TEXT UNIQUE,
        email TEXT UNIQUE,
        name TEXT,
        subscription_status TEXT DEFAULT 'inactive',
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ
      );`)
      .then(() => pool.query(`ALTER TABLE autotasks_users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
        ALTER TABLE autotasks_users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
        ALTER TABLE autotasks_users ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;`))
      .catch((e) => { schemaReady = null; throw e; });
    return schemaReady;
  }

  // ---- Stripe: an AutoTasks payment turns the buyer on (and a cancel or failed payment turns them off).
  // Called by server.js's Stripe webhook only for AutoTasks products, so AutoPost payments never land here
  // and AutoTasks payments never switch on AutoPost. Matched by subscription id first, then by email, so it
  // works whether they pay before or after creating their AutoTasks login.
  async function applyStripe({ email, status, customerId, subscriptionId, periodEnd }) {
    if (!pool) return null;
    await initSchema();
    const em = normEmail(email);
    const st = String(status || 'inactive').toLowerCase();
    let r = { rows: [] };
    if (subscriptionId) {
      r = await pool.query(
        `UPDATE autotasks_users SET subscription_status = $2, stripe_customer_id = COALESCE($3, stripe_customer_id),
           current_period_end = COALESCE($4, current_period_end), updated_at = NOW()
         WHERE stripe_subscription_id = $1 RETURNING email`, [subscriptionId, st, customerId || null, periodEnd || null]);
    }
    if (!r.rows.length && em) {
      r = await pool.query(
        `INSERT INTO autotasks_users (email, subscription_status, stripe_customer_id, stripe_subscription_id, current_period_end)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET subscription_status = EXCLUDED.subscription_status,
           stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, autotasks_users.stripe_customer_id),
           stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, autotasks_users.stripe_subscription_id),
           current_period_end = COALESCE(EXCLUDED.current_period_end, autotasks_users.current_period_end),
           updated_at = NOW()
         RETURNING email`, [em, st, customerId || null, subscriptionId || null, periodEnd || null]);
    }
    statusCache.clear(); // the change applies on their next panel open or AI call, not a minute later
    console.log('[tasksauth] Stripe', st, 'for', (r.rows[0] && r.rows[0].email) || em || subscriptionId);
    return r.rows[0] || null;
  }

  // First sign-in creates the row (inactive) and alerts the owner. Returns { status, created }.
  async function upsertUser({ sub, email, name }) {
    await initSchema();
    const found = await pool.query(
      `UPDATE autotasks_users SET clerk_user_id = COALESCE(clerk_user_id, $1), name = COALESCE(NULLIF($3, ''), name),
         last_seen_at = NOW() WHERE clerk_user_id = $1 OR LOWER(email) = $2 RETURNING subscription_status`,
      [sub, email, name]);
    if (found.rows.length) return { status: found.rows[0].subscription_status, created: false };
    const made = await pool.query(
      `INSERT INTO autotasks_users (clerk_user_id, email, name, last_seen_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING RETURNING subscription_status`, [sub, email, name]);
    return { status: made.rows[0] ? made.rows[0].subscription_status : 'inactive', created: !!made.rows[0] };
  }

  const statusCache = new Map(); // sub -> { ok, at }
  /** Is this signed-in person allowed in right now? */
  async function allowed(session) {
    if (compList().includes(normEmail(session.email))) return true;
    if (!pool) return false;
    const hit = statusCache.get(session.sub);
    if (hit && Date.now() - hit.at < STATUS_CACHE_MS) return hit.ok;
    await initSchema();
    const r = await pool.query('SELECT subscription_status FROM autotasks_users WHERE clerk_user_id = $1 OR LOWER(email) = $2 LIMIT 1',
      [session.sub, normEmail(session.email)]);
    const ok = !!r.rows[0] && isAllowedStatus(r.rows[0].subscription_status);
    statusCache.set(session.sub, { ok, at: Date.now() });
    return ok;
  }

  /** Token AND an active account: { valid, session } or { valid: false, error, inactive? }. */
  async function check(token) {
    const v = verify(token);
    if (!v.valid) return v;
    try {
      if (!(await allowed(v.session))) return { valid: false, inactive: true, error: "No payment yet. AutoTasks unlocks once you've paid" };
    } catch (e) {
      console.error('[tasksauth] status check failed:', e.message);
      return { valid: false, error: 'Could not check your account. Try again in a minute' };
    }
    return v;
  }

  /** An AutoTasks token -> { valid, session } or { valid: false, error }. Signature and expiry only. */
  function verify(token) {
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return { valid: false, error: 'Not an AutoTasks sign-in' };
    const [, body, sig] = parts;
    const want = crypto.createHmac('sha256', SECRET).update(`${PREFIX}.${body}`).digest('base64url');
    if (!safeEqual(sig, want)) return { valid: false, error: 'Sign-in not recognized' };
    let session;
    try { session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return { valid: false, error: 'Sign-in not recognized' }; }
    if (session.app !== 'autotasks' || !session.sub) return { valid: false, error: 'Not an AutoTasks sign-in' };
    if (!session.exp || Date.now() > session.exp) return { valid: false, error: 'Sign-in expired' };
    if (isBlocked(session.email)) return { valid: false, error: 'This AutoTasks account is turned off' };
    return { valid: true, session };
  }

  router.use(['/api/tasks/auth', '/tasks/login'], (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  router.get('/api/tasks/auth/config', (req, res) => {
    res.json({ configured: !!(SECRET_KEY && PUBLISHABLE_KEY), publishableKey: PUBLISHABLE_KEY });
  });

  router.post('/api/tasks/auth/create-token', express.json({ limit: '16kb' }), async (req, res) => {
    if (!clerk || !PUBLISHABLE_KEY) return res.status(503).json({ success: false, error: 'AutoTasks sign-in is not set up on the server yet.' });
    const jwt = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return res.status(401).json({ success: false, error: 'Please sign in first.' });
    let claims;
    try {
      claims = await verifyToken(jwt, { secretKey: SECRET_KEY });
    } catch (e) {
      // An AutoPost Clerk session lands here too: it is signed by the other Clerk app.
      console.log('[tasksauth] create-token: Clerk token rejected:', e.message);
      return res.status(401).json({ success: false, error: 'Your sign-in expired. Sign in again.' });
    }
    try {
      const u = await clerk.users.getUser(claims.sub);
      const list = (u && u.emailAddresses) || [];
      const primary = list.find((e) => e.id === u.primaryEmailAddressId) || list[0];
      const email = normEmail(primary && primary.emailAddress);
      if (!email) return res.status(400).json({ success: false, error: 'Could not read your email. Sign in again.' });
      if (isBlocked(email)) return res.status(403).json({ success: false, error: 'This AutoTasks account is turned off.' });
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
      if (!pool && !compList().includes(email)) {
        return res.status(503).json({ success: false, error: 'AutoTasks accounts are unavailable. Try again in a minute.' });
      }
      if (pool) {
        const row = await upsertUser({ sub: claims.sub, email, name });
        statusCache.delete(claims.sub);
        if (row.created) {
          console.log('[tasksauth] NEW signup (inactive):', email);
          if (notify && notify.captureLead) {
            notify.captureLead({ email, name, source: 'autotasks',
              notes: `AutoTasks signup waiting. Turn on: UPDATE autotasks_users SET subscription_status='active' WHERE email='${email}';` })
              .catch((e) => console.error('[tasksauth] signup alert failed:', e.message));
          }
        }
        if (!isAllowedStatus(row.status) && !compList().includes(email)) {
          console.log('[tasksauth] DENIED (status ' + row.status + ') for', email);
          return res.status(402).json({ success: false, error: NOT_ACTIVE });
        }
      }
      const session = { app: 'autotasks', sub: claims.sub, email, name, iat: Date.now(), exp: Date.now() + TTL_MS };
      console.log('[tasksauth] signed in', email);
      return res.json({ success: true, token: sign(session), expiresInSeconds: TTL_MS / 1000, user: { email, name } });
    } catch (e) {
      console.error('[tasksauth] create-token error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error. Try again.' });
    }
  });

  router.post('/api/tasks/auth/verify', express.json({ limit: '16kb' }), async (req, res) => {
    const token = (req.body && req.body.token) || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const v = await check(token);
    if (!v.valid) return res.status(v.inactive ? 402 : 401).json({ valid: false, inactive: !!v.inactive, error: v.error });
    return res.json({ valid: true, user: { email: v.session.email, name: v.session.name || '' }, expiresAt: v.session.exp });
  });

  // The page is AutoPost's extension-login page in AutoTasks colors (public/tasks-login.html). It reads
  // ?extensionId= from its own URL, like AutoPost's.
  router.get('/tasks/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(__dirname, 'public', 'tasks-login.html'));
  });

  // AutoTasks privacy policy (the Chrome Web Store listing links here).
  router.get(['/tasks/privacy', '/tasks/privacy.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tasks-privacy.html'));
  });

  initSchema().catch((e) => console.error('[tasksauth] could not create autotasks_users:', e.message));
  return { router, verify, check, applyStripe };
};

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
// ACCESS
//   Any signed-in AutoTasks account gets in, except emails in TASKS_BLOCKED_EMAILS (comma-separated).
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

function signingSecret(sessionSecret) {
  if (process.env.TASKS_SESSION_SECRET) return process.env.TASKS_SESSION_SECRET;
  // Derived, so it is never equal to AutoPost's SESSION_SECRET even when only that one is set.
  return crypto.createHmac('sha256', String(sessionSecret || 'autotasks')).update('autotasks-session-v1').digest('hex');
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const blockedList = () => String(process.env.TASKS_BLOCKED_EMAILS || '').split(',').map(normEmail).filter(Boolean);
const isBlocked = (email) => !!email && blockedList().includes(normEmail(email));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = function createTasksAuth({ sessionSecret }) {
  const SECRET = signingSecret(sessionSecret);
  const clerk = SECRET_KEY ? createClerkClient({ secretKey: SECRET_KEY }) : null;
  const router = express.Router();

  const sign = (session) => {
    const body = Buffer.from(JSON.stringify(session)).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(`${PREFIX}.${body}`).digest('base64url');
    return `${PREFIX}.${body}.${sig}`;
  };

  /** An AutoTasks token -> { valid, session } or { valid: false, error }. */
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
      const session = { app: 'autotasks', sub: claims.sub, email, name, iat: Date.now(), exp: Date.now() + TTL_MS };
      console.log('[tasksauth] signed in', email);
      return res.json({ success: true, token: sign(session), expiresInSeconds: TTL_MS / 1000, user: { email, name } });
    } catch (e) {
      console.error('[tasksauth] create-token error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error. Try again.' });
    }
  });

  router.post('/api/tasks/auth/verify', express.json({ limit: '16kb' }), (req, res) => {
    const token = (req.body && req.body.token) || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const v = verify(token);
    if (!v.valid) return res.status(401).json({ valid: false, error: v.error });
    return res.json({ valid: true, user: { email: v.session.email, name: v.session.name || '' }, expiresAt: v.session.exp });
  });

  // The page is AutoPost's extension-login page in AutoTasks colors (public/tasks-login.html). It reads
  // ?extensionId= from its own URL, like AutoPost's.
  router.get('/tasks/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(__dirname, 'public', 'tasks-login.html'));
  });

  return { router, verify };
};

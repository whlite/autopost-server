// prospecting/index.js — AutoPost outbound prospecting engine (px_* namespace)
//
// Modular monolith: everything mounts on the existing Express app and uses the
// existing Neon pool, Clerk middleware and Stripe client. No extra services.
//
// SECURITY: every /api/px/* route requires either the operator key (owner's
// machine) or a Clerk session whose user id is on the px_admins allowlist (or
// PROSPECTING_ADMIN_USER_IDS). A hidden dashboard link is never the boundary.
//
// SAFETY: a failure anywhere in here must never stop the server from booting or
// break sign-in, checkout or posting. If the schema cannot be migrated, the px
// routes answer 503 and everything else runs normally.

const express = require('express');
const { migrate } = require('./migrate');
const { createSettings } = require('./settings');
const createApi = require('./api');

module.exports = function createProspecting(deps) {
  const pool = deps.pool;
  const getAuth = deps.getAuth;
  const clerkClient = deps.clerkClient;
  const operator = deps.operator;

  const router = express.Router();
  const settings = pool ? createSettings(pool) : null;
  let ready = false;
  let initError = null;

  const envAdmins = String(process.env.PROSPECTING_ADMIN_USER_IDS || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  const adminCache = new Map(); // clerkUserId -> { at, ok }
  async function isAdminUser(clerkUserId) {
    if (!clerkUserId) return false;
    if (envAdmins.indexOf(clerkUserId) !== -1) return true;
    const hit = adminCache.get(clerkUserId);
    if (hit && Date.now() - hit.at < 60 * 1000) return hit.ok;
    const r = await pool.query('SELECT 1 FROM px_admins WHERE clerk_user_id = $1', [clerkUserId]);
    const ok = !!r.rows[0];
    adminCache.set(clerkUserId, { at: Date.now(), ok });
    return ok;
  }

  // Sets req.pxActor ('operator' or 'admin:<clerkUserId>') or rejects.
  async function requirePxAdmin(req, res, next) {
    if (!pool) return res.status(503).json({ success: false, error: 'Database not configured.' });
    if (!ready) return res.status(503).json({ success: false, error: 'Prospecting is not ready: ' + (initError || 'starting') });
    try {
      if (req.headers['x-operator-key'] && operator.isOperatorKey(req.headers['x-operator-key'])) {
        req.pxActor = 'operator';
        return next();
      }
      let userId = null;
      try {
        const auth = getAuth(req);
        if (auth && auth.isAuthenticated && auth.userId) userId = auth.userId;
      } catch (e) { /* not a Clerk request */ }
      if (!userId) return res.status(401).json({ success: false, error: 'Please sign in.' });
      if (!(await isAdminUser(userId))) {
        console.warn('[PX] non-admin denied', req.method, req.path);
        return res.status(403).json({ success: false, error: 'Manager access required.' });
      }
      req.pxActor = 'admin:' + userId;
      next();
    } catch (e) {
      console.error('[PX] auth error:', e.message);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  async function init() {
    if (!pool) { console.log('Prospecting: database not configured, skipped.'); return; }
    try {
      await migrate(pool);
      await settings.seedAgents();
      ready = true;
      initError = null;
      console.log('Prospecting: px_* schema ready.');
    } catch (e) {
      initError = e.message;
      console.error('Prospecting init failed (rest of AutoPost unaffected):', e.message);
    }
  }

  const api = createApi({ pool, settings, clerkClient, requirePxAdmin, adminCache });
  router.use(api.router);

  return { router, init, isReady: function () { return ready; }, settings };
};

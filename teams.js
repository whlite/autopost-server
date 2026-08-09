// teams.js — AutoPost Teams foundation layer (Phase 1)
//
// Self-contained dealership/team layer. Everything here lives in the ap_* table
// namespace and is joined to the rest of AutoPost only by clerk_user_id.
//
// WHY A SEPARATE NAMESPACE (and not autopost_teams/autopost_team_members):
//   1. upsertUserFromSubscription() runs on EVERY /api/extension/create-token and
//      ends with an upsert on autopost_team_members using
//      ON CONFLICT (clerk_user_id) DO UPDATE SET team_id = <the user's OWN team>,
//      role = 'owner'. Any dealership membership written there is destroyed by the
//      member's next sign-in.
//   2. autopost_team_members.clerk_user_id is globally UNIQUE — one team per user
//      forever. Relaxing it means dropping a constraint the live sign-in upsert
//      depends on; a rollback of that deploy breaks logins for every customer,
//      Solo included.
// So the billing tables are left exactly as they are, and the dealership layer is
// purely additive. A Solo user's request path touches one indexed SELECT that
// returns zero rows.
//
// Phase 1 scope: schema, actor resolution, team/role resolution, /api/team/context,
// and admin provisioning. No coverage, no reservations, no reporting yet.

const crypto = require('crypto');
const express = require('express');

// ─────────────────────────────────────────────────────────────────────────────
// Schema. Follows the existing initDb() convention: idempotent DDL replayed on
// every Railway boot, no migration tool. Rollback is a redeploy — the tables
// simply stop being read.
// ─────────────────────────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ap_teams (
     id                      BIGSERIAL PRIMARY KEY,
     name                    TEXT NOT NULL,
     slug                    TEXT UNIQUE,
     dealership_domain       TEXT,
     timezone                TEXT NOT NULL DEFAULT 'America/Denver',
     posting_limit           INTEGER NOT NULL DEFAULT 2,
     reservation_ttl_minutes INTEGER NOT NULL DEFAULT 30,
     parent_group_id         BIGINT REFERENCES ap_teams(id),
     stripe_customer_id      TEXT,
     stripe_subscription_id  TEXT,
     subscription_status     TEXT NOT NULL DEFAULT 'active',
     seat_limit              INTEGER NOT NULL DEFAULT 10,
     status                  TEXT NOT NULL DEFAULT 'ACTIVE',
     created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS ap_team_members (
     id               BIGSERIAL PRIMARY KEY,
     team_id          BIGINT NOT NULL REFERENCES ap_teams(id) ON DELETE CASCADE,
     clerk_user_id    TEXT NOT NULL,
     email            TEXT,
     display_name     TEXT,
     role             TEXT NOT NULL DEFAULT 'SALESPERSON',
     status           TEXT NOT NULL DEFAULT 'ACTIVE',
     joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_activity_at TIMESTAMPTZ,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT ap_team_members_uniq UNIQUE (team_id, clerk_user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS ap_tm_user ON ap_team_members (clerk_user_id) WHERE status = 'ACTIVE'`,
  `CREATE INDEX IF NOT EXISTS ap_tm_team ON ap_team_members (team_id, status)`,
  `CREATE INDEX IF NOT EXISTS ap_tm_email ON ap_team_members (LOWER(email))`,

  `CREATE TABLE IF NOT EXISTS ap_vehicles (
     id               BIGSERIAL PRIMARY KEY,
     team_id          BIGINT NOT NULL REFERENCES ap_teams(id) ON DELETE CASCADE,
     vin              TEXT,
     url_key          TEXT NOT NULL,
     stock_number     TEXT,
     year             INTEGER,
     make             TEXT,
     model            TEXT,
     trim             TEXT,
     vehicle_url      TEXT,
     inventory_status TEXT NOT NULL DEFAULT 'ACTIVE',
     source           TEXT NOT NULL DEFAULT 'EXTENSION',
     merged_into_id   BIGINT REFERENCES ap_vehicles(id),
     first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     removed_at       TIMESTAMPTZ,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ap_veh_team_vin ON ap_vehicles (team_id, vin) WHERE vin IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ap_veh_team_url ON ap_vehicles (team_id, url_key) WHERE merged_into_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS ap_veh_team_status ON ap_vehicles (team_id, inventory_status)`,

  `CREATE TABLE IF NOT EXISTS ap_vehicle_coverage (
     id            BIGSERIAL PRIMARY KEY,
     team_id       BIGINT NOT NULL REFERENCES ap_teams(id) ON DELETE CASCADE,
     vehicle_id    BIGINT NOT NULL REFERENCES ap_vehicles(id) ON DELETE CASCADE,
     clerk_user_id TEXT NOT NULL,
     status        TEXT NOT NULL,
     session_id    TEXT,
     reserved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     completed_at  TIMESTAMPTZ,
     expires_at    TIMESTAMPTZ,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT ap_cov_uniq UNIQUE (vehicle_id, clerk_user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS ap_cov_live ON ap_vehicle_coverage (vehicle_id, status)
     WHERE status IN ('RESERVED', 'COMPLETED')`,

  `CREATE TABLE IF NOT EXISTS ap_post_events (
     id                 BIGSERIAL PRIMARY KEY,
     team_id            BIGINT NOT NULL REFERENCES ap_teams(id) ON DELETE CASCADE,
     vehicle_id         BIGINT REFERENCES ap_vehicles(id) ON DELETE SET NULL,
     clerk_user_id      TEXT NOT NULL,
     session_id         TEXT NOT NULL,
     event_type         TEXT NOT NULL,
     status             TEXT NOT NULL,
     confirmation_level TEXT,
     denied_reason      TEXT,
     vin_snapshot       TEXT,
     meta               JSONB,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     completed_at       TIMESTAMPTZ,
     CONSTRAINT ap_evt_idem UNIQUE (session_id, event_type)
   )`,
  `CREATE INDEX IF NOT EXISTS ap_evt_team_time ON ap_post_events (team_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ap_evt_team_user ON ap_post_events (team_id, clerk_user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ap_evt_vehicle   ON ap_post_events (vehicle_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS ap_team_invites (
     id          BIGSERIAL PRIMARY KEY,
     team_id     BIGINT NOT NULL REFERENCES ap_teams(id) ON DELETE CASCADE,
     email       TEXT NOT NULL,
     role        TEXT NOT NULL DEFAULT 'SALESPERSON',
     token       TEXT NOT NULL UNIQUE,
     invited_by  TEXT NOT NULL,
     status      TEXT NOT NULL DEFAULT 'PENDING',
     expires_at  TIMESTAMPTZ NOT NULL,
     accepted_at TIMESTAMPTZ,
     accepted_by TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS ap_inv_email ON ap_team_invites (LOWER(email), status)`,

  `CREATE TABLE IF NOT EXISTS ap_audit_events (
     id            BIGSERIAL PRIMARY KEY,
     team_id       BIGINT NOT NULL REFERENCES ap_teams(id) ON DELETE CASCADE,
     actor_user_id TEXT NOT NULL,
     action        TEXT NOT NULL,
     target        TEXT,
     detail        JSONB,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS ap_audit_team ON ap_audit_events (team_id, created_at DESC)`
];

const ROLES = ['SALESPERSON', 'MANAGER'];

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Display name shown to teammates in the extension (§63). Never an email address:
// "daniel.sanchez@fiestasubaru.com" becomes "Daniel Sanchez".
function deriveDisplayName(explicit, email) {
  const given = String(explicit || '').trim();
  if (given) return given.slice(0, 60);
  const local = String(email || '').split('@')[0] || '';
  if (!local) return 'Teammate';
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, '')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 60) || 'Teammate';
}

module.exports = function createTeams(deps) {
  const {
    pool,
    verifySessionToken,
    getAuth,
    normalizeEmail,
    safeEqual,
    adminSecret
  } = deps;

  const router = express.Router();

  // ───────────────────────────────────────────────────────────────────────────
  // Logging (§81): one structured line per team decision. Never tokens, emails
  // or payment data.
  // ───────────────────────────────────────────────────────────────────────────
  function teamLog(fields) {
    const parts = Object.keys(fields)
      .filter(k => fields[k] !== undefined && fields[k] !== null && fields[k] !== '')
      .map(k => `${k}=${fields[k]}`);
    console.log('[TEAM] ' + parts.join(' '));
  }

  async function initTeamsSchema() {
    if (!pool) {
      console.log('Teams: database not configured, schema skipped.');
      return;
    }
    for (const stmt of SCHEMA) {
      await pool.query(stmt);
    }
    console.log('Teams: ap_* schema ready (' + SCHEMA.length + ' statements).');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Actor resolution. The extension carries an AutoPost HMAC token; the website
  // carries a Clerk session. Both collapse to a clerk_user_id. Mirrors the dual
  // path already used by /api/extension/access.
  // ───────────────────────────────────────────────────────────────────────────
  async function resolveActor(req) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';

    // AutoPost session tokens are "<base64url>.<base64url>" — two segments. A Clerk
    // JWT has three. Only try the HMAC path on a token shaped like ours, so a Clerk
    // token never burns a failed signature check.
    if (bearer && bearer.split('.').length === 2) {
      const verified = verifySessionToken(bearer);
      if (verified.valid && verified.session && verified.session.clerkUserId) {
        return {
          clerkUserId: verified.session.clerkUserId,
          email: normalizeEmail(verified.session.email),
          via: 'extension'
        };
      }
    }

    try {
      const auth = getAuth(req);
      if (auth && auth.isAuthenticated && auth.userId) {
        return { clerkUserId: auth.userId, email: '', via: 'clerk' };
      }
    } catch (e) { /* not a Clerk request */ }

    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Team resolution. team_id is derived ONLY from the authenticated user (§60) —
  // no route may read it from the body, query or headers.
  //
  // Cached 60s per user so the VDP hot path stays cheap (§79). The cache is
  // invalidated explicitly whenever membership changes in this process.
  // ───────────────────────────────────────────────────────────────────────────
  const membershipCache = new Map(); // clerkUserId -> { at, value }
  const MEMBERSHIP_TTL_MS = 60 * 1000;

  function invalidateMembership(clerkUserId) {
    if (clerkUserId) membershipCache.delete(clerkUserId);
    else membershipCache.clear();
  }

  async function lookupMembership(clerkUserId) {
    if (!pool || !clerkUserId) return null;

    const cached = membershipCache.get(clerkUserId);
    if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) return cached.value;

    const result = await pool.query(
      `SELECT m.id            AS membership_id,
              m.role,
              m.status        AS member_status,
              m.display_name,
              m.email,
              t.id            AS team_id,
              t.name          AS team_name,
              t.slug,
              t.timezone,
              t.posting_limit,
              t.reservation_ttl_minutes,
              t.subscription_status,
              t.status        AS team_status
         FROM ap_team_members m
         JOIN ap_teams t ON t.id = m.team_id
        WHERE m.clerk_user_id = $1
          AND m.status = 'ACTIVE'
          AND t.status = 'ACTIVE'
        ORDER BY m.joined_at ASC
        LIMIT 1`,
      [clerkUserId]
    );

    const value = result.rows[0] || null;
    membershipCache.set(clerkUserId, { at: Date.now(), value });
    return value;
  }

  // Attaches req.actor / req.team / req.membership. Does NOT reject a user with no
  // team — that is a Solo user, and Solo must keep working untouched (§58).
  async function attachTeam(req, res, next) {
    try {
      req.actor = await resolveActor(req);
      req.team = null;
      req.membership = null;

      if (!req.actor) return next();

      const row = await lookupMembership(req.actor.clerkUserId);
      if (!row) return next();

      req.team = {
        id: row.team_id,
        name: row.team_name,
        slug: row.slug,
        timezone: row.timezone,
        postingLimit: row.posting_limit,
        reservationTtlMinutes: row.reservation_ttl_minutes,
        subscriptionStatus: row.subscription_status
      };
      req.membership = {
        id: row.membership_id,
        role: row.role,
        status: row.member_status,
        displayName: row.display_name,
        email: row.email
      };
      next();
    } catch (e) {
      console.error('[TEAM] attachTeam error:', e.message);
      // Never take down a request path Solo depends on. Continue team-less; the
      // fail-closed decision belongs to the routes that actually gate posting.
      req.team = null;
      req.membership = null;
      next();
    }
  }

  function requireAuth(req, res, next) {
    if (!req.actor) {
      return res.status(401).json({ success: false, error: 'Please sign in.' });
    }
    next();
  }

  function requireTeam(req, res, next) {
    if (!req.actor) {
      return res.status(401).json({ success: false, error: 'Please sign in.' });
    }
    if (!req.team) {
      return res.status(403).json({ success: false, error: 'You are not a member of an AutoPost Teams dealership.' });
    }
    next();
  }

  function requireManager(req, res, next) {
    if (!req.team || !req.membership || req.membership.role !== 'MANAGER') {
      teamLog({
        team: req.team && req.team.id,
        user: req.actor && req.actor.clerkUserId,
        action: 'manager_route',
        result: 'denied'
      });
      return res.status(403).json({ success: false, error: 'Manager access required.' });
    }
    next();
  }

  function requireAdmin(req, res, next) {
    const provided = req.headers['x-admin-secret'] || (req.body && req.body.adminSecret) || '';
    if (!adminSecret || !safeEqual(provided, adminSecret)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  }

  router.use(attachTeam);

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/team/context
  //
  // The extension calls this once per session and caches the answer. A Solo user
  // gets teamsEnabled:false and behaves exactly as it does today.
  // ───────────────────────────────────────────────────────────────────────────
  router.get('/api/team/context', requireAuth, (req, res) => {
    if (!req.team) {
      return res.json({ success: true, teamsEnabled: false });
    }
    return res.json({
      success: true,
      teamsEnabled: true,
      team: {
        name: req.team.name,
        slug: req.team.slug,
        timezone: req.team.timezone,
        postingLimit: req.team.postingLimit
      },
      role: req.membership.role,
      displayName: req.membership.displayName
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/team  — the team record plus seat usage. Any member may read it.
  // ───────────────────────────────────────────────────────────────────────────
  router.get('/api/team', requireTeam, async (req, res) => {
    try {
      const counts = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')                          AS active_members,
                COUNT(*) FILTER (WHERE status = 'ACTIVE' AND role = 'MANAGER')     AS managers
           FROM ap_team_members
          WHERE team_id = $1`,
        [req.team.id]
      );
      const row = counts.rows[0] || {};
      return res.json({
        success: true,
        team: {
          name: req.team.name,
          slug: req.team.slug,
          timezone: req.team.timezone,
          postingLimit: req.team.postingLimit,
          reservationTtlMinutes: req.team.reservationTtlMinutes,
          subscriptionStatus: req.team.subscriptionStatus,
          activeMembers: Number(row.active_members || 0),
          managers: Number(row.managers || 0)
        },
        role: req.membership.role
      });
    } catch (e) {
      console.error('[TEAM] GET /api/team error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Admin provisioning (ADMIN_SECRET). This is how the first dealerships get
  // created before the manager invite UI exists (§42, §94). Not reachable by any
  // customer — it never consults req.team.
  // ───────────────────────────────────────────────────────────────────────────

  router.get('/api/admin/teams', requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT t.id, t.name, t.slug, t.dealership_domain, t.timezone, t.posting_limit,
                t.subscription_status, t.status, t.created_at,
                COUNT(m.id) FILTER (WHERE m.status = 'ACTIVE') AS active_members
           FROM ap_teams t
           LEFT JOIN ap_team_members m ON m.team_id = t.id
          GROUP BY t.id
          ORDER BY t.created_at DESC`
      );
      return res.json({ success: true, teams: result.rows });
    } catch (e) {
      console.error('[TEAM] admin list error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  router.post('/api/admin/teams', requireAdmin, async (req, res) => {
    try {
      const name = String((req.body && req.body.name) || '').trim();
      if (!name) return res.status(400).json({ success: false, error: 'name is required' });

      const slug = slugify((req.body && req.body.slug) || name);
      const domain = String((req.body && req.body.dealershipDomain) || '').trim().toLowerCase() || null;
      const timezone = String((req.body && req.body.timezone) || 'America/Denver').trim();
      const postingLimit = Number((req.body && req.body.postingLimit) || 2);
      const seatLimit = Number((req.body && req.body.seatLimit) || 10);

      if (!Number.isInteger(postingLimit) || postingLimit < 1 || postingLimit > 10) {
        return res.status(400).json({ success: false, error: 'postingLimit must be between 1 and 10' });
      }

      const result = await pool.query(
        `INSERT INTO ap_teams (name, slug, dealership_domain, timezone, posting_limit, seat_limit)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name,
               dealership_domain = EXCLUDED.dealership_domain,
               timezone = EXCLUDED.timezone,
               posting_limit = EXCLUDED.posting_limit,
               seat_limit = EXCLUDED.seat_limit,
               updated_at = NOW()
         RETURNING *`,
        [name, slug, domain, timezone, postingLimit, seatLimit]
      );

      const team = result.rows[0];
      teamLog({ team: team.id, action: 'admin_create_team', slug: team.slug, limit: team.posting_limit });
      return res.json({ success: true, team });
    } catch (e) {
      console.error('[TEAM] admin create team error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  router.get('/api/admin/teams/:teamId/members', requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, clerk_user_id, email, display_name, role, status, joined_at, last_activity_at
           FROM ap_team_members
          WHERE team_id = $1
          ORDER BY joined_at ASC`,
        [req.params.teamId]
      );
      return res.json({ success: true, members: result.rows });
    } catch (e) {
      console.error('[TEAM] admin list members error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  router.post('/api/admin/teams/:teamId/members', requireAdmin, async (req, res) => {
    try {
      const teamId = Number(req.params.teamId);
      const clerkUserId = String((req.body && req.body.clerkUserId) || '').trim();
      const email = normalizeEmail((req.body && req.body.email) || '');
      const role = String((req.body && req.body.role) || 'SALESPERSON').toUpperCase();
      const displayName = deriveDisplayName(req.body && req.body.displayName, email);

      if (!clerkUserId) return res.status(400).json({ success: false, error: 'clerkUserId is required' });
      if (!ROLES.includes(role)) {
        return res.status(400).json({ success: false, error: 'role must be SALESPERSON or MANAGER' });
      }

      const team = await pool.query(`SELECT id FROM ap_teams WHERE id = $1`, [teamId]);
      if (!team.rows[0]) return res.status(404).json({ success: false, error: 'Team not found' });

      const result = await pool.query(
        `INSERT INTO ap_team_members (team_id, clerk_user_id, email, display_name, role, status)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE')
         ON CONFLICT (team_id, clerk_user_id) DO UPDATE
           SET email = COALESCE(EXCLUDED.email, ap_team_members.email),
               display_name = COALESCE(EXCLUDED.display_name, ap_team_members.display_name),
               role = EXCLUDED.role,
               status = 'ACTIVE',
               updated_at = NOW()
         RETURNING id, team_id, clerk_user_id, email, display_name, role, status, joined_at`,
        [teamId, clerkUserId, email || null, displayName, role]
      );

      invalidateMembership(clerkUserId);
      await pool.query(
        `INSERT INTO ap_audit_events (team_id, actor_user_id, action, target, detail)
         VALUES ($1,'ADMIN','MEMBER_ADD',$2,$3)`,
        [teamId, clerkUserId, JSON.stringify({ role })]
      );

      teamLog({ team: teamId, user: clerkUserId, action: 'admin_add_member', role });
      return res.json({ success: true, member: result.rows[0] });
    } catch (e) {
      console.error('[TEAM] admin add member error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  router.delete('/api/admin/teams/:teamId/members/:clerkUserId', requireAdmin, async (req, res) => {
    try {
      const teamId = Number(req.params.teamId);
      const clerkUserId = req.params.clerkUserId;

      // Deactivate, never delete — history must survive (§34).
      const result = await pool.query(
        `UPDATE ap_team_members
            SET status = 'INACTIVE', updated_at = NOW()
          WHERE team_id = $1 AND clerk_user_id = $2
          RETURNING id`,
        [teamId, clerkUserId]
      );
      if (!result.rows[0]) return res.status(404).json({ success: false, error: 'Member not found' });

      invalidateMembership(clerkUserId);
      await pool.query(
        `INSERT INTO ap_audit_events (team_id, actor_user_id, action, target)
         VALUES ($1,'ADMIN','MEMBER_DEACTIVATE',$2)`,
        [teamId, clerkUserId]
      );

      teamLog({ team: teamId, user: clerkUserId, action: 'admin_deactivate_member' });
      return res.json({ success: true });
    } catch (e) {
      console.error('[TEAM] admin remove member error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // Resolve a Clerk user id from an email that has already signed in to AutoPost.
  // Saves hand-copying ids out of the Clerk dashboard when provisioning a team.
  router.get('/api/admin/lookup-user', requireAdmin, async (req, res) => {
    try {
      const email = normalizeEmail(req.query.email || '');
      if (!email) return res.status(400).json({ success: false, error: 'email is required' });
      const result = await pool.query(
        `SELECT clerk_user_id, email, created_at
           FROM autopost_users
          WHERE LOWER(email) = $1 AND clerk_user_id IS NOT NULL
          LIMIT 1`,
        [email]
      );
      if (!result.rows[0]) {
        return res.status(404).json({ success: false, error: 'No AutoPost user with that email has signed in yet.' });
      }
      return res.json({ success: true, user: result.rows[0] });
    } catch (e) {
      console.error('[TEAM] admin lookup error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  return {
    router,
    initTeamsSchema,
    // exported for the phases that follow (coverage, reservations, reporting)
    resolveActor,
    attachTeam,
    requireAuth,
    requireTeam,
    requireManager,
    requireAdmin,
    invalidateMembership,
    teamLog,
    deriveDisplayName,
    slugify
  };
};

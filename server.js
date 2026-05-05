'use strict';

// ============================================================
// AutoPost Railway Server
// Auth: Clerk  |  Billing: Stripe  |  DB: Neon Postgres
// Legacy Google Sheets routes preserved until migration complete
// ============================================================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Stripe = require('stripe');
const { createClerkClient } = require('@clerk/backend');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Clients ──────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ── CORS ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://tryautopost.com',
  'https://www.tryautopost.com',
  'chrome-extension://kjoaedklmmpkikmeigaehgaglialdabl', // prod extension ID — update as needed
];

app.use(cors({
  origin: function (origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // also allow any chrome-extension:// origin during development
    if (/^chrome-extension:\/\//.test(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Raw body for Stripe webhooks (must come BEFORE express.json) ──
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// ── JSON body for everything else ────────────────────────────
app.use(express.json());

// ── DB bootstrap — create tables if they don't exist ─────────
async function bootstrapDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id            SERIAL PRIMARY KEY,
      owner_clerk_id TEXT NOT NULL UNIQUE,
      plan          TEXT NOT NULL DEFAULT 'solo',
      seat_limit    INT  NOT NULL DEFAULT 1,
      stripe_customer_id    TEXT,
      stripe_subscription_id TEXT,
      subscription_status   TEXT DEFAULT 'inactive',
      extension_enabled     BOOLEAN DEFAULT false,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id         SERIAL PRIMARY KEY,
      team_id    INT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      clerk_id   TEXT NOT NULL UNIQUE,
      email      TEXT,
      role       TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('AutoPost: DB tables ready');
}

bootstrapDB().catch(err => console.error('AutoPost: DB bootstrap error', err));

// ============================================================
// HELPERS
// ============================================================

/** Pull Bearer token from Authorization header */
function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

/**
 * Verify Clerk session token and return { clerkUserId, email }.
 * Throws on failure so callers can catch and send 401.
 */
async function requireClerkAuth(req) {
  const token = getBearerToken(req);
  if (!token) throw new Error('Missing auth token');

  // Verify the JWT with Clerk
  const payload = await clerk.verifyToken(token);
  if (!payload || !payload.sub) throw new Error('Invalid token');

  // Optionally fetch email from Clerk
  let email = '';
  try {
    const user = await clerk.users.getUser(payload.sub);
    email = (user.emailAddresses && user.emailAddresses[0] && user.emailAddresses[0].emailAddress) || '';
  } catch (_) {}

  return { clerkUserId: payload.sub, email };
}

/** Map Stripe subscription status → extension allowed */
function isSubscriptionActive(status) {
  return status === 'active' || status === 'trialing';
}

// ============================================================
// LEGACY AUTH (Google Sheets era) — KEEP UNTIL MIGRATION DONE
// ============================================================

// These are intentionally left here so the existing Chrome extension
// (which calls /login and /verify-session) keeps working while you
// roll out the Clerk migration. Replace these with stubs or remove
// them only after all users are on the new flow.

const LEGACY_TOKENS = new Map(); // token -> { username, expiresAt }

function legacyGenerateToken(username) {
  const token = 'ap_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  LEGACY_TOKENS.set(token, { username, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  return token;
}

function legacyVerifyToken(token) {
  const rec = LEGACY_TOKENS.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { LEGACY_TOKENS.delete(token); return null; }
  return rec;
}

// POST /login  — legacy username/password login
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'Missing credentials' });

    // ── Look up user in Neon by email/username ──
    // During migration we check legacy column if it exists, else Clerk only.
    // Adjust the query to match your actual users table if you have one.
    // For now we'll fall through to a basic Clerk password check via signIn.
    // NOTE: Clerk doesn't expose password verification via backend SDK.
    // The recommended migration path: point users to the new website login
    // and issue a short-lived JWT via Clerk, then exchange it here.
    // Until then, return a clear error so users know to use the new flow.
    return res.status(401).json({
      success: false,
      error: 'Please log in at tryautopost.com to get your access token, then paste it in the extension.',
    });
  } catch (err) {
    console.error('/login error', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /verify-session  — called by extension background.js and popup.js
app.post('/verify-session', async (req, res) => {
  try {
    const token = getBearerToken(req) || (req.body && req.body.token);
    if (!token) return res.status(401).json({ success: false, active: false, error: 'No token' });

    // ── Try Clerk JWT first ──
    try {
      const payload = await clerk.verifyToken(token);
      if (payload && payload.sub) {
        // Find the team member
        const memberRow = await db.query(
          `SELECT tm.*, t.plan, t.seat_limit, t.subscription_status, t.extension_enabled
           FROM team_members tm
           JOIN teams t ON t.id = tm.team_id
           WHERE tm.clerk_id = $1`,
          [payload.sub]
        );

        if (memberRow.rows.length === 0) {
          return res.json({ success: false, active: false, error: 'No active subscription found.' });
        }

        const row = memberRow.rows[0];
        const active = row.extension_enabled && isSubscriptionActive(row.subscription_status);

        return res.json({
          success: true,
          active,
          allowed: active,
          user: {
            username: row.email || payload.sub,
            plan: row.plan,
            subscriptionStatus: row.subscription_status,
          },
        });
      }
    } catch (_) {
      // not a valid Clerk token — fall through to legacy check
    }

    // ── Legacy in-memory token ──
    const rec = legacyVerifyToken(token);
    if (rec) {
      return res.json({ success: true, active: true, allowed: true, user: { username: rec.username } });
    }

    return res.status(401).json({ success: false, active: false, error: 'Invalid or expired token.' });
  } catch (err) {
    console.error('/verify-session error', err);
    res.status(500).json({ success: false, active: false, error: 'Server error' });
  }
});

// POST /logout  — legacy
app.post('/logout', (req, res) => {
  const token = getBearerToken(req) || (req.body && req.body.token);
  if (token) LEGACY_TOKENS.delete(token);
  res.json({ success: true });
});

// ============================================================
// EXISTING WORKING ROUTES — DO NOT TOUCH
// ============================================================

// GET /api/clerk-test
app.get('/api/clerk-test', async (req, res) => {
  try {
    // Simple connectivity test — list first user
    const users = await clerk.users.getUserList({ limit: 1 });
    res.json({ success: true, clerkConnected: true, userCount: users.totalCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/db-test
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW() AS now');
    res.json({ success: true, dbConnected: true, serverTime: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /describe  — vehicle description generation (keep working)
app.post('/describe', async (req, res) => {
  // Description is now generated locally in the extension (background.js).
  // This endpoint is kept as a no-op stub so old extension versions don't error.
  res.json({ success: true, description: '' });
});

// ============================================================
// NEW: STRIPE CONFIG TEST
// ============================================================

// GET /api/stripe-config-test
app.get('/api/stripe-config-test', (req, res) => {
  res.json({
    success: true,
    STRIPE_SECRET_KEY:    !!process.env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_SOLO:    !!process.env.STRIPE_PRICE_SOLO,
    STRIPE_PRICE_TEAM:    !!process.env.STRIPE_PRICE_TEAM,
  });
});

// ============================================================
// NEW: STRIPE CHECKOUT SESSION
// ============================================================

// POST /api/stripe/create-checkout-session
// Body: { plan: "solo" | "team" }
// Requires Clerk Bearer token in Authorization header
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { clerkUserId, email } = await requireClerkAuth(req).catch(e => { throw Object.assign(e, { status: 401 }); });

    const { plan } = req.body || {};
    if (!plan || !['solo', 'team'].includes(plan)) {
      return res.status(400).json({ success: false, error: 'plan must be "solo" or "team"' });
    }

    const priceId = plan === 'solo' ? process.env.STRIPE_PRICE_SOLO : process.env.STRIPE_PRICE_TEAM;
    if (!priceId) return res.status(500).json({ success: false, error: `STRIPE_PRICE_${plan.toUpperCase()} not configured` });

    const seatLimit = plan === 'solo' ? 1 : 3;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      success_url: 'https://tryautopost.com/success',
      cancel_url:  'https://tryautopost.com/pricing',
      metadata: {
        clerkUserId,
        email,
        plan,
        seatLimit: String(seatLimit),
      },
      subscription_data: {
        metadata: {
          clerkUserId,
          email,
          plan,
          seatLimit: String(seatLimit),
        },
      },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('/api/stripe/create-checkout-session error', err);
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ============================================================
// NEW: STRIPE WEBHOOK
// ============================================================

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// POST /api/stripe/webhook
app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

async function handleStripeEvent(event) {
  const type = event.type;
  console.log('AutoPost stripe event:', type);

  // ── checkout.session.completed ──
  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    const clerkUserId  = meta.clerkUserId;
    const email        = meta.email || '';
    const plan         = meta.plan || 'solo';
    const seatLimit    = parseInt(meta.seatLimit || '1', 10);
    const customerId   = session.customer;
    const subId        = session.subscription;

    if (!clerkUserId) {
      console.error('checkout.session.completed: no clerkUserId in metadata');
      return;
    }

    await upsertTeamAndMember({ clerkUserId, email, plan, seatLimit, customerId, subId, status: 'active', enabled: true });
    return;
  }

  // ── subscription events ──
  if (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  ) {
    const sub = event.data.object;
    const meta = sub.metadata || {};
    const clerkUserId = meta.clerkUserId;
    const plan        = meta.plan || 'solo';
    const seatLimit   = parseInt(meta.seatLimit || '1', 10);
    const customerId  = sub.customer;
    const subId       = sub.id;
    const status      = sub.status; // active | trialing | past_due | canceled | unpaid | incomplete_expired

    if (!clerkUserId) return; // can't map without it

    const enabled = isSubscriptionActive(status);
    await upsertTeamAndOwnerStatus({ clerkUserId, plan, seatLimit, customerId, subId, status, enabled });
    return;
  }

  // ── invoice.paid ──
  if (type === 'invoice.paid') {
    const invoice = event.data.object;
    const subId   = invoice.subscription;
    if (!subId) return;
    await db.query(
      `UPDATE teams SET subscription_status = 'active', extension_enabled = true, updated_at = NOW()
       WHERE stripe_subscription_id = $1`,
      [subId]
    );
    return;
  }

  // ── invoice.payment_failed ──
  if (type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const subId   = invoice.subscription;
    if (!subId) return;
    await db.query(
      `UPDATE teams SET subscription_status = 'past_due', extension_enabled = false, updated_at = NOW()
       WHERE stripe_subscription_id = $1`,
      [subId]
    );
    return;
  }
}

/** Create or update the team row, then ensure the owner is in team_members */
async function upsertTeamAndMember({ clerkUserId, email, plan, seatLimit, customerId, subId, status, enabled }) {
  // Upsert team by owner_clerk_id
  const teamRes = await db.query(
    `INSERT INTO teams (owner_clerk_id, plan, seat_limit, stripe_customer_id, stripe_subscription_id, subscription_status, extension_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (owner_clerk_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       seat_limit = EXCLUDED.seat_limit,
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       subscription_status = EXCLUDED.subscription_status,
       extension_enabled = EXCLUDED.extension_enabled,
       updated_at = NOW()
     RETURNING id`,
    [clerkUserId, plan, seatLimit, customerId, subId, status, enabled]
  );

  const teamId = teamRes.rows[0].id;

  // Upsert the owner in team_members
  await db.query(
    `INSERT INTO team_members (team_id, clerk_id, email, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (clerk_id) DO UPDATE SET
       team_id = EXCLUDED.team_id,
       email   = EXCLUDED.email,
       role    = 'owner'`,
    [teamId, clerkUserId, email]
  );
}

/** Update team status/enabled by owner_clerk_id — used for subscription updates */
async function upsertTeamAndOwnerStatus({ clerkUserId, plan, seatLimit, customerId, subId, status, enabled }) {
  await db.query(
    `INSERT INTO teams (owner_clerk_id, plan, seat_limit, stripe_customer_id, stripe_subscription_id, subscription_status, extension_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (owner_clerk_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       seat_limit = EXCLUDED.seat_limit,
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       subscription_status = EXCLUDED.subscription_status,
       extension_enabled = EXCLUDED.extension_enabled,
       updated_at = NOW()`,
    [clerkUserId, plan, seatLimit, customerId, subId, status, enabled]
  );
}

// ============================================================
// NEW: EXTENSION ACCESS CHECK
// ============================================================

// GET /api/extension/access
// Requires Clerk Bearer token in Authorization header
app.get('/api/extension/access', async (req, res) => {
  try {
    const { clerkUserId } = await requireClerkAuth(req).catch(e => { throw Object.assign(e, { status: 401 }); });

    // Find this Clerk user in team_members, join to team
    const result = await db.query(
      `SELECT
         tm.role,
         tm.email,
         t.plan,
         t.seat_limit,
         t.subscription_status,
         t.extension_enabled,
         (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS seats_used
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.clerk_id = $1`,
      [clerkUserId]
    );

    if (result.rows.length === 0) {
      return res.json({
        allowed: false,
        status: 'no_subscription',
        plan: null,
        seatLimit: 0,
        seatsUsed: 0,
        role: null,
        extensionEnabled: false,
      });
    }

    const row = result.rows[0];
    const allowed = row.extension_enabled && isSubscriptionActive(row.subscription_status);

    res.json({
      allowed,
      status: row.subscription_status,
      plan: row.plan,
      seatLimit: row.seat_limit,
      seatsUsed: parseInt(row.seats_used, 10),
      role: row.role,
      extensionEnabled: row.extension_enabled,
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ allowed: false, error: err.message });
  }
});

// ============================================================
// NEW: TEAM MEMBER MANAGEMENT
// ============================================================

// POST /api/team/add-member
// Body: { memberEmail: string }
// Must be called by the team owner with their Clerk token.
// Adds a pending invite — member activates via Clerk sign-up at tryautopost.com.
// This endpoint resolves the Clerk ID by email lookup.
app.post('/api/team/add-member', async (req, res) => {
  try {
    const { clerkUserId } = await requireClerkAuth(req).catch(e => { throw Object.assign(e, { status: 401 }); });
    const { memberEmail } = req.body || {};
    if (!memberEmail) return res.status(400).json({ success: false, error: 'memberEmail required' });

    // Check caller is the team owner
    const ownerCheck = await db.query(
      `SELECT t.id, t.seat_limit, t.plan,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS seats_used
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.clerk_id = $1 AND tm.role = 'owner'`,
      [clerkUserId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Only the team owner can add members.' });
    }

    const { id: teamId, seat_limit, seats_used } = ownerCheck.rows[0];

    if (parseInt(seats_used, 10) >= parseInt(seat_limit, 10)) {
      return res.status(400).json({ success: false, error: `Seat limit (${seat_limit}) reached. Upgrade to add more members.` });
    }

    // Look up the Clerk user by email
    const clerkUsers = await clerk.users.getUserList({ emailAddress: [memberEmail] });
    if (!clerkUsers || !clerkUsers.data || clerkUsers.data.length === 0) {
      return res.status(404).json({ success: false, error: 'That email is not registered with AutoPost yet. Ask them to sign up first.' });
    }

    const memberClerkId = clerkUsers.data[0].id;

    // Make sure they're not already in a team
    const existing = await db.query('SELECT id FROM team_members WHERE clerk_id = $1', [memberClerkId]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'That user already belongs to a team.' });
    }

    await db.query(
      `INSERT INTO team_members (team_id, clerk_id, email, role) VALUES ($1, $2, $3, 'member')`,
      [teamId, memberClerkId, memberEmail]
    );

    res.json({ success: true, message: `${memberEmail} added to your team.` });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// GET /api/team/members  — list all members on the caller's team
app.get('/api/team/members', async (req, res) => {
  try {
    const { clerkUserId } = await requireClerkAuth(req).catch(e => { throw Object.assign(e, { status: 401 }); });

    const result = await db.query(
      `SELECT tm2.clerk_id, tm2.email, tm2.role, tm2.created_at
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN team_members tm2 ON tm2.team_id = t.id
       WHERE tm.clerk_id = $1
       ORDER BY tm2.created_at`,
      [clerkUserId]
    );

    res.json({ success: true, members: result.rows });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', (req, res) => res.json({ ok: true, version: '3.12' }));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`AutoPost server listening on port ${PORT}`));

'use strict';

// ============================================================
// AutoPost Railway Server
// Auth: email+password in Neon  |  Billing: Stripe  |  DB: Neon Postgres
// Legacy Google Sheets routes preserved until migration complete
// ============================================================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Stripe = require('stripe');
const { createClerkClient } = require('@clerk/backend');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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
  'chrome-extension://kjoaedklmmpkikmeigaehgaglialdabl',
];

app.use(cors({
  origin: function (origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
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
      id                     SERIAL PRIMARY KEY,
      owner_clerk_id         TEXT NOT NULL UNIQUE,
      plan                   TEXT NOT NULL DEFAULT 'solo',
      seat_limit             INT  NOT NULL DEFAULT 1,
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      subscription_status    TEXT DEFAULT 'inactive',
      extension_enabled      BOOLEAN DEFAULT false,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id         SERIAL PRIMARY KEY,
      team_id    INT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      clerk_id   TEXT NOT NULL UNIQUE,
      email      TEXT,
      role       TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Users table — email/password login for the extension
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      team_id       INT REFERENCES teams(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Active tokens table — tokens survive server restarts
  await db.query(`
    CREATE TABLE IF NOT EXISTS active_tokens (
      token      TEXT PRIMARY KEY,
      user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('AutoPost: DB tables ready');
}

bootstrapDB().catch(err => console.error('AutoPost: DB bootstrap error', err));

// ============================================================
// HELPERS
// ============================================================

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

async function requireClerkAuth(req) {
  const token = getBearerToken(req);
  if (!token) throw new Error('Missing auth token');
  const payload = await clerk.verifyToken(token);
  if (!payload || !payload.sub) throw new Error('Invalid token');
  let email = '';
  try {
    const user = await clerk.users.getUser(payload.sub);
    email = (user.emailAddresses && user.emailAddresses[0] && user.emailAddresses[0].emailAddress) || '';
  } catch (_) {}
  return { clerkUserId: payload.sub, email };
}

function isSubscriptionActive(status) {
  return status === 'active' || status === 'trialing';
}

function generateToken() {
  return 'ap_' + crypto.randomBytes(32).toString('hex');
}

// ============================================================
// EMAIL + PASSWORD AUTH (extension login)
// ============================================================

// POST /login
// Called by the extension popup with { username: email, password }
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Enter your email and password.' });
    }

    const email = username.toLowerCase().trim();

    // Find user by email
    const userRes = await db.query(
      `SELECT u.id, u.email, u.password_hash, u.team_id,
              t.plan, t.subscription_status, t.extension_enabled
       FROM users u
       LEFT JOIN teams t ON t.id = u.team_id
       WHERE u.email = $1`,
      [email]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'No account found. Sign up at tryautopost.com.' });
    }

    const user = userRes.rows[0];

    // Check password
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Incorrect password.' });
    }

    // Check subscription
    if (!user.team_id || !user.extension_enabled || !isSubscriptionActive(user.subscription_status)) {
      return res.status(403).json({ success: false, error: 'No active subscription. Visit tryautopost.com to subscribe.' });
    }

    // Generate token and save to DB (expires in 12 hours)
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO active_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, user.id, expiresAt]
    );

    // Clean up old expired tokens for this user
    await db.query(
      `DELETE FROM active_tokens WHERE user_id = $1 AND expires_at < NOW()`,
      [user.id]
    );

    res.json({
      success: true,
      token,
      expiresInSeconds: 43200,
      user: {
        username: user.email,
        plan: user.plan,
        subscriptionStatus: user.subscription_status,
      },
    });
  } catch (err) {
    console.error('/login error', err);
    res.status(500).json({ success: false, error: 'Server error. Try again.' });
  }
});

// POST /verify-session
// Called by extension background.js and popup.js
app.post('/verify-session', async (req, res) => {
  try {
    const token = getBearerToken(req) || (req.body && req.body.token);
    if (!token) return res.status(401).json({ success: false, active: false, error: 'No token' });

    // ── Try our own DB token first ──
    const tokenRes = await db.query(
      `SELECT at.user_id, at.expires_at,
              u.email,
              t.plan, t.subscription_status, t.extension_enabled
       FROM active_tokens at
       JOIN users u ON u.id = at.user_id
       LEFT JOIN teams t ON t.id = u.team_id
       WHERE at.token = $1`,
      [token]
    );

    if (tokenRes.rows.length > 0) {
      const row = tokenRes.rows[0];

      if (new Date() > new Date(row.expires_at)) {
        await db.query('DELETE FROM active_tokens WHERE token = $1', [token]);
        return res.json({ success: false, active: false, error: 'Session expired. Please sign in again.' });
      }

      const active = row.extension_enabled && isSubscriptionActive(row.subscription_status);

      return res.json({
        success: true,
        active,
        allowed: active,
        user: {
          username: row.email,
          plan: row.plan,
          subscriptionStatus: row.subscription_status,
        },
      });
    }

    // ── Try Clerk JWT as fallback ──
    try {
      const payload = await clerk.verifyToken(token);
      if (payload && payload.sub) {
        const memberRow = await db.query(
          `SELECT tm.*, t.plan, t.seat_limit, t.subscription_status, t.extension_enabled
           FROM team_members tm
           JOIN teams t ON t.id = tm.team_id
           WHERE tm.clerk_id = $1`,
          [payload.sub]
        );

        if (memberRow.rows.length > 0) {
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
      }
    } catch (_) {}

    return res.status(401).json({ success: false, active: false, error: 'Invalid or expired session. Please sign in again.' });
  } catch (err) {
    console.error('/verify-session error', err);
    res.status(500).json({ success: false, active: false, error: 'Server error' });
  }
});

// POST /logout
app.post('/logout', async (req, res) => {
  try {
    const token = getBearerToken(req) || (req.body && req.body.token);
    if (token) await db.query('DELETE FROM active_tokens WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (_) {
    res.json({ success: true });
  }
});

// ============================================================
// SIGNUP — called from tryautopost.com after Stripe payment
// POST /api/auth/signup
// Body: { email, password }
// ============================================================
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'An account with that email already exists.' });
    }

    const hash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [normalizedEmail, hash]);

    res.json({ success: true, message: 'Account created. You can now sign in to the extension.' });
  } catch (err) {
    console.error('/api/auth/signup error', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ============================================================
// EXISTING WORKING ROUTES — DO NOT TOUCH
// ============================================================

app.get('/api/clerk-test', async (req, res) => {
  try {
    const users = await clerk.users.getUserList({ limit: 1 });
    res.json({ success: true, clerkConnected: true, userCount: users.totalCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW() AS now');
    res.json({ success: true, dbConnected: true, serverTime: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/describe', async (req, res) => {
  res.json({ success: true, description: '' });
});

// ============================================================
// STRIPE CONFIG TEST
// ============================================================

app.get('/api/stripe-config-test', (req, res) => {
  res.json({
    success: true,
    STRIPE_SECRET_KEY:     !!process.env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_SOLO:     !!process.env.STRIPE_PRICE_SOLO,
    STRIPE_PRICE_TEAM:     !!process.env.STRIPE_PRICE_TEAM,
    STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
  });
});

// ============================================================
// STRIPE CHECKOUT SESSION
// ============================================================

app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { email, plan } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'Email required.' });
    if (!plan || !['solo', 'team'].includes(plan)) {
      return res.status(400).json({ success: false, error: 'plan must be "solo" or "team"' });
    }

    const priceId = plan === 'solo' ? process.env.STRIPE_PRICE_SOLO : process.env.STRIPE_PRICE_TEAM;
    if (!priceId) return res.status(500).json({ success: false, error: `STRIPE_PRICE_${plan.toUpperCase()} not configured` });

    const seatLimit = plan === 'solo' ? 1 : 3;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: 'https://tryautopost.com/success',
      cancel_url: 'https://tryautopost.com/pricing',
      metadata: { email, plan, seatLimit: String(seatLimit) },
      subscription_data: { metadata: { email, plan, seatLimit: String(seatLimit) } },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('/api/stripe/create-checkout-session error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// STRIPE WEBHOOK
// ============================================================

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    const email      = meta.email || '';
    const plan       = meta.plan || 'solo';
    const seatLimit  = parseInt(meta.seatLimit || '1', 10);
    const customerId = session.customer;
    const subId      = session.subscription;
    if (!email) { console.error('checkout.session.completed: no email in metadata'); return; }
    await upsertTeamForEmail({ email, plan, seatLimit, customerId, subId, status: 'active', enabled: true });
    return;
  }

  if (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  ) {
    const sub = event.data.object;
    const meta = sub.metadata || {};
    const email = meta.email || '';
    const plan = meta.plan || 'solo';
    const seatLimit = parseInt(meta.seatLimit || '1', 10);
    const customerId = sub.customer;
    const subId = sub.id;
    const status = sub.status;
    const enabled = isSubscriptionActive(status);
    if (!email) return;
    await upsertTeamForEmail({ email, plan, seatLimit, customerId, subId, status, enabled });
    return;
  }

  if (type === 'invoice.paid') {
    const subId = event.data.object.subscription;
    if (!subId) return;
    await db.query(
      `UPDATE teams SET subscription_status = 'active', extension_enabled = true, updated_at = NOW() WHERE stripe_subscription_id = $1`,
      [subId]
    );
    return;
  }

  if (type === 'invoice.payment_failed') {
    const subId = event.data.object.subscription;
    if (!subId) return;
    await db.query(
      `UPDATE teams SET subscription_status = 'past_due', extension_enabled = false, updated_at = NOW() WHERE stripe_subscription_id = $1`,
      [subId]
    );
    return;
  }
}

async function upsertTeamForEmail({ email, plan, seatLimit, customerId, subId, status, enabled }) {
  const normalizedEmail = email.toLowerCase();

  const userRes = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (userRes.rows.length === 0) {
    console.warn('upsertTeamForEmail: no user found for email', email);
    return;
  }

  const userId = userRes.rows[0].id;

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
    [normalizedEmail, plan, seatLimit, customerId, subId, status, enabled]
  );

  const teamId = teamRes.rows[0].id;

  await db.query('UPDATE users SET team_id = $1 WHERE id = $2', [teamId, userId]);

  await db.query(
    `INSERT INTO team_members (team_id, clerk_id, email, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (clerk_id) DO UPDATE SET team_id = EXCLUDED.team_id, email = EXCLUDED.email`,
    [teamId, normalizedEmail, normalizedEmail]
  );
}

// ============================================================
// EXTENSION ACCESS CHECK
// ============================================================

app.get('/api/extension/access', async (req, res) => {
  try {
    const { clerkUserId } = await requireClerkAuth(req).catch(e => { throw Object.assign(e, { status: 401 }); });
    const result = await db.query(
      `SELECT tm.role, tm.email, t.plan, t.seat_limit, t.subscription_status, t.extension_enabled,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS seats_used
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.clerk_id = $1`,
      [clerkUserId]
    );
    if (result.rows.length === 0) {
      return res.json({ allowed: false, status: 'no_subscription', plan: null, seatLimit: 0, seatsUsed: 0, role: null, extensionEnabled: false });
    }
    const row = result.rows[0];
    const allowed = row.extension_enabled && isSubscriptionActive(row.subscription_status);
    res.json({ allowed, status: row.subscription_status, plan: row.plan, seatLimit: row.seat_limit, seatsUsed: parseInt(row.seats_used, 10), role: row.role, extensionEnabled: row.extension_enabled });
  } catch (err) {
    res.status(err.status || 500).json({ allowed: false, error: err.message });
  }
});

// ============================================================
// TEAM MEMBER MANAGEMENT
// ============================================================

app.post('/api/team/add-member', async (req, res) => {
  try {
    const { clerkUserId } = await requireClerkAuth(req).catch(e => { throw Object.assign(e, { status: 401 }); });
    const { memberEmail } = req.body || {};
    if (!memberEmail) return res.status(400).json({ success: false, error: 'memberEmail required' });

    const ownerCheck = await db.query(
      `SELECT t.id, t.seat_limit, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS seats_used
       FROM teams t JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.clerk_id = $1 AND tm.role = 'owner'`,
      [clerkUserId]
    );
    if (ownerCheck.rows.length === 0) return res.status(403).json({ success: false, error: 'Only the team owner can add members.' });

    const { id: teamId, seat_limit, seats_used } = ownerCheck.rows[0];
    if (parseInt(seats_used, 10) >= parseInt(seat_limit, 10)) {
      return res.status(400).json({ success: false, error: `Seat limit (${seat_limit}) reached.` });
    }

    const normalizedMember = memberEmail.toLowerCase();
    const memberUser = await db.query('SELECT id FROM users WHERE email = $1', [normalizedMember]);
    if (memberUser.rows.length === 0) return res.status(404).json({ success: false, error: 'That email has no AutoPost account yet.' });

    const existing = await db.query('SELECT id FROM team_members WHERE clerk_id = $1', [normalizedMember]);
    if (existing.rows.length > 0) return res.status(400).json({ success: false, error: 'That user already belongs to a team.' });

    await db.query(`INSERT INTO team_members (team_id, clerk_id, email, role) VALUES ($1, $2, $3, 'member')`, [teamId, normalizedMember, normalizedMember]);
    await db.query('UPDATE users SET team_id = $1 WHERE email = $2', [teamId, normalizedMember]);

    res.json({ success: true, message: `${memberEmail} added to your team.` });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

app.get('/api/team/members', async (req, res) => {
  try {
    const { clerkUserId } = await requireClerkAuth(req).catch(e => { throw Object.assign(e, { status: 401 }); });
    const result = await db.query(
      `SELECT tm2.clerk_id, tm2.email, tm2.role, tm2.created_at
       FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN team_members tm2 ON tm2.team_id = t.id
       WHERE tm.clerk_id = $1 ORDER BY tm2.created_at`,
      [clerkUserId]
    );
    res.json({ success: true, members: result.rows });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', (req, res) => res.json({ ok: true, version: '3.12' }));

app.listen(PORT, () => console.log(`AutoPost server listening on port ${PORT}`));

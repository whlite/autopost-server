const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { Pool } = require('pg');
const Stripe = require('stripe');
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');
const createTeams = require('./teams');
const createNotify = require('./notify');
const createOperator = require('./operator');
const createProspecting = require('./prospecting');

const app = express();

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY ||
  process.env.CLAUDE_API_KEY ||
  process.env.ANTHROPIC_KEY ||
  process.env.CLAUDE_KEY;
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'temporary-autopost-session-secret-change-this-in-railway-very-long-2026';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_SOLO = process.env.STRIPE_PRICE_SOLO || '';
const STRIPE_PRICE_TEAM = process.env.STRIPE_PRICE_TEAM || '';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://tryautopost.com').replace(/\/$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
// v4.19: Owner-controlled manual access allowlist. Comma-separated emails set in
// Railway (MANUAL_ACTIVE_EMAILS) are granted active access on sign-in even with
// no Stripe record. No secret or DB console required: set the env var and the
// user is in on their next connect.
const MANUAL_ACTIVE_EMAILS = String(process.env.MANUAL_ACTIVE_EMAILS || '')
  .split(',').map(function(e){ return e.trim().toLowerCase(); }).filter(Boolean);

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Neon needs TLS; a local test database does not have it.
      ssl: (DATABASE_URL.includes('@localhost') || DATABASE_URL.includes('@127.0.0.1')) ? false : { rejectUnauthorized: false }
    })
  : null;

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const loginAttempts = new Map();

console.log('AutoPost booting...');
console.log('DATABASE_URL loaded:', !!DATABASE_URL);
console.log('AI key loaded:', !!ANTHROPIC_API_KEY);
console.log('SESSION_SECRET loaded:', !!SESSION_SECRET);
console.log('CLERK_SECRET_KEY loaded:', !!process.env.CLERK_SECRET_KEY);
console.log('CLERK_PUBLISHABLE_KEY loaded:', !!process.env.CLERK_PUBLISHABLE_KEY);
console.log('STRIPE_SECRET_KEY loaded:', !!STRIPE_SECRET_KEY);
console.log('STRIPE_WEBHOOK_SECRET loaded:', !!STRIPE_WEBHOOK_SECRET);
console.log('STRIPE_PRICE_SOLO loaded:', !!STRIPE_PRICE_SOLO);
console.log('STRIPE_PRICE_TEAM loaded:', !!STRIPE_PRICE_TEAM);
console.log('ADMIN_SECRET loaded:', !!ADMIN_SECRET);
console.log('PORT:', PORT);

function now() {
  return Date.now();
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function safeEqual(a, b) {
  const aString = String(a || '');
  const bString = String(b || '');
  const aBuf = Buffer.from(aString);
  const bBuf = Buffer.from(bString);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function hashPassword(password, salt) {
  return crypto
    .createHash('sha256')
    .update(String(salt || '') + ':' + String(password || ''))
    .digest('hex');
}

function verifyPassword(password, salt, storedHash) {
  if (!salt || !storedHash) return false;
  const incoming = hashPassword(password, salt);
  return safeEqual(incoming, storedHash);
}

function rateLimitLogin(email, ip) {
  const key = `${ip}:${normalizeEmail(email)}`;
  const existing = loginAttempts.get(key) || { count: 0, firstAttempt: now() };
  const windowMs = 1000 * 60 * 10;
  if (now() - existing.firstAttempt > windowMs) {
    loginAttempts.set(key, { count: 1, firstAttempt: now() });
    return { allowed: true };
  }
  existing.count += 1;
  loginAttempts.set(key, existing);
  if (existing.count > 10) {
    return { allowed: false, error: 'Too many login attempts. Try again later.' };
  }
  return { allowed: true };
}

function createSessionToken(payload) {
  const session = {
    clerkUserId: String(payload.clerkUserId || ''),
    email: normalizeEmail(payload.email),
    deviceId: String(payload.deviceId || ''),
    issuedAt: now(),
    expiresAt: now() + SESSION_TTL_MS
  };
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, error: 'Missing token' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, error: 'Invalid token format' };
  const [body, sig] = parts;
  if (!body || !sig) return { valid: false, error: 'Invalid token format' };
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expectedSig)) return { valid: false, error: 'Invalid token signature' };
  let session;
  try {
    session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return { valid: false, error: 'Invalid token body' };
  }
  if (!session.expiresAt || now() > session.expiresAt) {
    return { valid: false, error: 'Session expired' };
  }
  return { valid: true, session };
}

function isAllowedStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'active' || s === 'trialing';
}

// Owner-granted free access (MANUAL_ACTIVE_EMAILS in Railway). This is the ONLY
// way to use the extension without a Stripe subscription, and it takes a
// deliberate env-var edit — never a side effect of signing in.
function isManualActiveEmail(email) {
  const e = normalizeEmail(email);
  return !!e && MANUAL_ACTIVE_EMAILS.indexOf(e) !== -1;
}

function planMeta(plan) {
  if (plan === 'team') return { plan: 'team', seatLimit: 3, priceId: STRIPE_PRICE_TEAM };
  return { plan: 'solo', seatLimit: 1, priceId: STRIPE_PRICE_SOLO };
}

function publicUser(user) {
  // Handles JWT verified shape { valid, session: { clerkUserId, email } }
  // and legacy DB row shape { email, clerk_user_id, subscription_status, ... }
  const s = (user && user.session) || {};
  const email = s.email || user.email || '';
  const clerkUserId = s.clerkUserId || user.clerk_user_id || '';
  const subscriptionStatus = String(s.subscriptionStatus || user.subscription_status || 'inactive').toLowerCase();
  return {
    username: email,
    email: email,
    clerkUserId: clerkUserId,
    active: isAllowedStatus(subscriptionStatus) && user.extension_enabled !== false,
    plan: s.plan || user.plan || 'solo',
    subscriptionStatus: subscriptionStatus,
    deviceLimit: user.seat_limit || 1
  };
}

// AutoPost Teams (ap_* namespace). Additive only — the billing tables below and
// every existing route behave exactly as they did before. A Solo user's requests
// pass through one indexed SELECT that returns zero rows.
const teams = createTeams({
  pool,
  verifySessionToken,
  getAuth,
  normalizeEmail,
  safeEqual,
  adminSecret: ADMIN_SECRET
});

// Signup alerts (ap_leads namespace). Records every new dealership and texts /
// emails the owner on a repeating timer until it is explicitly acknowledged.
// Additive and isolated: every failure inside it is logged and swallowed, so it
// can never stop a sign-in, a checkout, or a post.
const notify = createNotify({
  pool,
  safeEqual,
  adminSecret: ADMIN_SECRET
});

// Owner maintenance routes (billing reconcile, schema view). They run inside
// Railway so production secrets never leave it. Operator-key protected.
const operator = createOperator({ pool, stripe });

// Outbound prospecting engine (px_* namespace). Boots paused with every agent
// off; a failure inside it never affects sign-in, checkout or posting.
const prospecting = createProspecting({ pool, getAuth, clerkClient, operator });

async function initDb() {
  if (!pool) {
    console.log('Database not configured.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS autopost_users (
      id SERIAL PRIMARY KEY,
      clerk_user_id TEXT UNIQUE,
      email TEXT UNIQUE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'inactive',
      current_period_end TIMESTAMPTZ,
      extension_enabled BOOLEAN DEFAULT TRUE,
      plan TEXT DEFAULT 'solo',
      seat_limit INTEGER DEFAULT 1,
      password_salt TEXT,
      password_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE autopost_users ADD COLUMN IF NOT EXISTS seat_limit INTEGER DEFAULT 1;`);
  await pool.query(`ALTER TABLE autopost_users ADD COLUMN IF NOT EXISTS password_salt TEXT;`);
  await pool.query(`ALTER TABLE autopost_users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS autopost_teams (
      id SERIAL PRIMARY KEY,
      owner_clerk_user_id TEXT UNIQUE,
      owner_email TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'solo',
      seat_limit INTEGER DEFAULT 1,
      subscription_status TEXT DEFAULT 'inactive',
      extension_enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS autopost_team_members (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES autopost_teams(id) ON DELETE CASCADE,
      clerk_user_id TEXT UNIQUE,
      email TEXT,
      role TEXT DEFAULT 'member',
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('Database ready: Neon tables checked.');

  // Signup-alert schema. Same rule as Teams: a failure here must never stop the
  // server from booting and serving customers.
  try {
    await notify.initSchema();
  } catch (e) {
    console.error('Notify schema error (server continues):', e.message);
  }

  // Teams schema is created after the core tables and is independent of them.
  // A failure here must never stop the server from booting and serving Solo.
  try {
    await teams.initTeamsSchema();
  } catch (e) {
    console.error('Teams schema init failed (Solo unaffected):', e.message);
  }

  // Prospecting migrations. Same rule: never blocks boot.
  await prospecting.init();
}

async function findAccessByEmail(email) {
  if (!pool) return null;
  const normalized = normalizeEmail(email);
  const result = await pool.query(
    `SELECT * FROM autopost_users WHERE LOWER(email) = $1 LIMIT 1`,
    [normalized]
  );
  return result.rows[0] || null;
}

async function findAccessByClerkUserId(clerkUserId) {
  if (!pool || !clerkUserId) return null;

  const userResult = await pool.query(
    `SELECT * FROM autopost_users WHERE clerk_user_id = $1 LIMIT 1`,
    [clerkUserId]
  );
  if (userResult.rows[0]) return userResult.rows[0];

  const teamResult = await pool.query(
    `SELECT
       tm.clerk_user_id,
       tm.email,
       t.stripe_customer_id,
       t.stripe_subscription_id,
       t.subscription_status,
       NULL::timestamptz AS current_period_end,
       t.extension_enabled,
       t.plan,
       t.seat_limit,
       tm.role
     FROM autopost_team_members tm
     JOIN autopost_teams t ON t.id = tm.team_id
     WHERE tm.clerk_user_id = $1
       AND tm.status = 'active'
     LIMIT 1`,
    [clerkUserId]
  );
  return teamResult.rows[0] || null;
}

async function findAccessFromSession(session) {
  if (session.clerkUserId) {
    const byClerk = await findAccessByClerkUserId(session.clerkUserId);
    if (byClerk) return byClerk;
  }
  if (session.email) return findAccessByEmail(session.email);
  return null;
}

async function requireActiveSession(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const tokenFromHeader = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const token = tokenFromHeader || (req.body && req.body.token);
    const verified = verifySessionToken(token);

    if (!verified.valid) {
      return res.status(401).json({ success: false, active: false, error: 'Session expired. Please sign in again.' });
    }

    // Check blocklist — add email to BLOCKED_EMAILS env var to deactivate a user
    const blocked = String(process.env.BLOCKED_EMAILS || '').toLowerCase();
    if (blocked && verified.email && blocked.includes(verified.email.toLowerCase())) {
      return res.status(403).json({ success: false, active: false, error: 'Account deactivated. Contact support@tryautopost.com' });
    }

    req.user = verified;

    // The token proves identity for 30 days. Billing state is checked LIVE on every
    // call so a canceled, refunded, past-due or never-paid account loses the
    // extension right away instead of riding an already-issued token.
    if (pool && !isManualActiveEmail(verified.session && verified.session.email)) {
      let account = null;
      try {
        account = await findAccessFromSession(verified.session);
      } catch (dbErr) {
        // Infrastructure fault, not an entitlement answer - do not lock out paying
        // customers over a transient DB blip.
        console.error('requireActiveSession: DB lookup failed, honoring token:', dbErr.message);
        return next();
      }

      if (!account) {
        return res.status(402).json({
          success: false,
          active: false,
          error: 'No subscription found for this account. Subscribe at tryautopost.com to activate the extension.'
        });
      }

      const liveStatus = String(account.subscription_status || 'inactive').toLowerCase();
      if (!isAllowedStatus(liveStatus) || account.extension_enabled === false) {
        return res.status(402).json({
          success: false,
          active: false,
          error: 'Your AutoPost subscription is not active (' + liveStatus + '). Visit tryautopost.com to restore it.'
        });
      }

      req.account = account;
    }

    next();
  } catch (e) {
    return res.status(401).json({ success: false, active: false, error: 'Invalid session.' });
  }
}

async function upsertUserFromSubscription({ clerkUserId, email, stripeCustomerId, stripeSubscriptionId, status, plan, seatLimit, currentPeriodEnd }) {
  const normalizedEmail = normalizeEmail(email);
  if (!pool || !normalizedEmail) {
    console.error('upsertUserFromSubscription: missing pool or email', { hasPool: !!pool, email });
    return;
  }

  await pool.query(
    `INSERT INTO autopost_users (
       clerk_user_id, email, stripe_customer_id, stripe_subscription_id,
       subscription_status, current_period_end, extension_enabled, plan, seat_limit,
       created_at, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,NOW(),NOW())
     ON CONFLICT (email)
     DO UPDATE SET
       clerk_user_id = COALESCE(EXCLUDED.clerk_user_id, autopost_users.clerk_user_id),
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, autopost_users.stripe_customer_id),
       stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, autopost_users.stripe_subscription_id),
       subscription_status = EXCLUDED.subscription_status,
       current_period_end = COALESCE(EXCLUDED.current_period_end, autopost_users.current_period_end),
       extension_enabled = CASE WHEN EXCLUDED.subscription_status IN ('active','trialing') THEN true ELSE false END,
       plan = EXCLUDED.plan,
       seat_limit = EXCLUDED.seat_limit,
       updated_at = NOW()`,
    [clerkUserId || null, normalizedEmail, stripeCustomerId || null, stripeSubscriptionId || null, status || 'inactive', currentPeriodEnd || null, plan || 'solo', seatLimit || 1]
  );

  console.log('upsertUserFromSubscription: updated', normalizedEmail, 'status:', status);

  if (clerkUserId) {
    await pool.query(
      `INSERT INTO autopost_teams (
         owner_clerk_user_id, owner_email, stripe_customer_id, stripe_subscription_id,
         plan, seat_limit, subscription_status, extension_enabled, created_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT (owner_clerk_user_id)
       DO UPDATE SET
         owner_email = EXCLUDED.owner_email,
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, autopost_teams.stripe_customer_id),
         stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, autopost_teams.stripe_subscription_id),
         plan = EXCLUDED.plan,
         seat_limit = EXCLUDED.seat_limit,
         subscription_status = EXCLUDED.subscription_status,
         extension_enabled = EXCLUDED.extension_enabled,
         updated_at = NOW()
       RETURNING id`,
      [clerkUserId, normalizedEmail, stripeCustomerId || null, stripeSubscriptionId || null, plan || 'solo', seatLimit || 1, status || 'inactive', isAllowedStatus(status)]
    );

    const team = await pool.query(`SELECT id FROM autopost_teams WHERE owner_clerk_user_id = $1 LIMIT 1`, [clerkUserId]);
    const teamId = team.rows[0] && team.rows[0].id;
    if (teamId) {
      await pool.query(
        `INSERT INTO autopost_team_members (team_id, clerk_user_id, email, role, status, created_at, updated_at)
         VALUES ($1,$2,$3,'owner','active',NOW(),NOW())
         ON CONFLICT (clerk_user_id)
         DO UPDATE SET team_id = EXCLUDED.team_id, email = EXCLUDED.email, role = 'owner', status = 'active', updated_at = NOW()`,
        [teamId, clerkUserId, normalizedEmail]
      );
    }
  }
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      console.error('Stripe webhook hit but not configured. stripe:', !!stripe, 'secret:', !!STRIPE_WEBHOOK_SECRET);
      return res.status(500).send('Stripe webhook not configured');
    }

    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (sigErr) {
      console.error('Stripe webhook signature verification failed:', sigErr.message);
      return res.status(400).send(`Webhook Error: ${sigErr.message}`);
    }

    console.log('Stripe webhook received:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const plan = session.metadata && session.metadata.plan === 'team' ? 'team' : 'solo';
      const meta = planMeta(plan);
      let subscription = null;
      if (session.subscription) {
        subscription = await stripe.subscriptions.retrieve(session.subscription);
      }
      const resolvedEmail = (session.customer_details && session.customer_details.email) || (session.metadata && session.metadata.email);
      console.log('checkout.session.completed for', resolvedEmail, 'subscription status:', subscription ? subscription.status : 'active (no sub object)');
      await upsertUserFromSubscription({
        clerkUserId: session.metadata && session.metadata.clerkUserId,
        email: resolvedEmail,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        status: subscription ? subscription.status : 'active',
        plan: meta.plan,
        seatLimit: meta.seatLimit,
        currentPeriodEnd: subscription && subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null
      });

      // Alert on the payment itself, so a paid signup reaches you even if the
      // dealer never fills in the setup form. If they do submit it later,
      // captureLead() merges into this same row instead of alerting twice.
      notify.captureLead({
        email: resolvedEmail,
        name: session.customer_details && session.customer_details.name,
        phone: session.customer_details && session.customer_details.phone,
        source: 'stripe',
        notes: 'Paid ' + meta.plan + ' plan. Setup form not submitted yet.'
      }).catch(function (e) { console.error('Notify capture (stripe) error:', e.message); });
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const plan = (sub.metadata && sub.metadata.plan === 'team') ? 'team' : 'solo';
      const meta = planMeta(plan);
      console.log(event.type, 'for', sub.metadata && sub.metadata.email, 'status:', sub.status);
      await upsertUserFromSubscription({
        clerkUserId: sub.metadata && sub.metadata.clerkUserId,
        email: sub.metadata && sub.metadata.email,
        stripeCustomerId: sub.customer,
        stripeSubscriptionId: sub.id,
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        plan: meta.plan,
        seatLimit: meta.seatLimit,
        currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null
      });
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      if (invoice.subscription && pool) {
        await pool.query(
          `UPDATE autopost_users SET subscription_status = 'past_due', extension_enabled = false, updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [invoice.subscription]
        );
        await pool.query(
          `UPDATE autopost_teams SET subscription_status = 'past_due', extension_enabled = false, updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [invoice.subscription]
        );
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(clerkMiddleware());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Operator-Key');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// AutoPost Teams routes. Mounted after express.json + clerkMiddleware + CORS so
// team routes see a parsed body and a resolved Clerk session, and before the 404
// handler at the bottom of this file.
app.use(teams.router);

// Signup alert routes: POST /api/lead, the acknowledgement page, and the Twilio
// inbound-SMS hook. Same middleware position as Teams.
app.use(notify.router);

// Owner maintenance routes. Same middleware position as Teams and Notify.
app.use(operator.router);

// Manager dashboard API (/api/px/*). Clerk admin allowlist or operator key.
app.use(prospecting.router);

app.get('/', (req, res) => {
  res.json({
    status: 'AutoPost server running',
    version: '3.5-ops',
    paywall: 'enforced',
    auth: 'clerk website handoff + neon + stripe',
    googleSheets: false,
    aiConfigured: !!ANTHROPIC_API_KEY,
    clerkLoaded: !!process.env.CLERK_SECRET_KEY,
    databaseLoaded: !!DATABASE_URL,
    stripeLoaded: !!STRIPE_SECRET_KEY
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: '3.5-ops',
    // 'enforced' = this build requires a real subscription before it will issue or
    // honor an extension token. If you ever see this missing or say something else,
    // the old give-it-away build is running.
    paywall: 'enforced',
    time: new Date().toISOString(),
    googleSheets: false,
    aiConfigured: !!ANTHROPIC_API_KEY,
    databaseLoaded: !!DATABASE_URL,
    stripeLoaded: !!STRIPE_SECRET_KEY,
    // Must be true in production. If this is false, Stripe payments never reach the
    // database, which now means PAYING customers get locked out.
    stripeWebhookConfigured: !!STRIPE_WEBHOOK_SECRET,
    manualComps: MANUAL_ACTIVE_EMAILS.length
  });
});

app.get('/api/db-test', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ success: false, error: 'DATABASE_URL is missing' });
    const result = await pool.query('SELECT NOW() AS now');
    return res.json({ success: true, databaseConnected: true, time: result.rows[0].now });
  } catch (e) {
    return res.status(500).json({ success: false, databaseConnected: false, error: e.message });
  }
});

app.get('/api/clerk-test', (req, res) => {
  const auth = getAuth(req);
  return res.json({
    success: true,
    clerkLoaded: !!process.env.CLERK_SECRET_KEY,
    isAuthenticated: !!auth.isAuthenticated,
    userId: auth.userId || null,
    sessionId: auth.sessionId || null
  });
});

app.get('/api/stripe-config-test', (req, res) => {
  return res.json({
    success: true,
    stripeSecretLoaded: !!STRIPE_SECRET_KEY,
    soloPriceLoaded: !!STRIPE_PRICE_SOLO,
    teamPriceLoaded: !!STRIPE_PRICE_TEAM,
    webhookSecretLoaded: !!STRIPE_WEBHOOK_SECRET,
    frontendUrl: FRONTEND_URL
  });
});

app.get('/api/public-config', (req, res) => {
  return res.json({
    success: true,
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '',
    frontendUrl: FRONTEND_URL
  });
});

// Website signup: create account with email + password
app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '').trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    }
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Database not configured.' });
    }

    const existing = await findAccessByEmail(email);
    if (existing && existing.password_hash) {
      return res.status(400).json({ success: false, error: 'An account with that email already exists.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);

    if (existing) {
      // Account exists (e.g. created via webhook) but no password yet — add credentials
      await pool.query(
        `UPDATE autopost_users SET password_salt = $1, password_hash = $2, updated_at = NOW() WHERE LOWER(email) = $3`,
        [salt, hash, email]
      );
    } else {
      await pool.query(
        `INSERT INTO autopost_users
           (email, password_salt, password_hash, subscription_status, extension_enabled, plan, seat_limit, created_at, updated_at)
         VALUES ($1, $2, $3, 'inactive', false, 'solo', 1, NOW(), NOW())`,
        [email, salt, hash]
      );
    }

    return res.json({ success: true, email });
  } catch (e) {
    console.error('Signup error:', e.message);
    return res.status(500).json({ success: false, error: 'Server error during signup.' });
  }
});

app.post('/api/extension/create-token', async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.isAuthenticated || !auth.userId) {
      return res.status(401).json({ success: false, error: 'Please sign in with your AutoPost account.' });
    }

    let verifiedEmail = '';
    try {
      const cu = await clerkClient.users.getUser(auth.userId);
      const list = (cu && cu.emailAddresses) || [];
      const primary = list.find(e => e.id === (cu && cu.primaryEmailAddressId)) || list[0];
      verifiedEmail = normalizeEmail(primary && primary.emailAddress);
    } catch (e) {
      console.error('create-token: Clerk getUser failed:', e.message);
    }

    if (!verifiedEmail) {
      return res.status(400).json({ success: false, error: 'Could not verify your email. Please sign in again.' });
    }

    // Check blocklist — add email to BLOCKED_EMAILS env var to deactivate a user
    const blocked = String(process.env.BLOCKED_EMAILS || '').toLowerCase();
    if (blocked && blocked.includes(verifiedEmail)) {
      return res.status(403).json({ success: false, error: 'Account deactivated. Contact support@tryautopost.com' });
    }

    // PAYWALL. Signing in with Clerk proves WHO you are, not THAT you paid.
    // The subscription row (written by the Stripe webhook or /api/admin/activate)
    // is the only source of truth. This route must never create or activate one.
    if (!pool) {
      console.error('create-token: no DB configured - refusing to issue a token');
      return res.status(503).json({ success: false, error: 'Billing system unavailable. Please try again in a minute.' });
    }

    if (isManualActiveEmail(verifiedEmail)) {
      console.log('create-token: manual allowlist grant for', verifiedEmail);
      return res.json({
        success: true,
        token: createSessionToken({ clerkUserId: auth.userId, email: verifiedEmail, plan: 'solo', subscriptionStatus: 'active' }),
        expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
        user: { email: verifiedEmail, clerkUserId: auth.userId, plan: 'solo', subscriptionStatus: 'active', extensionEnabled: true }
      });
    }

    let account = await findAccessByClerkUserId(auth.userId);
    if (!account) account = await findAccessByEmail(verifiedEmail);

    if (!account) {
      console.log('create-token: DENIED (no subscription record) for', verifiedEmail);
      return res.status(402).json({
        success: false,
        error: 'No subscription found for this account. Subscribe at tryautopost.com to activate the extension.'
      });
    }

    const accountStatus = String(account.subscription_status || 'inactive').toLowerCase();
    if (!isAllowedStatus(accountStatus) || account.extension_enabled === false) {
      console.log('create-token: DENIED (status ' + accountStatus + ') for', verifiedEmail);
      return res.status(402).json({
        success: false,
        error: 'Your AutoPost subscription is not active (' + accountStatus + '). Visit tryautopost.com to start or restore it.'
      });
    }

    // First Clerk sign-in on a record created by the Stripe webhook: link the ids.
    if (!account.clerk_user_id) {
      try {
        await pool.query(
          `UPDATE autopost_users SET clerk_user_id = $1, updated_at = NOW()
           WHERE LOWER(email) = $2 AND clerk_user_id IS NULL`,
          [auth.userId, normalizeEmail(account.email || verifiedEmail)]
        );
      } catch (e) {
        console.error('create-token: could not link clerk_user_id:', e.message);
      }
    }

    const accountPlan = account.plan || 'solo';
    const token = createSessionToken({ clerkUserId: auth.userId, email: verifiedEmail, plan: accountPlan, subscriptionStatus: accountStatus });
    console.log('create-token: granted access to', verifiedEmail, '(status:', accountStatus + ')');

    return res.json({
      success: true,
      token,
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
      user: {
        email: verifiedEmail,
        clerkUserId: auth.userId,
        plan: accountPlan,
        subscriptionStatus: accountStatus,
        extensionEnabled: account.extension_enabled !== false
      }
    });
  } catch (e) {
    console.error('create-token error:', e.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// Create Stripe checkout — works with email/password signup (no Clerk required)
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ success: false, error: 'Stripe is not configured' });

    const requestedPlan = req.body && req.body.plan === 'team' ? 'team' : 'solo';
    const meta = planMeta(requestedPlan);
    if (!meta.priceId) return res.status(500).json({ success: false, error: 'Stripe price is missing for plan.' });

    const email = normalizeEmail((req.body && req.body.email) || '');

    // Try Clerk auth if available, fall back gracefully
    let clerkUserId = null;
    try {
      const auth = getAuth(req);
      if (auth && auth.isAuthenticated && auth.userId) clerkUserId = auth.userId;
    } catch (_) {}

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: meta.priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/#pricing`,
      customer_email: email || undefined,
      metadata: {
        clerkUserId: clerkUserId || '',
        email: email,
        plan: meta.plan,
        seatLimit: String(meta.seatLimit)
      },
      subscription_data: {
        metadata: {
          clerkUserId: clerkUserId || '',
          email: email,
          plan: meta.plan,
          seatLimit: String(meta.seatLimit)
        }
      }
    });

    return res.json({ success: true, url: session.url });
  } catch (e) {
    console.error('Checkout session error:', e.message);
    return res.status(500).json({ success: false, error: 'Could not create checkout session' });
  }
});

// Admin: manually activate / sync a user's subscription (for fixing missed webhooks)
app.post('/api/admin/activate', async (req, res) => {
  try {
    const provided = req.headers['x-admin-secret'] || (req.body && req.body.adminSecret);
    if (!ADMIN_SECRET || !safeEqual(provided, ADMIN_SECRET)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!pool) return res.status(500).json({ success: false, error: 'Database not configured.' });

    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });

    const plan = (req.body && req.body.plan === 'team') ? 'team' : 'solo';
    const meta = planMeta(plan);

    let stripeCustomerId = null;
    let stripeSubscriptionId = null;
    let status = 'active';
    let currentPeriodEnd = null;

    // If Stripe is configured, look up the customer/subscription by email to sync real data
    if (stripe) {
      try {
        const customers = await stripe.customers.list({ email, limit: 1 });
        const customer = customers.data[0];
        if (customer) {
          stripeCustomerId = customer.id;
          const subs = await stripe.subscriptions.list({ customer: customer.id, limit: 1, status: 'all' });
          const sub = subs.data[0];
          if (sub) {
            stripeSubscriptionId = sub.id;
            status = sub.status;
            currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
          }
        }
      } catch (stripeErr) {
        console.error('Admin activate: Stripe lookup failed:', stripeErr.message);
      }
    }

    await upsertUserFromSubscription({
      clerkUserId: null,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      status,
      plan: meta.plan,
      seatLimit: meta.seatLimit,
      currentPeriodEnd
    });

    const user = await findAccessByEmail(email);
    return res.json({ success: true, user: publicUser(user) });
  } catch (e) {
    console.error('Admin activate error:', e.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password, deviceId } = req.body || {};
    const email = normalizeEmail(username);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const limited = rateLimitLogin(email, ip);
    if (!limited.allowed) return res.status(429).json({ success: false, error: limited.error });

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Enter email and password' });
    }

    const user = await findAccessByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Account not found. Create an AutoPost account first.' });
    }

    if (!verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const active = isAllowedStatus(user.subscription_status);
    if (!active) {
      return res.status(403).json({ success: false, error: 'No active subscription. Visit tryautopost.com to subscribe.' });
    }

    const token = createSessionToken({
      clerkUserId: user.clerk_user_id || '',
      email: user.email,
      deviceId
    });

    return res.json({
      success: true,
      token,
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
      user: publicUser(user)
    });
  } catch (e) {
    console.error('Login error:', e.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/verify-session', requireActiveSession, async (req, res) => {
  return res.json({ success: true, active: true, user: publicUser(req.account || req.user) });
});

app.post('/logout', (req, res) => {
  return res.json({ success: true });
});

app.get('/api/extension/access', async (req, res) => {
  try {
    let user = null;
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (bearer && bearer.includes('.')) {
      const verified = verifySessionToken(bearer);
      if (verified.valid) user = await findAccessFromSession(verified.session);
    }

    if (!user) {
      const auth = getAuth(req);
      if (auth.isAuthenticated && auth.userId) user = await findAccessByClerkUserId(auth.userId);
    }

    if (!user) {
      return res.status(401).json({ allowed: false, status: 'unauthenticated', error: 'Please sign in.' });
    }

    const status = String(user.subscription_status || 'inactive').toLowerCase();
    const allowed = user.extension_enabled !== false && isAllowedStatus(status);

    return res.json({
      allowed,
      active: allowed,
      status,
      plan: user.plan || 'solo',
      seatLimit: user.seat_limit || 1,
      role: user.role || 'owner',
      extensionEnabled: user.extension_enabled !== false
    });
  } catch (e) {
    console.error('Extension access error:', e.message);
    return res.status(500).json({ allowed: false, status: 'server_error', error: 'Server error' });
  }
});

app.post('/describe', requireActiveSession, async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(501).json({ success: false, error: 'AI description service is not configured' });
    }

    const { vehicle = {}, settings = {} } = req.body || {};
    const extra = String(settings.aiInstructions || '').trim();
    const dealerText = String(vehicle.dealerDescription || '').slice(0, 2000);
    const mileage = vehicle.mileage ? Number(vehicle.mileage).toLocaleString() + ' miles' : '';

    const prompt = `You are writing a Facebook Marketplace car listing. Use this exact format:

2019 Mercedes-Benz GLC 300
- Exterior: Polar White
- Interior: Black
- Drivetrain: AWD 4MATIC
- Transmission: 9-Speed Automatic
- Engine: 2.0L Turbocharged 4-Cylinder
- Mileage: 66,131 miles

DM for more info! We carry Porsche, Mercedes & Audi.

Vehicle title: ${vehicle.title || 'Unknown'}
Exterior color: ${vehicle.color || 'find in dealer text'}
${mileage ? 'Mileage: ' + mileage : ''}

Dealer page text:
${dealerText || 'Not available'}

Rules:
1. First line must be year make model only.
2. Specs must use "- Label: Value".
3. Do not invent colors.
4. Use known vehicle specs only when highly confident.
5. Do not include emojis.
6. After specs, add one blank line.
${extra ? '7. Then add this text exactly:\n' + extra : '7. End with: DM for more info!'}

Write the listing now.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('Anthropic error:', aiRes.status, errText.slice(0, 500));
      return res.status(502).json({ success: false, error: 'AI description failed' });
    }

    const data = await aiRes.json();
    const description = data.content && data.content[0] ? data.content[0].text.trim() : '';
    return res.json({ success: true, description });
  } catch (e) {
    console.error('Describe error:', e.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.use((req, res) => {
  return res.status(404).json({ success: false, error: 'Route not found' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AutoPost running on port ${PORT}`);
      notify.startEscalation();
    });
  })
  .catch((e) => {
    console.error('Database startup error:', e.message);
    process.exit(1);
  });

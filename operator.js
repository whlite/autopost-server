// operator.js — owner-operated maintenance routes (billing reconcile, schema view)
//
// WHY THIS EXISTS
//   Jobs that need production secrets (DATABASE_URL, STRIPE_SECRET_KEY) run HERE,
//   inside Railway, where those secrets already live. Nobody copies a database URL
//   or a Stripe key onto a laptop or into a chat to run a script.
//
// AUTH: an operator key. Only its SHA-256 lives in this (public) repo; the key
//   itself stays on the owner's machine. A 256-bit random key cannot be recovered
//   from its hash. Rotate by generating a new key and replacing the hash (or by
//   setting PX_OPERATOR_KEY_SHA256 in Railway, which wins over the constant).
//
// SAFETY: every route is read-only except reconcile/apply, and apply can only
//   replay the exact actions of a dry run the owner has already reviewed.

const crypto = require('crypto');
const express = require('express');

const DEFAULT_OPERATOR_KEY_SHA256 = '18b14f35725c2c05ee639814e6d7f33cdbd67404d4b144bbf8e8cd3751f6c994';

const PAID_STATUSES = ['active', 'trialing'];
const RUN_TTL_MS = 60 * 60 * 1000;

module.exports = function createOperator(deps) {
  const pool = deps.pool;
  const stripe = deps.stripe;

  const keyHash = String(process.env.PX_OPERATOR_KEY_SHA256 || DEFAULT_OPERATOR_KEY_SHA256).toLowerCase();
  const router = express.Router();

  // ── Auth ──────────────────────────────────────────────────────────────────
  const failures = new Map(); // ip -> { count, since }
  const FAIL_WINDOW_MS = 10 * 60 * 1000;
  const FAIL_LIMIT = 10;

  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  }

  function isOperatorKey(provided) {
    if (!provided || !keyHash) return false;
    const got = crypto.createHash('sha256').update(String(provided)).digest();
    const want = Buffer.from(keyHash, 'hex');
    return want.length === got.length && crypto.timingSafeEqual(got, want);
  }

  function requireOperator(req, res, next) {
    const ip = clientIp(req);
    const f = failures.get(ip);
    if (f && Date.now() - f.since < FAIL_WINDOW_MS && f.count >= FAIL_LIMIT) {
      return res.status(429).json({ success: false, error: 'Too many attempts.' });
    }
    if (!isOperatorKey(req.headers['x-operator-key'])) {
      const cur = (f && Date.now() - f.since < FAIL_WINDOW_MS) ? f : { count: 0, since: Date.now() };
      cur.count++;
      failures.set(ip, cur);
      console.warn('[OPS] rejected operator request', req.method, req.path);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  }

  function requireDb(req, res, next) {
    if (!pool) return res.status(503).json({ success: false, error: 'Database not configured.' });
    next();
  }

  // ── Billing reconcile (same logic as scripts/reconcile-subscriptions.js) ──
  function isPaid(status) {
    return PAID_STATUSES.indexOf(String(status || '').toLowerCase()) !== -1;
  }

  async function findStripeSubscription(email, knownSubscriptionId, knownCustomerId) {
    if (knownSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(knownSubscriptionId);
        if (sub) return sub;
      } catch (e) { /* stale or test-mode id: fall through to the email lookup */ }
    }

    const customers = [];
    if (knownCustomerId) {
      try {
        const c = await stripe.customers.retrieve(knownCustomerId);
        if (c && !c.deleted) customers.push(c);
      } catch (e) { /* ignore */ }
    }
    if (email) {
      const found = await stripe.customers.list({ email: email, limit: 100 });
      for (const c of found.data) {
        if (!customers.some(x => x.id === c.id)) customers.push(c);
      }
    }

    let best = null;
    for (const c of customers) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 });
      for (const sub of subs.data) {
        if (isPaid(sub.status)) return sub;
        if (!best || sub.created > best.created) best = sub;
      }
    }
    return best;
  }

  const runs = new Map(); // runId -> run

  async function executeDryRun(run) {
    const where = run.auditAll ? '' : `WHERE LOWER(subscription_status) IN ('active','trialing')`;
    const { rows } = await pool.query(
      `SELECT email, clerk_user_id, stripe_customer_id, stripe_subscription_id,
              subscription_status, extension_enabled, plan, created_at
         FROM autopost_users ${where} ORDER BY email`
    );
    run.total = rows.length;

    for (const row of rows) {
      const email = row.email;
      const dbStatus = String(row.subscription_status || 'inactive').toLowerCase();
      let sub;
      try {
        sub = await findStripeSubscription(email, row.stripe_subscription_id, row.stripe_customer_id);
      } catch (e) {
        run.summary.error++;
        run.rows.push({ email, verdict: 'ERROR', detail: 'Stripe lookup failed: ' + e.message });
        run.checked++;
        continue;
      }
      run.checked++;

      const stripeStatus = sub ? String(sub.status).toLowerCase() : 'none';
      if (sub && isPaid(stripeStatus)) {
        const needsIds = !row.stripe_subscription_id || !row.stripe_customer_id;
        const needsStatus = dbStatus !== stripeStatus || row.extension_enabled === false;
        if (!needsIds && !needsStatus) {
          run.summary.ok++;
          run.rows.push({ email, verdict: 'OK', detail: stripeStatus });
          continue;
        }
        run.summary.repair++;
        run.rows.push({ email, verdict: 'REPAIR', detail: 'Stripe says ' + stripeStatus + (needsIds ? ', backfilling wiped Stripe ids' : '') });
        run.actions.push({
          kind: 'repair',
          email: email,
          customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id),
          subscriptionId: sub.id,
          status: stripeStatus,
          periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
        });
        continue;
      }

      if (isPaid(dbStatus)) {
        run.summary.revoke++;
        const why = sub ? 'Stripe subscription is ' + stripeStatus : 'no Stripe subscription (never paid)';
        run.rows.push({ email, verdict: 'REVOKE', detail: 'DB says ' + dbStatus + ' but ' + why, signedUp: row.created_at });
        run.actions.push({ kind: 'revoke', email: email, status: sub ? stripeStatus : 'inactive' });
      } else {
        run.summary.ok++;
        run.rows.push({ email, verdict: 'OK', detail: 'inactive in both' });
      }
    }
  }

  async function applyActions(actions) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const a of actions) {
        if (a.kind === 'repair') {
          await client.query(
            `UPDATE autopost_users
                SET stripe_customer_id = $2, stripe_subscription_id = $3, subscription_status = $4,
                    extension_enabled = true, current_period_end = $5, updated_at = NOW()
              WHERE LOWER(email) = LOWER($1)`,
            [a.email, a.customerId, a.subscriptionId, a.status, a.periodEnd]
          );
          await client.query(
            `UPDATE autopost_teams
                SET stripe_customer_id = $2, stripe_subscription_id = $3,
                    subscription_status = $4, extension_enabled = true, updated_at = NOW()
              WHERE LOWER(owner_email) = LOWER($1)`,
            [a.email, a.customerId, a.subscriptionId, a.status]
          );
        } else {
          await client.query(
            `UPDATE autopost_users SET subscription_status = $2, extension_enabled = false, updated_at = NOW()
              WHERE LOWER(email) = LOWER($1)`,
            [a.email, a.status]
          );
          await client.query(
            `UPDATE autopost_teams SET subscription_status = $2, extension_enabled = false, updated_at = NOW()
              WHERE LOWER(owner_email) = LOWER($1)`,
            [a.email, a.status]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(function () {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  router.get('/api/ops/whoami', requireOperator, function (req, res) {
    res.json({ success: true, operator: true, db: !!pool, stripe: !!stripe });
  });

  // Table names, columns and row counts. No row data.
  router.get('/api/ops/schema', requireOperator, requireDb, async function (req, res) {
    try {
      const cols = await pool.query(
        `SELECT table_name, column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position`
      );
      const counts = await pool.query(
        `SELECT relname AS table_name, n_live_tup::bigint AS approx_rows
           FROM pg_stat_user_tables ORDER BY relname`
      );
      const tables = {};
      for (const c of cols.rows) {
        (tables[c.table_name] = tables[c.table_name] || { columns: [] }).columns.push(
          c.column_name + ' ' + c.data_type + (c.is_nullable === 'NO' ? ' not null' : '')
        );
      }
      for (const r of counts.rows) {
        if (tables[r.table_name]) tables[r.table_name].approxRows = Number(r.approx_rows);
      }
      res.json({ success: true, tables });
    } catch (e) {
      console.error('[OPS] schema error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Billing state at a glance: how many rows per status, and how many lack Stripe ids.
  router.get('/api/ops/billing-summary', requireOperator, requireDb, async function (req, res) {
    try {
      const { rows } = await pool.query(
        `SELECT LOWER(COALESCE(subscription_status,'inactive')) AS status,
                COUNT(*)::int AS accounts,
                COUNT(*) FILTER (WHERE stripe_subscription_id IS NULL)::int AS missing_stripe_ids,
                COUNT(*) FILTER (WHERE extension_enabled)::int AS extension_enabled
           FROM autopost_users GROUP BY 1 ORDER BY 2 DESC`
      );
      res.json({ success: true, byStatus: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/api/ops/reconcile/start', requireOperator, requireDb, function (req, res) {
    if (!stripe) return res.status(503).json({ success: false, error: 'Stripe not configured.' });
    const run = {
      id: crypto.randomBytes(8).toString('hex'),
      startedAt: Date.now(),
      finishedAt: null,
      state: 'running',
      auditAll: !!(req.body && req.body.auditAll),
      total: 0,
      checked: 0,
      summary: { ok: 0, repair: 0, revoke: 0, error: 0 },
      rows: [],
      actions: [],
      appliedAt: null,
      error: null
    };
    runs.set(run.id, run);
    executeDryRun(run)
      .then(function () { run.state = 'done'; run.finishedAt = Date.now(); })
      .catch(function (e) { run.state = 'failed'; run.error = e.message; run.finishedAt = Date.now(); });
    console.log('[OPS] reconcile dry run started', run.id);
    res.json({ success: true, runId: run.id });
  });

  router.get('/api/ops/reconcile/:runId', requireOperator, function (req, res) {
    const run = runs.get(req.params.runId);
    if (!run) return res.status(404).json({ success: false, error: 'Unknown run (runs live in memory and reset on deploy).' });
    res.json({
      success: true,
      id: run.id, state: run.state, total: run.total, checked: run.checked,
      summary: run.summary, rows: run.rows, error: run.error,
      appliedAt: run.appliedAt, actionCount: run.actions.length
    });
  });

  // Applies exactly the actions computed by a finished dry run. `keep` lists emails
  // to leave untouched; `confirm` must restate the counts being applied.
  router.post('/api/ops/reconcile/:runId/apply', requireOperator, requireDb, async function (req, res) {
    const run = runs.get(req.params.runId);
    if (!run) return res.status(404).json({ success: false, error: 'Unknown run.' });
    if (run.state !== 'done') return res.status(409).json({ success: false, error: 'Dry run is ' + run.state + '.' });
    if (run.appliedAt) return res.status(409).json({ success: false, error: 'This run was already applied.' });
    if (Date.now() - run.finishedAt > RUN_TTL_MS) {
      return res.status(409).json({ success: false, error: 'Dry run is over an hour old. Start a fresh one.' });
    }

    const keep = ((req.body && req.body.keep) || []).map(function (e) { return String(e).toLowerCase(); });
    const actions = run.actions.filter(function (a) { return keep.indexOf(String(a.email).toLowerCase()) === -1; });
    const repair = actions.filter(function (a) { return a.kind === 'repair'; }).length;
    const revoke = actions.length - repair;
    const expected = 'repair ' + repair + ' revoke ' + revoke;
    if (String((req.body && req.body.confirm) || '').toLowerCase() !== expected) {
      return res.status(400).json({ success: false, error: 'Confirmation mismatch.', expectedConfirm: expected });
    }

    try {
      await applyActions(actions);
      run.appliedAt = Date.now();
      console.log('[OPS] reconcile applied', run.id, expected, 'kept', keep.length);
      res.json({ success: true, applied: { repair, revoke }, kept: keep });
    } catch (e) {
      console.error('[OPS] reconcile apply failed (rolled back):', e.message);
      res.status(500).json({ success: false, error: 'Apply failed and was rolled back: ' + e.message });
    }
  });

  return { router, requireOperator, isOperatorKey };
};

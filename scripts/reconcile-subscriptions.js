#!/usr/bin/env node
/**
 * reconcile-subscriptions.js
 *
 * Cleanup for the "free extension access" bug:
 *   /api/extension/create-token used to upsert every signed-in Clerk user as
 *   subscription_status = 'active' with no Stripe ids. That did two things:
 *     1. created ACTIVE rows for people who never paid
 *     2. NULLed the stripe ids on rows of people who DID pay (the upsert wrote
 *        EXCLUDED.stripe_customer_id = null over the real value)
 *
 * So a missing stripe id does not by itself mean "freeloader" — Stripe is the
 * only way to tell the two apart. This script asks Stripe about every account
 * the DB currently treats as paid, then:
 *   - REPAIR    : real subscription found -> backfill customer/subscription id + true status
 *   - REVOKE    : no subscription in Stripe -> mark inactive, disable extension
 *   - OK        : DB already matches Stripe
 *
 * Usage (from the autopost-server directory, with DATABASE_URL and
 * STRIPE_SECRET_KEY set — copy them out of the Railway variables tab):
 *
 *   node scripts/reconcile-subscriptions.js            # dry run, changes nothing
 *   node scripts/reconcile-subscriptions.js --apply    # actually write the fixes
 *   node scripts/reconcile-subscriptions.js --all      # also audit inactive rows
 */

const { Pool } = require('pg');
const Stripe = require('stripe');

const APPLY = process.argv.includes('--apply');
const AUDIT_ALL = process.argv.includes('--all');

const DATABASE_URL = process.env.DATABASE_URL;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy it from Railway -> Variables.');
  process.exit(1);
}
if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is not set. Copy it from Railway -> Variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});
const stripe = new Stripe(STRIPE_SECRET_KEY);

const PAID_STATUSES = ['active', 'trialing'];

function isPaid(status) {
  return PAID_STATUSES.indexOf(String(status || '').toLowerCase()) !== -1;
}

// Best subscription for this account: prefer a live one, otherwise the most
// recent so we can report why it is not live (canceled / past_due / unpaid).
async function findStripeSubscription(email, knownSubscriptionId, knownCustomerId) {
  if (knownSubscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(knownSubscriptionId);
      if (sub) return sub;
    } catch (e) {
      // fall through to the email lookup — the id may be stale or from test mode
    }
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

async function main() {
  const where = AUDIT_ALL ? '' : `WHERE LOWER(subscription_status) IN ('active','trialing')`;
  const { rows } = await pool.query(
    `SELECT email, clerk_user_id, stripe_customer_id, stripe_subscription_id,
            subscription_status, extension_enabled, plan
       FROM autopost_users
       ${where}
      ORDER BY email`
  );

  console.log(`\n${APPLY ? 'APPLYING FIXES' : 'DRY RUN (nothing will be written)'}`);
  console.log(`Checking ${rows.length} account(s) against Stripe...\n`);

  const summary = { ok: 0, repair: 0, revoke: 0, error: 0 };
  const actions = [];

  for (const row of rows) {
    const email = row.email;
    let sub;
    try {
      sub = await findStripeSubscription(email, row.stripe_subscription_id, row.stripe_customer_id);
    } catch (e) {
      summary.error++;
      console.log(`ERROR  ${email} — Stripe lookup failed: ${e.message}`);
      continue;
    }

    const stripeStatus = sub ? String(sub.status).toLowerCase() : 'none';
    const dbStatus = String(row.subscription_status || 'inactive').toLowerCase();

    if (sub && isPaid(stripeStatus)) {
      const needsIds = !row.stripe_subscription_id || !row.stripe_customer_id;
      const needsStatus = dbStatus !== stripeStatus || row.extension_enabled === false;
      if (!needsIds && !needsStatus) {
        summary.ok++;
        console.log(`OK     ${email} — ${stripeStatus}`);
        continue;
      }
      summary.repair++;
      console.log(`REPAIR ${email} — Stripe says ${stripeStatus}${needsIds ? ' (backfilling wiped stripe ids)' : ''}`);
      actions.push({
        kind: 'repair',
        email: email,
        sql: `UPDATE autopost_users
                 SET stripe_customer_id = $2,
                     stripe_subscription_id = $3,
                     subscription_status = $4,
                     extension_enabled = true,
                     current_period_end = $5,
                     updated_at = NOW()
               WHERE LOWER(email) = LOWER($1)`,
        params: [
          email,
          typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id),
          sub.id,
          stripeStatus,
          sub.current_period_end ? new Date(sub.current_period_end * 1000) : null
        ]
      });
      continue;
    }

    // No live subscription in Stripe. If the DB says paid, that row is the bug.
    if (isPaid(dbStatus)) {
      summary.revoke++;
      const why = sub ? `Stripe subscription is ${stripeStatus}` : 'no Stripe subscription at all (never paid)';
      console.log(`REVOKE ${email} — DB says ${dbStatus} but ${why}`);
      actions.push({
        kind: 'revoke',
        email: email,
        sql: `UPDATE autopost_users
                 SET subscription_status = $2,
                     extension_enabled = false,
                     updated_at = NOW()
               WHERE LOWER(email) = LOWER($1)`,
        params: [email, sub ? stripeStatus : 'inactive']
      });
    } else {
      summary.ok++;
      console.log(`OK     ${email} — inactive in both`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`  already correct : ${summary.ok}`);
  console.log(`  to repair       : ${summary.repair}  (real customers, ids/status restored)`);
  console.log(`  to revoke       : ${summary.revoke}  (free accounts the bug activated)`);
  if (summary.error) console.log(`  lookup errors   : ${summary.error}`);

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to write these ${actions.length} change(s).\n`);
    await pool.end();
    return;
  }

  for (const a of actions) {
    await pool.query(a.sql, a.params);
    // Keep the mirrored teams row in step with the user row.
    if (a.kind === 'revoke') {
      await pool.query(
        `UPDATE autopost_teams
            SET subscription_status = $2, extension_enabled = false, updated_at = NOW()
          WHERE LOWER(owner_email) = LOWER($1)`,
        [a.email, a.params[1]]
      );
    } else {
      await pool.query(
        `UPDATE autopost_teams
            SET stripe_customer_id = $2, stripe_subscription_id = $3,
                subscription_status = $4, extension_enabled = true, updated_at = NOW()
          WHERE LOWER(owner_email) = LOWER($1)`,
        [a.email, a.params[1], a.params[2], a.params[3]]
      );
    }
    console.log(`applied ${a.kind}: ${a.email}`);
  }

  console.log(`\nDone. ${actions.length} account(s) updated.\n`);
  await pool.end();
}

main().catch(e => {
  console.error('Reconcile failed:', e);
  process.exit(1);
});

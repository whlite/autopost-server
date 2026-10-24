// prospecting/api.js — manager dashboard API (/api/px/*) and operator imports
//
// Every route here is behind requirePxAdmin. Numbers come straight from the
// database; nothing is estimated or padded. Where there is no data the response
// says so (null / 0) and the dashboard renders "No data yet".

const express = require('express');
const stateMachine = require('./state');
const suppression = require('./suppression');
const { importDealerBatch, markSupportedDealers } = require('./discovery');
const { normalizeWebsite } = require('./domain');

const PAGE_SIZE = 50;

function int(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

module.exports = function createApi(deps) {
  const { pool, settings, clerkClient, requirePxAdmin, adminCache } = deps;
  const router = express.Router();

  function fail(res, e, where) {
    if (e && e.code === 'BAD_TRANSITION') return res.status(409).json({ success: false, error: e.message });
    console.error('[PX] ' + where + ':', e && e.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }

  async function audit(actor, action, targetType, targetId, detail) {
    await pool.query(
      `INSERT INTO px_audit (actor, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5)`,
      [actor, action, targetType, targetId == null ? null : String(targetId), detail ? JSON.stringify(detail) : null]
    );
  }

  router.use('/api/px', requirePxAdmin);

  router.get('/api/px/me', function (req, res) {
    res.json({ success: true, actor: req.pxActor });
  });

  // ── Overview ──────────────────────────────────────────────────────────────
  router.get('/api/px/overview', async function (req, res) {
    try {
      const m = (await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM px_dealerships)::int AS dealerships,
          (SELECT COUNT(*) FROM px_dealerships WHERE platform_checked_at IS NOT NULL)::int AS dealerships_researched,
          (SELECT COUNT(*) FROM px_dealerships WHERE status = 'QUALIFIED')::int AS dealerships_qualified,
          (SELECT COUNT(*) FROM px_contacts)::int AS prospects,
          (SELECT COUNT(*) FROM px_contacts WHERE email_status = 'valid')::int AS verified,
          (SELECT COUNT(*) FROM px_contacts WHERE outreach_eligible)::int AS eligible,
          (SELECT COUNT(*) FROM px_enrollments WHERE status = 'queued')::int AS queued,
          (SELECT COUNT(*) FROM px_outbound_messages WHERE sent_at IS NOT NULL)::int AS sent,
          (SELECT COUNT(*) FROM px_outbound_messages WHERE status = 'bounced')::int AS bounced,
          (SELECT COUNT(DISTINCT contact_id) FROM px_outbound_messages WHERE sent_at IS NOT NULL)::int AS contacted,
          (SELECT COUNT(DISTINCT contact_id) FROM px_inbound_messages WHERE contact_id IS NOT NULL)::int AS repliers,
          (SELECT COUNT(*) FROM px_contacts WHERE state IN ('INTERESTED','DEMO_REQUESTED','FOLLOW_UP_REQUIRED'))::int AS positive,
          (SELECT COUNT(*) FROM px_contacts WHERE score_band = 'HOT' AND state NOT IN ('CUSTOMER','UNSUBSCRIBED','SUPPRESSED','NOT_INTERESTED'))::int AS hot,
          (SELECT COUNT(*) FROM px_contacts WHERE state = 'DEMO_REQUESTED')::int AS demos,
          (SELECT COUNT(DISTINCT COALESCE(stripe_subscription_id, 'contact:' || contact_id::text))
             FROM px_attribution WHERE event = 'subscribed')::int AS subscriptions,
          (SELECT COALESCE(SUM(a.amount_cents),0) FROM px_attribution a
            WHERE a.event = 'subscribed'
              AND NOT EXISTS (SELECT 1 FROM px_attribution c WHERE c.event = 'canceled'
                                AND c.stripe_subscription_id = a.stripe_subscription_id))::int AS outbound_mrr_cents,
          (SELECT COUNT(*) FROM autopost_users WHERE LOWER(COALESCE(subscription_status,'')) IN ('active','trialing'))::int AS all_active_subscriptions,
          (SELECT COUNT(*) FROM px_job_runs WHERE ok = FALSE AND started_at > NOW() - INTERVAL '24 hours')::int AS errors_24h,
          (SELECT MAX(finished_at) FROM px_job_runs WHERE ok) AS last_successful_run
      `)).rows[0];

      const costs = (await pool.query(`
        SELECT category, SUM(cost_cents)::float AS cents
          FROM px_costs WHERE created_at >= date_trunc('month', NOW()) GROUP BY category`)).rows;
      const allTime = (await pool.query(`SELECT COALESCE(SUM(cost_cents),0)::float AS cents FROM px_costs`)).rows[0].cents;

      const monthByCat = {};
      let monthTotal = 0;
      for (const c of costs) { monthByCat[c.category] = c.cents; monthTotal += c.cents; }

      const s = await settings.all();
      res.json({
        success: true,
        metrics: m,
        replyRate: m.contacted ? m.repliers / m.contacted : null,
        bounceRate: m.sent ? m.bounced / m.sent : null,
        costs: {
          monthToDateCents: monthTotal,
          byCategoryCents: monthByCat,
          allTimeCents: allTime,
          budgetMonthlyCents: s.budget_monthly_cents
        },
        cacCents: m.subscriptions ? Math.round(allTime / m.subscriptions) : null,
        paused: !!s.global_pause
      });
    } catch (e) { fail(res, e, 'overview'); }
  });

  // ── Live feed ─────────────────────────────────────────────────────────────
  router.get('/api/px/events', async function (req, res) {
    try {
      const after = int(req.query.after, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = int(req.query.limit, 100, 1, 300);
      const { rows } = await pool.query(
        `SELECT e.id, e.event_type, e.from_state, e.to_state, e.actor, e.detail, e.created_at,
                c.full_name AS contact_name, d.name AS dealership_name, d.state AS dealership_state
           FROM px_events e
           LEFT JOIN px_contacts c ON c.id = e.contact_id
           LEFT JOIN px_dealerships d ON d.id = COALESCE(e.dealership_id, c.dealership_id)
          WHERE e.id > $1
          ORDER BY e.id DESC LIMIT $2`,
        [after, limit]
      );
      res.json({ success: true, events: rows });
    } catch (e) { fail(res, e, 'events'); }
  });

  // ── Leads ─────────────────────────────────────────────────────────────────
  router.get('/api/px/leads', async function (req, res) {
    try {
      const where = [];
      const args = [];
      function add(sql, v) { args.push(v); where.push(sql.split('?').join('$' + args.length)); }
      if (req.query.q) add(`(c.full_name ILIKE ? OR c.email ILIKE ? OR d.name ILIKE ?)`, '%' + String(req.query.q).slice(0, 80) + '%');
      if (req.query.state) add(`c.state = ?`, String(req.query.state));
      if (req.query.band) add(`c.score_band = ?`, String(req.query.band));
      if (req.query.dealerState) add(`d.state = ?`, String(req.query.dealerState).toUpperCase());
      if (req.query.role) add(`c.role_category = ?`, String(req.query.role));
      if (req.query.emailStatus) add(`c.email_status = ?`, String(req.query.emailStatus));
      if (req.query.eligible === 'true') where.push('c.outreach_eligible');
      if (req.query.campaign) add(`EXISTS (SELECT 1 FROM px_enrollments en WHERE en.contact_id = c.id AND en.campaign_id = ?)`, int(req.query.campaign, 0, 0, 1e12));
      if (req.query.minScore) add(`c.lead_score >= ?`, int(req.query.minScore, 0, 0, 100));
      const page = int(req.query.page, 1, 1, 100000);
      const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM px_contacts c JOIN px_dealerships d ON d.id = c.dealership_id ${sqlWhere}`, args)).rows[0].n;
      args.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);
      const { rows } = await pool.query(
        `SELECT c.id, c.full_name, c.title, c.role_category, c.email, c.email_status, c.state, c.lead_score, c.score_band,
                c.outreach_eligible, c.last_interaction_at, c.last_contacted_at, c.owner,
                d.id AS dealership_id, d.name AS dealership_name, d.state AS dealership_state, d.city AS dealership_city
           FROM px_contacts c JOIN px_dealerships d ON d.id = c.dealership_id
           ${sqlWhere}
          ORDER BY c.lead_score DESC, c.updated_at DESC
          LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args
      );
      res.json({ success: true, total, page, pageSize: PAGE_SIZE, leads: rows });
    } catch (e) { fail(res, e, 'leads'); }
  });

  router.get('/api/px/leads/:id', async function (req, res) {
    try {
      const id = int(req.params.id, 0, 1, 1e12);
      const lead = (await pool.query(
        `SELECT c.*, d.name AS dealership_name, d.website_url, d.city AS dealership_city, d.state AS dealership_state,
                d.platform, d.platform_supported, d.dealership_type, d.franchise_brands
           FROM px_contacts c JOIN px_dealerships d ON d.id = c.dealership_id WHERE c.id = $1`, [id])).rows[0];
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found.' });
      const [events, sources, outbound, threads, inbound, tasks] = await Promise.all([
        pool.query(`SELECT * FROM px_events WHERE contact_id = $1 ORDER BY id DESC LIMIT 200`, [id]),
        pool.query(`SELECT source, source_url, evidence, fetched_at FROM px_contact_sources WHERE contact_id = $1`, [id]),
        pool.query(`SELECT step_no, variant, subject, status, sent_at FROM px_outbound_messages WHERE contact_id = $1 ORDER BY step_no`, [id]),
        pool.query(`SELECT * FROM px_threads WHERE contact_id = $1 ORDER BY last_message_at DESC NULLS LAST`, [id]),
        pool.query(`SELECT id, thread_id, from_email, subject, body_text, received_at, intent FROM px_inbound_messages WHERE contact_id = $1 ORDER BY received_at`, [id]),
        pool.query(`SELECT * FROM px_tasks WHERE contact_id = $1 ORDER BY created_at DESC`, [id])
      ]);
      res.json({ success: true, lead, events: events.rows, sources: sources.rows, outbound: outbound.rows,
                 threads: threads.rows, inbound: inbound.rows, tasks: tasks.rows,
                 allowedNext: stateMachine.STATES.filter(function (s) { return stateMachine.canTransition(lead.state, s); }) });
    } catch (e) { fail(res, e, 'lead'); }
  });

  router.post('/api/px/leads/:id/action', async function (req, res) {
    const id = int(req.params.id, 0, 1, 1e12);
    const action = String((req.body && req.body.action) || '');
    const actor = req.pxActor;

    let lead;
    try {
      lead = (await pool.query(`SELECT id, email, state FROM px_contacts WHERE id = $1`, [id])).rows[0];
    } catch (e) { return fail(res, e, 'lead action'); }
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found.' });

    // Suppression goes through the global list so it covers every campaign.
    if ((action === 'suppress' || action === 'mark_lost') && lead.email) {
      try {
        await suppression.suppress(pool, { email: lead.email, reason: action === 'suppress' ? 'manual' : 'declined',
                                           source: 'dashboard', actor });
        await audit(actor, 'lead_' + action, 'contact', id);
        return res.json({ success: true });
      } catch (e) { return fail(res, e, 'lead suppress'); }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (action === 'suppress' || action === 'mark_lost') {
        await stateMachine.transition(client, id, action === 'suppress' ? 'SUPPRESSED' : 'NOT_INTERESTED', actor, { via: 'dashboard' });
      } else
      if (action === 'mark_contacted') {
        await client.query(`UPDATE px_contacts SET last_interaction_at = NOW(), owner = COALESCE(owner, $2), updated_at = NOW() WHERE id = $1`, [id, actor]);
        await client.query(`INSERT INTO px_events (event_type, contact_id, actor, detail) VALUES ('manual_contact', $1, $2, $3)`,
          [id, actor, JSON.stringify({ note: String((req.body && req.body.note) || '').slice(0, 500) })]);
      } else if (action === 'schedule_followup') {
        const due = req.body && req.body.dueAt ? new Date(req.body.dueAt) : new Date(Date.now() + 2 * 86400000);
        if (isNaN(due.getTime())) throw Object.assign(new Error('Bad date'), { code: 'BAD_INPUT' });
        await client.query(`INSERT INTO px_tasks (contact_id, task_type, due_at, notes, assigned_to) VALUES ($1,'follow_up',$2,$3,$4)`,
          [id, due, String((req.body && req.body.note) || '').slice(0, 1000), actor]);
        if (stateMachine.canTransition(lead.state, 'FOLLOW_UP_REQUIRED')) {
          await stateMachine.transition(client, id, 'FOLLOW_UP_REQUIRED', actor, { dueAt: due.toISOString() });
        }
      } else if (action === 'mark_subscribed') {
        await stateMachine.transition(client, id, 'CUSTOMER', actor, { via: 'dashboard' });
        await client.query(
          `INSERT INTO px_attribution (contact_id, event, touch, email, confidence, amount_cents)
           VALUES ($1, 'subscribed', 'last', $2, 'manual', 3000)`, [id, lead.email]);
      } else if (action === 'transition') {
        await stateMachine.transition(client, id, String(req.body.to || ''), actor, { via: 'dashboard' });
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Unknown action.' });
      }
      await client.query(`INSERT INTO px_audit (actor, action, target_type, target_id) VALUES ($1,$2,'contact',$3)`, [actor, 'lead_' + action, String(id)]);
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(function () {});
      if (e.code === 'BAD_INPUT') return res.status(400).json({ success: false, error: e.message });
      fail(res, e, 'lead action');
    } finally {
      client.release();
    }
  });

  router.get('/api/px/hot', async function (req, res) {
    try {
      const s = await settings.all();
      const { rows } = await pool.query(
        `SELECT c.id, c.full_name, c.title, c.email, c.phone, c.phone_source, c.lead_score, c.score_band, c.score_evidence,
                c.state, c.last_interaction_at, d.name AS dealership_name, d.city AS dealership_city, d.state AS dealership_state,
                d.website_url, t.id AS thread_id, t.summary, t.requested_action, t.intent, t.ai_draft, t.draft_status
           FROM px_contacts c
           JOIN px_dealerships d ON d.id = c.dealership_id
           LEFT JOIN LATERAL (SELECT * FROM px_threads WHERE contact_id = c.id ORDER BY last_message_at DESC NULLS LAST LIMIT 1) t ON TRUE
          WHERE c.lead_score >= $1 AND c.state NOT IN ('CUSTOMER','UNSUBSCRIBED','SUPPRESSED','NOT_INTERESTED','BOUNCED')
          ORDER BY c.lead_score DESC, c.last_interaction_at DESC NULLS LAST LIMIT 200`,
        [s.hot_score_min]
      );
      res.json({ success: true, leads: rows });
    } catch (e) { fail(res, e, 'hot'); }
  });

  // ── Dealerships ───────────────────────────────────────────────────────────
  router.get('/api/px/dealerships', async function (req, res) {
    try {
      const where = [];
      const args = [];
      function add(sql, v) { args.push(v); where.push(sql.split('?').join('$' + args.length)); }
      if (req.query.q) add(`(d.name ILIKE ? OR d.domain ILIKE ?)`, '%' + String(req.query.q).slice(0, 80) + '%');
      if (req.query.state) add(`d.state = ?`, String(req.query.state).toUpperCase());
      if (req.query.city) add(`d.city ILIKE ?`, String(req.query.city).slice(0, 80));
      if (req.query.type) add(`d.dealership_type = ?`, String(req.query.type));
      if (req.query.status) add(`d.status = ?`, String(req.query.status));
      if (req.query.platform) add(`d.platform = ?`, String(req.query.platform));
      if (req.query.supported === 'true') where.push('d.platform_supported');
      const page = int(req.query.page, 1, 1, 100000);
      const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM px_dealerships d ${sqlWhere}`, args)).rows[0].n;
      args.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);
      const { rows } = await pool.query(
        `SELECT d.id, d.name, d.domain, d.website_url, d.city, d.state, d.dealership_type, d.franchise_brands,
                d.location_count, d.platform, d.platform_supported, d.status, d.qualification_score,
                d.is_existing_customer, d.last_verified_at,
                (SELECT COUNT(*) FROM px_contacts c WHERE c.dealership_id = d.id)::int AS contacts
           FROM px_dealerships d ${sqlWhere}
          ORDER BY d.qualification_score DESC NULLS LAST, d.id
          LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args
      );
      const byState = req.query.withStates === 'true'
        ? (await pool.query(`SELECT state, COUNT(*)::int AS n FROM px_dealerships GROUP BY state ORDER BY n DESC`)).rows
        : undefined;
      res.json({ success: true, total, page, pageSize: PAGE_SIZE, dealerships: rows, byState });
    } catch (e) { fail(res, e, 'dealerships'); }
  });

  // ── Campaigns ─────────────────────────────────────────────────────────────
  const DEFAULT_STEPS = [
    { step_no: 1, delay_days: 0, subject: 'Quick question about Facebook Marketplace',
      body: 'Hey {{first_name}},\n\nAre you still listing {{dealership_name}} inventory on Facebook Marketplace by hand?\n\n' +
            'We built AutoPost, a Chrome extension that pulls the photos and vehicle details off your dealership\'s website ' +
            'and fills in the Marketplace listing for you. You review it and hit publish.\n\nIt\'s $30/month. Want me to send a quick demo?\n\n{{sender_name}}\nAutoPost' },
    { step_no: 2, delay_days: 3, subject: 'Re: Quick question about Facebook Marketplace',
      body: 'Hey {{first_name}},\n\nHere\'s what it looks like in action: {{demo_url}}\n\nOne click on a vehicle page, and the ' +
            'Marketplace form is filled with that car\'s photos, price and description.\n\nWorth a look?\n\n{{sender_name}}' },
    { step_no: 3, delay_days: 5, subject: 'Re: Quick question about Facebook Marketplace',
      body: 'Hey {{first_name}},\n\nLast note from me. If listing on Marketplace ever eats too much of your day, AutoPost is at ' +
            'tryautopost.com.\n\nThanks,\n{{sender_name}}' }
  ];

  router.get('/api/px/campaigns', async function (req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT p.*,
          (SELECT COUNT(*) FROM px_enrollments e WHERE e.campaign_id = p.id)::int AS enrolled,
          (SELECT COUNT(*) FROM px_outbound_messages o JOIN px_enrollments e ON e.id = o.enrollment_id
             WHERE e.campaign_id = p.id AND o.sent_at IS NOT NULL)::int AS sent,
          (SELECT COUNT(DISTINCT i.contact_id) FROM px_inbound_messages i JOIN px_threads t ON t.id = i.thread_id
             JOIN px_enrollments e ON e.id = t.enrollment_id WHERE e.campaign_id = p.id)::int AS replied,
          (SELECT COUNT(*) FROM px_attribution a JOIN px_enrollments e ON e.id = a.enrollment_id
             WHERE e.campaign_id = p.id AND a.event = 'subscribed')::int AS subscribed
        FROM px_campaigns p ORDER BY p.id DESC`);
      const steps = (await pool.query(`SELECT * FROM px_campaign_steps ORDER BY campaign_id, step_no, variant`)).rows;
      for (const c of rows) c.steps = steps.filter(function (s) { return String(s.campaign_id) === String(c.id); });
      res.json({ success: true, campaigns: rows });
    } catch (e) { fail(res, e, 'campaigns'); }
  });

  router.post('/api/px/campaigns', async function (req, res) {
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query(
        `INSERT INTO px_campaigns (name, states, dealership_types, roles, daily_limit, per_dealer_limit)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [String(b.name || 'New campaign').slice(0, 120),
         Array.isArray(b.states) ? b.states.map(function (s) { return String(s).toUpperCase().slice(0, 2); }) : [],
         Array.isArray(b.dealershipTypes) ? b.dealershipTypes.map(String) : [],
         Array.isArray(b.roles) ? b.roles.map(String) : [],
         int(b.dailyLimit, 20, 1, 500), int(b.perDealerLimit, 2, 1, 5)]
      )).rows[0];
      for (const s of DEFAULT_STEPS) {
        await client.query(
          `INSERT INTO px_campaign_steps (campaign_id, step_no, variant, delay_days, subject, body) VALUES ($1,$2,'A',$3,$4,$5)`,
          [c.id, s.step_no, s.delay_days, s.subject, s.body]);
      }
      await client.query(`INSERT INTO px_audit (actor, action, target_type, target_id) VALUES ($1,'campaign_created','campaign',$2)`, [req.pxActor, String(c.id)]);
      await client.query('COMMIT');
      res.json({ success: true, campaign: c });
    } catch (e) {
      await client.query('ROLLBACK').catch(function () {});
      fail(res, e, 'campaign create');
    } finally { client.release(); }
  });

  router.post('/api/px/campaigns/:id/steps/:stepId', async function (req, res) {
    try {
      const b = req.body || {};
      const r = await pool.query(
        `UPDATE px_campaign_steps
            SET subject = COALESCE($3, subject), body = COALESCE($4, body), delay_days = COALESCE($5, delay_days),
                approved_at = CASE WHEN $6::boolean IS TRUE THEN NOW() WHEN $3 IS NOT NULL OR $4 IS NOT NULL THEN NULL ELSE approved_at END,
                approved_by = CASE WHEN $6::boolean IS TRUE THEN $7 WHEN $3 IS NOT NULL OR $4 IS NOT NULL THEN NULL ELSE approved_by END
          WHERE id = $2 AND campaign_id = $1 RETURNING *`,
        [int(req.params.id, 0, 1, 1e12), int(req.params.stepId, 0, 1, 1e12),
         b.subject != null ? String(b.subject).slice(0, 200) : null, b.body != null ? String(b.body).slice(0, 5000) : null,
         b.delayDays != null ? int(b.delayDays, 0, 0, 60) : null, b.approve === true, req.pxActor]
      );
      if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Step not found.' });
      await audit(req.pxActor, b.approve ? 'step_approved' : 'step_edited', 'campaign_step', req.params.stepId);
      res.json({ success: true, step: r.rows[0] });
    } catch (e) { fail(res, e, 'step update'); }
  });

  router.post('/api/px/campaigns/:id/status', async function (req, res) {
    try {
      const status = String((req.body && req.body.status) || '');
      if (['active', 'paused', 'completed', 'draft'].indexOf(status) === -1) return res.status(400).json({ success: false, error: 'Bad status.' });
      const id = int(req.params.id, 0, 1, 1e12);
      if (status === 'active') {
        const unapproved = (await pool.query(`SELECT COUNT(*)::int AS n FROM px_campaign_steps WHERE campaign_id = $1 AND approved_at IS NULL`, [id])).rows[0].n;
        if (unapproved) return res.status(409).json({ success: false, error: 'Approve every email step before activating.' });
        const s = await settings.all();
        if (!s.sender_name || !s.sender_postal_address) {
          return res.status(409).json({ success: false, error: 'Set the sender name and postal address in Settings first (required by CAN-SPAM).' });
        }
      }
      await pool.query(`UPDATE px_campaigns SET status = $2, updated_at = NOW() WHERE id = $1`, [id, status]);
      await audit(req.pxActor, 'campaign_' + status, 'campaign', id);
      res.json({ success: true });
    } catch (e) { fail(res, e, 'campaign status'); }
  });

  // ── Conversations ─────────────────────────────────────────────────────────
  router.get('/api/px/conversations', async function (req, res) {
    try {
      const { rows } = await pool.query(
        `SELECT t.*, c.full_name, c.email, c.lead_score, c.score_band, d.name AS dealership_name
           FROM px_threads t JOIN px_contacts c ON c.id = t.contact_id JOIN px_dealerships d ON d.id = c.dealership_id
          ORDER BY t.last_message_at DESC NULLS LAST LIMIT 200`);
      res.json({ success: true, threads: rows });
    } catch (e) { fail(res, e, 'conversations'); }
  });

  // ── Agents, settings, pause ───────────────────────────────────────────────
  router.get('/api/px/agents', async function (req, res) {
    try {
      const rows = (await pool.query(`SELECT * FROM px_agent_status`)).rows;
      const runs = (await pool.query(
        `SELECT agent, COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours')::int AS runs_24h,
                COUNT(*) FILTER (WHERE ok = FALSE AND started_at > NOW() - INTERVAL '24 hours')::int AS failures_24h
           FROM px_job_runs GROUP BY agent`)).rows;
      const costs = (await pool.query(
        `SELECT ref_type AS agent, SUM(cost_cents)::float AS cents FROM px_costs
          WHERE created_at >= date_trunc('month', NOW()) AND ref_type LIKE 'agent:%' GROUP BY ref_type`)).rows;
      const s = await settings.all();
      const agents = settings.AGENTS.map(function (a) {
        const st = rows.find(function (r) { return r.agent === a.agent; }) || {};
        const rr = runs.find(function (r) { return r.agent === a.agent; }) || {};
        const cc = costs.find(function (r) { return r.agent === 'agent:' + a.agent; });
        return Object.assign({}, a, st, { runs24h: rr.runs_24h || 0, failures24h: rr.failures_24h || 0,
                                          monthCostCents: cc ? cc.cents : 0 });
      });
      res.json({ success: true, agents, paused: !!s.global_pause });
    } catch (e) { fail(res, e, 'agents'); }
  });

  router.post('/api/px/agents/:agent', async function (req, res) {
    try {
      const agent = String(req.params.agent);
      if (!settings.AGENTS.some(function (a) { return a.agent === agent; })) return res.status(404).json({ success: false, error: 'Unknown agent.' });
      const enabled = !!(req.body && req.body.enabled);
      await pool.query(`UPDATE px_agent_status SET enabled = $2, updated_at = NOW() WHERE agent = $1`, [agent, enabled]);
      await audit(req.pxActor, enabled ? 'agent_enabled' : 'agent_disabled', 'agent', agent);
      res.json({ success: true });
    } catch (e) { fail(res, e, 'agent toggle'); }
  });

  router.get('/api/px/settings', async function (req, res) {
    try { res.json({ success: true, settings: await settings.publicView() }); } catch (e) { fail(res, e, 'settings'); }
  });

  router.post('/api/px/settings', async function (req, res) {
    try {
      const b = req.body || {};
      await settings.set(String(b.key || ''), b.value, req.pxActor);
      res.json({ success: true, settings: await settings.publicView() });
    } catch (e) {
      if (/^Unknown setting|must be/.test(e.message)) return res.status(400).json({ success: false, error: e.message });
      fail(res, e, 'settings set');
    }
  });

  // The emergency stop. Pausing never blocks replies, opt-outs or logging.
  router.post('/api/px/pause', async function (req, res) {
    try {
      const paused = !!(req.body && req.body.paused);
      await settings.set('global_pause', paused, req.pxActor);
      await pool.query(`INSERT INTO px_events (event_type, actor, detail) VALUES ($1, $2, NULL)`,
        [paused ? 'global_pause' : 'global_resume', req.pxActor]);
      res.json({ success: true, paused });
    } catch (e) { fail(res, e, 'pause'); }
  });

  router.post('/api/px/suppress', async function (req, res) {
    try {
      const b = req.body || {};
      const out = await suppression.suppress(pool, { email: b.email, domain: b.domain, reason: b.reason || 'manual',
                                                     source: 'dashboard', notes: b.notes, actor: req.pxActor });
      await audit(req.pxActor, 'suppressed', 'suppression', out.suppressed);
      res.json({ success: true, result: out });
    } catch (e) {
      if (/Need an email|Unknown suppression/.test(e.message)) return res.status(400).json({ success: false, error: e.message });
      fail(res, e, 'suppress');
    }
  });

  // ── Costs, logs, integrations ─────────────────────────────────────────────
  router.get('/api/px/costs', async function (req, res) {
    try {
      const months = (await pool.query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, category, SUM(cost_cents)::float AS cents
           FROM px_costs GROUP BY 1, 2 ORDER BY 1 DESC, 2`)).rows;
      const recent = (await pool.query(`SELECT * FROM px_costs ORDER BY created_at DESC LIMIT 100`)).rows;
      res.json({ success: true, months, recent });
    } catch (e) { fail(res, e, 'costs'); }
  });

  router.get('/api/px/logs', async function (req, res) {
    try {
      const [runs, jobs, auditRows] = await Promise.all([
        pool.query(`SELECT * FROM px_job_runs ORDER BY started_at DESC LIMIT 100`),
        pool.query(`SELECT id, job_type, status, attempts, last_error, run_after, updated_at FROM px_jobs
                     WHERE status IN ('failed','dead') ORDER BY updated_at DESC LIMIT 100`),
        pool.query(`SELECT * FROM px_audit ORDER BY created_at DESC LIMIT 100`)
      ]);
      res.json({ success: true, runs: runs.rows, failedJobs: jobs.rows, audit: auditRows.rows });
    } catch (e) { fail(res, e, 'logs'); }
  });

  router.get('/api/px/integrations', async function (req, res) {
    try {
      const s = await settings.all();
      res.json({
        success: true,
        integrations: [
          { name: 'Neon Postgres', kind: 'database', connected: true },
          { name: 'Clerk', kind: 'auth', connected: !!process.env.CLERK_SECRET_KEY },
          { name: 'Stripe', kind: 'billing', connected: !!process.env.STRIPE_SECRET_KEY, webhook: !!process.env.STRIPE_WEBHOOK_SECRET },
          { name: 'Claude API', kind: 'ai', connected: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) },
          { name: 'Overture Maps', kind: 'dealership data', connected: true, note: 'Open data, imported in bulk' },
          { name: 'Email verification', kind: 'verification', connected: !!process.env.MILLIONVERIFIER_API_KEY },
          { name: 'Sending platform', kind: 'outbound email', connected: !!(process.env.INSTANTLY_API_KEY || process.env.SMARTLEAD_API_KEY) },
          { name: 'Hot-lead push (ntfy)', kind: 'alerts', connected: !!s.ntfy_topic },
          { name: 'Alert email (Resend)', kind: 'alerts', connected: !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL) }
        ]
      });
    } catch (e) { fail(res, e, 'integrations'); }
  });

  // ── Operator-only: imports and admin bootstrap ────────────────────────────
  function operatorOnly(req, res, next) {
    if (req.pxActor !== 'operator') return res.status(403).json({ success: false, error: 'Operator key required.' });
    next();
  }

  router.post('/api/px/ops/import/dealerships', operatorOnly, async function (req, res) {
    try {
      const b = req.body || {};
      const records = Array.isArray(b.records) ? b.records.slice(0, 2000) : [];
      const source = String(b.source || '').replace(/[^a-z0-9_]/g, '').slice(0, 30);
      if (!source) return res.status(400).json({ success: false, error: 'source required' });
      const stats = await importDealerBatch(pool, source, records, 'operator:import');
      res.json({ success: true, stats });
    } catch (e) { fail(res, e, 'import'); }
  });

  // Mark dealer sites the extension already supports (its store whitelist).
  router.post('/api/px/ops/supported-dealers', operatorOnly, async function (req, res) {
    try {
      const domains = ((req.body && req.body.urls) || []).map(function (u) { const n = normalizeWebsite(u); return n && n.domain; }).filter(Boolean);
      const n = await markSupportedDealers(pool, domains);
      res.json({ success: true, received: domains.length, marked: n });
    } catch (e) { fail(res, e, 'supported dealers'); }
  });

  // The dashboard is single-owner. Exactly one Clerk account may hold access, it
  // must own a VERIFIED copy of the email, and only the operator key (never the
  // dashboard itself) can set or replace it.
  router.get('/api/px/ops/admins', operatorOnly, async function (req, res) {
    try {
      res.json({ success: true, admins: (await pool.query(`SELECT clerk_user_id, email, added_at FROM px_admins`)).rows });
    } catch (e) { fail(res, e, 'list admins'); }
  });

  router.post('/api/px/ops/admins', operatorOnly, async function (req, res) {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email || !clerkClient) return res.status(400).json({ success: false, error: 'email required' });
    const client = await pool.connect();
    try {
      const list = await clerkClient.users.getUserList({ emailAddress: [email] });
      const users = Array.isArray(list) ? list : (list && list.data) || [];
      const matches = users.filter(function (u) {
        return (u.emailAddresses || []).some(function (a) {
          return String(a.emailAddress || '').toLowerCase() === email && a.verification && a.verification.status === 'verified';
        });
      });
      if (matches.length !== 1) {
        return res.status(404).json({ success: false, error: matches.length ? 'More than one account claims that email.' : 'No Clerk account with that VERIFIED email.' });
      }
      const u = matches[0];

      await client.query('BEGIN');
      await client.query('LOCK TABLE px_admins IN EXCLUSIVE MODE');
      const others = (await client.query(`SELECT clerk_user_id, email FROM px_admins WHERE clerk_user_id <> $1`, [u.id])).rows;
      if (others.length && req.body.replace !== true) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'The dashboard already has an owner. Pass replace:true to swap it.', current: others });
      }
      await client.query(`DELETE FROM px_admins WHERE clerk_user_id <> $1`, [u.id]);
      await client.query(
        `INSERT INTO px_admins (clerk_user_id, email, added_by) VALUES ($1,$2,'operator') ON CONFLICT (clerk_user_id) DO NOTHING`,
        [u.id, email]);
      await client.query(
        `INSERT INTO px_audit (actor, action, target_type, target_id, detail) VALUES ('operator','owner_set','admin',$1,$2)`,
        [u.id, JSON.stringify({ email, replaced: others.map(function (o) { return o.email; }) })]);
      await client.query('COMMIT');
      adminCache.clear();
      res.json({ success: true, clerkUserId: u.id, email });
    } catch (e) {
      await client.query('ROLLBACK').catch(function () {});
      fail(res, e, 'set owner');
    } finally { client.release(); }
  });

  return { router };
};

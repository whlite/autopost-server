// notify.js — AutoPost signup alerts (SMS + email, escalating until acknowledged)
//
// WHY THIS EXISTS
//   A dealership signup is worthless if it sits unseen for two days. Netlify's
//   form email is a single, silent notification. This module turns every signup
//   into a lead row plus a text message that KEEPS ARRIVING on a timer until the
//   owner explicitly says "I saw it".
//
// SHAPE (mirrors teams.js): self-contained, ap_* table namespace, idempotent DDL
// replayed on boot, mounted as an express Router. Nothing here can break sign-in
// or posting — every failure path is logged and swallowed.
//
// COST CONTROL — this module sends paid SMS on a timer, so it is capped in three
// independent places:
//   1. NOTIFY_MAX_NUDGES    — hard stop after N reminders per lead (default 12)
//   2. NOTIFY_GIVE_UP_HOURS — stop nudging a lead older than N hours (default 24)
//   3. status = 'ACKED'     — acknowledgement stops it instantly
// Worst case per lead is MAX_NUDGES messages, not an unbounded loop.

const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ap_leads (
     id              BIGSERIAL PRIMARY KEY,
     name            TEXT,
     email           TEXT,
     phone           TEXT,
     dealer_website  TEXT,
     dealership      TEXT,
     source          TEXT NOT NULL DEFAULT 'website',
     notes           TEXT,
     ack_token       TEXT UNIQUE NOT NULL,
     status          TEXT NOT NULL DEFAULT 'NEW',
     nudge_count     INTEGER NOT NULL DEFAULT 0,
     last_nudge_at   TIMESTAMPTZ,
     acked_at        TIMESTAMPTZ,
     acked_via       TEXT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS ap_leads_open ON ap_leads (status, last_nudge_at) WHERE status = 'NEW'`,
  `CREATE INDEX IF NOT EXISTS ap_leads_email ON ap_leads (LOWER(email), created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ap_leads_recent ON ap_leads (created_at DESC)`
];

function clampNum(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 300);
}

// Twilio needs E.164. Dealers type "(505) 555-0134".
function toE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.charAt(0) === '+') return '+' + s.slice(1).replace(/\D/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
  return d ? '+' + d : '';
}

// ntfy sends the title as an HTTP header, and header values must be latin-1.
// A dealership name with an accent or an em dash would otherwise throw.
function asciiHeader(s) {
  return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '').slice(0, 120) || 'AutoPost';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

module.exports = function createNotify(deps) {
  const pool = deps.pool;
  const adminSecret = deps.adminSecret || '';
  const safeEqual = deps.safeEqual;

  // ── Config ────────────────────────────────────────────────────────────────
  const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || '';
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
  const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER || '';
  const ALERT_PHONE  = process.env.ALERT_PHONE || '';

  const RESEND_KEY       = process.env.RESEND_API_KEY || '';
  const ALERT_EMAIL      = process.env.ALERT_EMAIL || '';
  const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'AutoPost Alerts <onboarding@resend.dev>';

  // ntfy push. Free and account-free: install the ntfy app, subscribe to your
  // topic, done. Unlike US SMS it needs no carrier (10DLC) registration, so this
  // is the channel that can be live today. The topic name IS the only secret —
  // anyone who guesses it can read your alerts, so use a long random string.
  const NTFY_TOPIC  = process.env.NTFY_TOPIC || '';
  const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

  const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ||
    'https://autopost-server-production.up.railway.app').replace(/\/$/, '');

  const REPEAT_MINUTES = clampNum(process.env.NOTIFY_REPEAT_MINUTES, 10, 1, 720);
  const MAX_NUDGES     = clampNum(process.env.NOTIFY_MAX_NUDGES, 12, 0, 200);
  const GIVE_UP_HOURS  = clampNum(process.env.NOTIFY_GIVE_UP_HOURS, 24, 1, 168);

  const smsReady   = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && ALERT_PHONE);
  const emailReady = !!(RESEND_KEY && ALERT_EMAIL);
  const pushReady  = !!NTFY_TOPIC;

  console.log('Notify: push:', pushReady, '| SMS:', smsReady, '| email:', emailReady,
              '| repeat every', REPEAT_MINUTES, 'min, max', MAX_NUDGES, 'nudges');

  const router = express.Router();

  function isAdmin(req) {
    if (!adminSecret) return false;
    const given = req.get('x-admin-secret') || req.query.secret || (req.body && req.body.secret) || '';
    return safeEqual ? safeEqual(given, adminSecret) : given === adminSecret;
  }

  // ── Senders ───────────────────────────────────────────────────────────────
  async function sendSms(body) {
    if (!smsReady) return { ok: false, skipped: 'sms-not-configured' };
    const to = toE164(ALERT_PHONE);
    if (!to) return { ok: false, skipped: 'bad-ALERT_PHONE' };
    try {
      const url = 'https://api.twilio.com/2010-04-01/Accounts/' +
                  encodeURIComponent(TWILIO_SID) + '/Messages.json';
      const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }).toString()
      });
      const json = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        console.error('Notify SMS failed:', res.status, json && (json.message || json.code));
        return { ok: false, error: (json && json.message) || ('HTTP ' + res.status) };
      }
      return { ok: true, sid: json.sid };
    } catch (e) {
      console.error('Notify SMS error:', e.message);
      return { ok: false, error: e.message };
    }
  }

  async function sendEmail(subject, text) {
    if (!emailReady) return { ok: false, skipped: 'email-not-configured' };
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + RESEND_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: ALERT_EMAIL_FROM,
          to: ALERT_EMAIL.split(',').map(function (e) { return e.trim(); }).filter(Boolean),
          subject: subject,
          text: text
        })
      });
      if (!res.ok) {
        const detail = await res.text().catch(function () { return ''; });
        console.error('Notify email failed:', res.status, detail.slice(0, 200));
        return { ok: false, error: 'HTTP ' + res.status };
      }
      return { ok: true };
    } catch (e) {
      console.error('Notify email error:', e.message);
      return { ok: false, error: e.message };
    }
  }

  async function sendPush(title, body, lead) {
    if (!pushReady) return { ok: false, skipped: 'push-not-configured' };
    try {
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: asciiHeader(title),
        Priority: 'high',
        Tags: 'rotating_light'
      };
      // Tapping the notification opens the acknowledgement page directly.
      if (lead && lead.ack_token) headers.Click = ackUrl(lead);
      const res = await fetch(NTFY_SERVER + '/' + encodeURIComponent(NTFY_TOPIC), {
        method: 'POST', headers: headers, body: body
      });
      if (!res.ok) {
        console.error('Notify push failed:', res.status);
        return { ok: false, error: 'HTTP ' + res.status };
      }
      return { ok: true };
    } catch (e) {
      console.error('Notify push error:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── Message text ──────────────────────────────────────────────────────────
  function ackUrl(lead) {
    return PUBLIC_BASE_URL + '/api/notify/ack/' + lead.ack_token;
  }

  function leadLines(lead) {
    const rows = [];
    if (lead.name)           rows.push(lead.name);
    if (lead.phone)          rows.push(lead.phone);
    if (lead.email)          rows.push(lead.email);
    if (lead.dealership)     rows.push(lead.dealership);
    if (lead.dealer_website) rows.push(lead.dealer_website);
    if (lead.notes)          rows.push(lead.notes);
    return rows.join('\n');
  }

  function smsBody(lead, nudgeNumber) {
    const head = nudgeNumber > 0
      ? 'AutoPost signup #' + lead.id + ' STILL UNREAD (reminder ' + nudgeNumber + ')'
      : 'NEW AutoPost signup #' + lead.id + (lead.source === 'stripe' ? ' (paid, form pending)' : '');
    return head + '\n' + leadLines(lead) +
           '\n\nTap to stop reminders: ' + ackUrl(lead) +
           '\nOr reply OK';
  }

  // Deliberately contentless. See the note at the top of this file: the push
  // rides through ntfy.sh, so it names no dealer, no number and no address.
  function pushTitle(nudgeNumber) {
    return nudgeNumber > 0
      ? 'AutoPost signup still unread'
      : 'New AutoPost signup';
  }

  function pushBody(lead, nudgeNumber) {
    return (nudgeNumber > 0
      ? 'Signup #' + lead.id + ' is still unacknowledged (reminder ' + nudgeNumber + ').'
      : 'Signup #' + lead.id + ' just came in.') +
      '\nTap to see who it is and stop the reminders.';
  }

  function emailBody(lead, nudgeNumber) {
    return (nudgeNumber > 0 ? 'This signup is still unacknowledged (reminder ' + nudgeNumber + ').\n\n' : '') +
      'Lead #' + lead.id + '\n' +
      'Name:       ' + (lead.name || '-') + '\n' +
      'Phone:      ' + (lead.phone || '-') + '\n' +
      'Email:      ' + (lead.email || '-') + '\n' +
      'Dealership: ' + (lead.dealership || '-') + '\n' +
      'Website:    ' + (lead.dealer_website || '-') + '\n' +
      'Source:     ' + lead.source + '\n' +
      'Received:   ' + new Date(lead.created_at).toISOString() + '\n' +
      (lead.notes ? 'Notes:      ' + lead.notes + '\n' : '') +
      '\nStop the reminders: ' + ackUrl(lead) + '\n';
  }

  async function alertForLead(lead, nudgeNumber) {
    const subject = (nudgeNumber > 0 ? 'REMINDER: ' : 'New AutoPost signup: ') +
                    (lead.dealership || lead.dealer_website || lead.email || ('lead #' + lead.id));
    if (!smsReady && !emailReady && !pushReady) {
      console.warn('Notify: lead #' + lead.id + ' captured but NO alert channel is configured. ' +
                   'Set NTFY_TOPIC (easiest), TWILIO_* + ALERT_PHONE, or RESEND_API_KEY + ALERT_EMAIL in Railway.');
    }
    const results = await Promise.all([
      sendPush(pushTitle(nudgeNumber), pushBody(lead, nudgeNumber), lead),
      sendSms(smsBody(lead, nudgeNumber)),
      sendEmail(subject, emailBody(lead, nudgeNumber))
    ]);
    return { push: results[0], sms: results[1], email: results[2] };
  }

  // ── Capture ───────────────────────────────────────────────────────────────
  // Deduped on email within GIVE_UP_HOURS so the Stripe webhook and the website
  // form describe ONE lead instead of two texts for the same dealer. A repeat
  // arrival re-alerts only when it carries information the first one lacked.
  async function captureLead(input) {
    if (!pool) return null;

    const lead = {
      name:           clean(input.name, 120),
      email:          clean(input.email, 200).toLowerCase(),
      phone:          clean(input.phone, 40),
      dealer_website: clean(input.dealer_website, 300),
      dealership:     clean(input.dealership, 200),
      source:         clean(input.source, 40) || 'website',
      notes:          clean(input.notes, 500)
    };

    if (!lead.email && !lead.phone && !lead.dealer_website) return null;

    const existing = lead.email
      ? await pool.query(
          `SELECT * FROM ap_leads
            WHERE LOWER(email) = $1
              AND created_at > NOW() - ($2::text || ' hours')::interval
            ORDER BY created_at DESC LIMIT 1`,
          [lead.email, String(GIVE_UP_HOURS)]
        )
      : { rows: [] };

    if (existing.rows.length) {
      const prev = existing.rows[0];
      // Fill blanks only — never let a sparser later payload erase good data.
      const merged = await pool.query(
        `UPDATE ap_leads SET
           name           = COALESCE(NULLIF($2,''), name),
           phone          = COALESCE(NULLIF($3,''), phone),
           dealer_website = COALESCE(NULLIF($4,''), dealer_website),
           dealership     = COALESCE(NULLIF($5,''), dealership),
           notes          = COALESCE(NULLIF($6,''), notes),
           updated_at     = NOW()
         WHERE id = $1
         RETURNING *`,
        [prev.id, lead.name, lead.phone, lead.dealer_website, lead.dealership, lead.notes]
      );
      const row = merged.rows[0];
      // The dealer finally told us their site: that is new, actionable info, so
      // reopen the lead and start the reminders again.
      if (!prev.dealer_website && row.dealer_website) {
        await pool.query(
          `UPDATE ap_leads SET status='NEW', nudge_count=0, last_nudge_at=NOW(), updated_at=NOW()
            WHERE id=$1`, [row.id]);
        alertForLead(row, 0).catch(function (e) { console.error('Notify alert error:', e.message); });
      }
      return row;
    }

    const inserted = await pool.query(
      `INSERT INTO ap_leads (name, email, phone, dealer_website, dealership, source, notes, ack_token, last_nudge_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       RETURNING *`,
      [lead.name, lead.email, lead.phone, lead.dealer_website, lead.dealership,
       lead.source, lead.notes, crypto.randomBytes(12).toString('hex')]
    );
    const row = inserted.rows[0];
    console.log('Notify: captured lead #' + row.id + ' from ' + row.source + ' (' + (row.email || 'no email') + ')');
    alertForLead(row, 0).catch(function (e) { console.error('Notify alert error:', e.message); });
    return row;
  }

  async function ackLead(id, via) {
    if (!pool) return null;
    const r = await pool.query(
      `UPDATE ap_leads SET status='ACKED', acked_at=NOW(), acked_via=$2, updated_at=NOW()
        WHERE id=$1 AND status <> 'ACKED' RETURNING *`,
      [id, clean(via, 40) || 'unknown']
    );
    if (r.rows.length) console.log('Notify: lead #' + id + ' acknowledged via ' + via);
    return r.rows[0] || null;
  }

  // ── Escalation loop ───────────────────────────────────────────────────────
  let timer = null;

  async function runEscalationTick() {
    if (!pool) return;
    try {
      const due = await pool.query(
        `SELECT * FROM ap_leads
          WHERE status = 'NEW'
            AND nudge_count < $1
            AND created_at > NOW() - ($2::text || ' hours')::interval
            AND (last_nudge_at IS NULL OR last_nudge_at < NOW() - ($3::text || ' minutes')::interval)
          ORDER BY created_at ASC
          LIMIT 10`,
        [MAX_NUDGES, String(GIVE_UP_HOURS), String(REPEAT_MINUTES)]
      );
      for (const lead of due.rows) {
        const n = lead.nudge_count + 1;
        // Count the nudge BEFORE sending. A crash mid-send must not let this
        // lead re-fire on every tick and run up a Twilio bill.
        await pool.query(
          `UPDATE ap_leads SET nudge_count=$2, last_nudge_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [lead.id, n]
        );
        await alertForLead(lead, n);
        if (n >= MAX_NUDGES) {
          console.warn('Notify: lead #' + lead.id + ' hit the ' + MAX_NUDGES +
                       '-reminder cap and is still unacknowledged. No more texts for it.');
        }
      }
    } catch (e) {
      console.error('Notify escalation tick error:', e.message);
    }
  }

  function startEscalation() {
    if (timer) return;
    timer = setInterval(function () {
      runEscalationTick().catch(function (e) { console.error('Notify tick:', e.message); });
    }, 60 * 1000);
    if (timer.unref) timer.unref();
    console.log('Notify: escalation loop running (checks every 60s).');
  }

  // ── Ack page ──────────────────────────────────────────────────────────────
  function leadHtml(lead) {
    const rows = [
      ['Name', lead.name], ['Phone', lead.phone], ['Email', lead.email],
      ['Dealership', lead.dealership], ['Website', lead.dealer_website],
      ['Source', lead.source], ['Received', new Date(lead.created_at).toLocaleString()]
    ].filter(function (r) { return r[1]; });
    return '<dl>' + rows.map(function (r) {
      return '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd>';
    }).join('') + '</dl>';
  }

  function ackPage(title, bodyHtml, token) {
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex">' +
      '<title>' + escapeHtml(title) + '</title><style>' +
      'body{margin:0;background:#0f1115;color:#f1f7fe;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}' +
      '.card{width:100%;max-width:420px;background:#171a21;border:1px solid #262b36;border-radius:18px;padding:28px}' +
      'h1{margin:0 0 18px;font-size:22px;color:#f78daa}' +
      'dl{margin:0 0 24px;display:grid;grid-template-columns:auto 1fr;gap:8px 16px}' +
      'dt{color:#8b93a5;font-size:13px;text-transform:uppercase;letter-spacing:.04em}' +
      'dd{margin:0;word-break:break-word}' +
      'button{width:100%;padding:16px;font-size:17px;font-weight:600;border:0;border-radius:12px;' +
      'background:#e2567f;color:#fff;cursor:pointer}button:active{opacity:.8}' +
      'p{color:#c3cad8}</style></head><body><div class="card">' +
      '<h1>' + escapeHtml(title) + '</h1>' + bodyHtml +
      (token ? '<form method="POST" action="' + escapeHtml(PUBLIC_BASE_URL + '/api/notify/ack/' + token) + '">' +
               '<button type="submit">I saw it &mdash; stop texting me</button></form>' : '') +
      '</div></body></html>';
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  // Public: the website posts here after a signup.
  router.post('/api/lead', async function (req, res) {
    try {
      const b = req.body || {};
      const row = await captureLead({
        name: b.name,
        email: b.email,
        phone: b.phone,
        dealer_website: b.dealer_website || b.website,
        dealership: b.dealership,
        source: b.source || 'website',
        notes: b.notes
      });
      if (!row) return res.status(400).json({ success: false, error: 'Nothing to record' });
      return res.json({ success: true, leadId: row.id });
    } catch (e) {
      console.error('POST /api/lead error:', e.message);
      return res.status(500).json({ success: false, error: 'Could not record lead' });
    }
  });

  // Tap target from the SMS. GET renders a confirm page rather than acking —
  // link-preview crawlers fetch GETs, and that would silently clear every alert.
  router.get('/api/notify/ack/:token', async function (req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!pool) return res.status(503).send(ackPage('Unavailable', '<p>Database not configured.</p>', null));
    const r = await pool.query('SELECT * FROM ap_leads WHERE ack_token = $1', [String(req.params.token || '')]);
    const lead = r.rows[0];
    if (!lead) return res.status(404).send(ackPage('Not found', '<p>That link is not valid.</p>', null));
    if (lead.status === 'ACKED') {
      return res.send(ackPage('Already handled',
        '<p>Lead #' + lead.id + ' was acknowledged ' +
        escapeHtml(new Date(lead.acked_at).toLocaleString()) + '. No more reminders.</p>', null));
    }
    return res.send(ackPage('New signup', leadHtml(lead), lead.ack_token));
  });

  router.post('/api/notify/ack/:token', async function (req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!pool) return res.status(503).send(ackPage('Unavailable', '<p>Database not configured.</p>', null));
    const r = await pool.query('SELECT * FROM ap_leads WHERE ack_token = $1', [String(req.params.token || '')]);
    const lead = r.rows[0];
    if (!lead) return res.status(404).send(ackPage('Not found', '<p>That link is not valid.</p>', null));
    await ackLead(lead.id, 'link');
    return res.send(ackPage('Got it',
      '<p>Lead #' + lead.id + ' is marked as seen. The reminders stop now.</p>', null));
  });

  // Twilio inbound SMS webhook. Replying OK from your phone clears everything
  // open, so you never have to find the right link.
  router.post('/api/notify/sms-inbound',
    express.urlencoded({ extended: false }),
    async function (req, res) {
      res.set('Content-Type', 'text/xml');
      try {
        const from = toE164((req.body && req.body.From) || '');
        const text = String((req.body && req.body.Body) || '').trim().toLowerCase();
        if (!pool || !from || !ALERT_PHONE || from !== toE164(ALERT_PHONE)) {
          return res.send('<Response></Response>');
        }
        const isAck = /^(ok|okay|k|got it|gotit|seen|done|yes|y|stop|handled)\b/.test(text);
        if (!isAck) {
          return res.send('<Response><Message>Reply OK to stop signup reminders.</Message></Response>');
        }
        const idMatch = text.match(/\b(\d{1,9})\b/);
        let count = 0;
        if (idMatch) {
          const one = await ackLead(parseInt(idMatch[1], 10), 'sms');
          count = one ? 1 : 0;
        } else {
          const r = await pool.query(
            `UPDATE ap_leads SET status='ACKED', acked_at=NOW(), acked_via='sms', updated_at=NOW()
              WHERE status='NEW' RETURNING id`);
          count = r.rows.length;
        }
        return res.send('<Response><Message>Acknowledged ' + count +
                        ' signup' + (count === 1 ? '' : 's') + '. Reminders stopped.</Message></Response>');
      } catch (e) {
        console.error('sms-inbound error:', e.message);
        return res.send('<Response></Response>');
      }
    });

  // Admin: list leads (for the CRM), check wiring, send a test alert.
  router.get('/api/notify/leads', async function (req, res) {
    if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!pool) return res.status(503).json({ success: false, error: 'Database not configured' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(
      `SELECT id, name, email, phone, dealer_website, dealership, source, status,
              nudge_count, created_at, acked_at, acked_via
         FROM ap_leads ORDER BY created_at DESC LIMIT $1`, [limit]);
    return res.json({ success: true, leads: r.rows });
  });

  router.get('/api/notify/status', function (req, res) {
    if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    return res.json({
      success: true,
      pushConfigured: pushReady,
      smsConfigured: smsReady,
      emailConfigured: emailReady,
      alertPhone: smsReady ? toE164(ALERT_PHONE).replace(/\d(?=\d{4})/g, '*') : null,
      repeatMinutes: REPEAT_MINUTES,
      maxNudges: MAX_NUDGES,
      giveUpHours: GIVE_UP_HOURS,
      publicBaseUrl: PUBLIC_BASE_URL
    });
  });

  router.post('/api/notify/test', async function (req, res) {
    if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const fake = {
      id: 0, name: 'Test Dealer', phone: '(505) 555-0134', email: 'test@example.com',
      dealership: 'Test Chevrolet', dealer_website: 'https://example.com',
      source: 'test', notes: 'This is a wiring test.', ack_token: 'test',
      created_at: new Date()
    };
    const out = await alertForLead(fake, 0);
    return res.json({ success: true, pushConfigured: pushReady, smsConfigured: smsReady,
                      emailConfigured: emailReady, result: out });
  });

  // ── Schema init ───────────────────────────────────────────────────────────
  async function initSchema() {
    if (!pool) return;
    for (const sql of SCHEMA) await pool.query(sql);
    console.log('Notify schema ready: ap_leads.');
  }

  return {
    router: router,
    initSchema: initSchema,
    captureLead: captureLead,
    startEscalation: startEscalation,
    // One pass of the reminder sweep. startEscalation() just calls this on a
    // timer; exported so it can be driven directly under test.
    escalateOnce: runEscalationTick
  };
};

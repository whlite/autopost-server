// prospecting/suppression.js — the global do-not-contact list
//
// checkSendable() is the gate every enqueue and every send must pass. It fails
// CLOSED: if the lookup itself errors, the caller gets an exception and must
// not send. Suppressing someone also moves their lead state and stops any live
// sequence, inside one transaction.

const stateMachine = require('./state');

function normEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return s && s.indexOf('@') > 0 ? s : null;
}

function emailDomain(e) {
  const s = normEmail(e);
  return s ? s.split('@')[1] : null;
}

// Throws on DB failure (fail closed). Returns { ok, reason }.
async function checkSendable(db, email) {
  const e = normEmail(email);
  if (!e) return { ok: false, reason: 'no valid email' };
  const { rows } = await db.query(
    `SELECT reason FROM px_suppression WHERE email = $1 OR (email IS NULL AND domain = $2) LIMIT 1`,
    [e, emailDomain(e)]
  );
  if (rows[0]) return { ok: false, reason: 'suppressed (' + rows[0].reason + ')' };

  // Current AutoPost customers are never cold-emailed.
  const cust = await db.query(
    `SELECT 1 FROM autopost_users WHERE LOWER(email) = $1 AND LOWER(COALESCE(subscription_status,'')) IN ('active','trialing') LIMIT 1`,
    [e]
  );
  if (cust.rows[0]) return { ok: false, reason: 'current AutoPost customer' };
  return { ok: true };
}

const REASON_TO_STATE = {
  unsubscribe: 'UNSUBSCRIBED',
  complaint: 'SUPPRESSED',
  bounce: 'BOUNCED',
  declined: 'NOT_INTERESTED',
  customer: 'CUSTOMER',
  manual: 'SUPPRESSED',
  invalid: 'SUPPRESSED',
  wrong_person: 'SUPPRESSED'
};

async function suppress(pool, { email, domain, reason, source, notes, actor }) {
  const e = normEmail(email);
  const d = domain ? String(domain).trim().toLowerCase() : null;
  if (!e && !d) throw new Error('Need an email or a domain to suppress.');
  if (!REASON_TO_STATE[reason]) throw new Error('Unknown suppression reason: ' + reason);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO px_suppression (email, domain, reason, source, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [e, e ? null : d, reason, source, notes || null]
    );
    const contacts = await client.query(
      e ? `SELECT id, state FROM px_contacts WHERE email = $1`
        : `SELECT id, state FROM px_contacts WHERE split_part(email, '@', 2) = $1`,
      [e || d]
    );
    const target = REASON_TO_STATE[reason];
    for (const c of contacts.rows) {
      // Whatever state they are in, outreach is over. Prefer the precise state;
      // fall back to SUPPRESSED; leave already-terminal leads where they are.
      const to = stateMachine.canTransition(c.state, target) ? target
        : stateMachine.canTransition(c.state, 'SUPPRESSED') ? 'SUPPRESSED' : null;
      if (to) await stateMachine.transition(client, c.id, to, actor || 'system:suppression', { reason, source });
    }
    await client.query('COMMIT');
    return { suppressed: e || d, contactsUpdated: contacts.rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { checkSendable, suppress, normEmail, emailDomain };

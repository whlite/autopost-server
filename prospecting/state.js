// prospecting/state.js — the lead state machine
//
// Every contact is in exactly one state. The only way to change it is
// transition(), which locks the row, checks the move against TRANSITIONS,
// writes the new state and appends a px_events row in the same transaction.
//
// The rule that matters most: once someone is UNSUBSCRIBED, SUPPRESSED,
// NOT_INTERESTED, BOUNCED or a CUSTOMER, no transition leads back into the
// outreach states (APPROVED_FOR_OUTREACH, QUEUED, CONTACTED).

const STATES = [
  'DISCOVERED', 'RESEARCHED', 'QUALIFIED', 'VERIFIED', 'APPROVED_FOR_OUTREACH',
  'QUEUED', 'CONTACTED', 'AWAITING_REPLY', 'REPLIED', 'INTERESTED',
  'DEMO_REQUESTED', 'FOLLOW_UP_REQUIRED', 'CUSTOMER', 'NOT_INTERESTED',
  'UNSUBSCRIBED', 'BOUNCED', 'SUPPRESSED'
];

// Allowed moves, besides the global exits below.
const TRANSITIONS = {
  DISCOVERED:            ['RESEARCHED'],
  RESEARCHED:            ['QUALIFIED', 'DISCOVERED'],
  QUALIFIED:             ['VERIFIED', 'RESEARCHED'],
  VERIFIED:              ['APPROVED_FOR_OUTREACH', 'QUALIFIED'],
  APPROVED_FOR_OUTREACH: ['QUEUED', 'VERIFIED'],
  QUEUED:                ['CONTACTED', 'APPROVED_FOR_OUTREACH'],
  CONTACTED:             ['AWAITING_REPLY', 'REPLIED'],
  AWAITING_REPLY:        ['REPLIED'],
  REPLIED:               ['INTERESTED', 'DEMO_REQUESTED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED'],
  INTERESTED:            ['DEMO_REQUESTED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED', 'REPLIED'],
  DEMO_REQUESTED:        ['FOLLOW_UP_REQUIRED', 'INTERESTED', 'NOT_INTERESTED'],
  FOLLOW_UP_REQUIRED:    ['INTERESTED', 'DEMO_REQUESTED', 'NOT_INTERESTED', 'REPLIED'],
  NOT_INTERESTED:        ['REPLIED'],          // they wrote back on their own
  BOUNCED:               ['RESEARCHED'],       // a different, new address was found
  UNSUBSCRIBED:          [],
  SUPPRESSED:            [],
  CUSTOMER:              []
};

// Exits reachable from (almost) anywhere.
const GLOBAL_EXITS = ['UNSUBSCRIBED', 'SUPPRESSED', 'CUSTOMER', 'BOUNCED'];
const TERMINAL_FOR_OUTREACH = ['UNSUBSCRIBED', 'SUPPRESSED', 'NOT_INTERESTED', 'BOUNCED', 'CUSTOMER'];

// States in which an automated promotional email may go out.
const SENDABLE = ['QUEUED', 'CONTACTED'];

function canTransition(from, to) {
  if (STATES.indexOf(to) === -1) return false;
  if (from === to) return false;
  if (from === 'CUSTOMER') return false;
  if (to === 'CUSTOMER') return true;
  if ((from === 'UNSUBSCRIBED' || from === 'SUPPRESSED') && to !== 'CUSTOMER') return false;
  if (to === 'BOUNCED') return ['QUEUED', 'CONTACTED', 'AWAITING_REPLY', 'QUALIFIED', 'VERIFIED', 'APPROVED_FOR_OUTREACH'].indexOf(from) !== -1;
  if (GLOBAL_EXITS.indexOf(to) !== -1) return true;
  return (TRANSITIONS[from] || []).indexOf(to) !== -1;
}

class TransitionError extends Error {
  constructor(from, to) {
    super('Lead cannot move from ' + from + ' to ' + to + '.');
    this.code = 'BAD_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

// client must be inside a transaction (BEGIN already issued).
async function transition(client, contactId, to, actor, detail) {
  const cur = await client.query('SELECT id, state, dealership_id FROM px_contacts WHERE id = $1 FOR UPDATE', [contactId]);
  if (!cur.rows[0]) throw new Error('Contact ' + contactId + ' not found.');
  const from = cur.rows[0].state;
  if (!canTransition(from, to)) throw new TransitionError(from, to);

  const outreachOff = TERMINAL_FOR_OUTREACH.indexOf(to) !== -1;
  await client.query(
    `UPDATE px_contacts
        SET state = $2,
            outreach_eligible = CASE WHEN $3 THEN FALSE ELSE outreach_eligible END,
            score_band = CASE WHEN $2 IN ('UNSUBSCRIBED','SUPPRESSED','BOUNCED') THEN 'SUPPRESSED' ELSE score_band END,
            updated_at = NOW()
      WHERE id = $1`,
    [contactId, to, outreachOff]
  );
  if (outreachOff) {
    await client.query(
      `UPDATE px_enrollments SET status = 'stopped', stop_reason = $2, updated_at = NOW()
        WHERE contact_id = $1 AND status IN ('queued','active','paused')`,
      [contactId, 'lead ' + to.toLowerCase()]
    );
  }
  await client.query(
    `INSERT INTO px_events (event_type, contact_id, dealership_id, from_state, to_state, actor, detail)
     VALUES ('state_change', $1, $2, $3, $4, $5, $6)`,
    [contactId, cur.rows[0].dealership_id, from, to, actor, detail ? JSON.stringify(detail) : null]
  );
  return { from, to };
}

module.exports = { STATES, TRANSITIONS, SENDABLE, TERMINAL_FOR_OUTREACH, canTransition, transition, TransitionError };

// prospecting/settings.js — budgets, limits, the global pause and agent switches
//
// Defaults are deliberately conservative: the engine boots PAUSED with every
// agent disabled, so deploying it sends nothing and spends nothing until the
// owner turns things on from the dashboard.

const DEFAULTS = {
  global_pause: true,                       // stops promotional sends + outbound prospecting; never replies/opt-outs
  budget_monthly_cents: 15000,              // all metered external spend
  budget_daily_ai_cents: 100,
  budget_daily_enrichment_cents: 200,       // contact data + verification
  max_dealers_researched_per_day: 100,
  max_contacts_enriched_per_day: 50,
  max_daily_emails: 30,
  max_contacts_per_dealer: 2,
  max_attempts_per_contact: 3,
  min_qualification_score: 50,
  max_bounce_rate_pct: 3,
  max_complaint_rate_pct: 0.1,
  max_unsubscribe_rate_pct: 2,
  pipeline_target_qualified: 300,
  send_window_start_hour: 9,
  send_window_end_hour: 16,
  send_days: [1, 2, 3, 4, 5],
  target_states: [],                        // empty = all states
  hot_score_min: 80,
  warm_score_min: 50,
  ntfy_topic: '',                           // hot-lead push channel; the topic name is the secret
  // CAN-SPAM: every promotional email carries the sender's real identity and a
  // valid postal address. Sending refuses to start while either is blank.
  company_name: 'Auto Post L.C.',
  sender_name: '',
  sender_postal_address: '',
  demo_url: 'https://tryautopost.com/#demo-video'
};

const AGENTS = [
  { agent: 'hunter',       label: 'Dealership Hunter' },
  { agent: 'researcher',   label: 'Contact Researcher' },
  { agent: 'outreach',     label: 'Outreach Specialist' },
  { agent: 'followup',     label: 'Follow-Up Manager' },
  { agent: 'conversation', label: 'AI Conversation Manager' },
  { agent: 'hotlead',      label: 'Hot Lead Detector' }
];

// Keys whose values never go to the browser.
const SECRET_KEYS = ['ntfy_topic'];

function createSettings(pool) {
  let cache = null;
  let cacheAt = 0;
  const TTL_MS = 15 * 1000;

  async function all() {
    if (cache && Date.now() - cacheAt < TTL_MS) return cache;
    const { rows } = await pool.query('SELECT key, value FROM px_settings');
    const out = Object.assign({}, DEFAULTS);
    for (const r of rows) out[r.key] = r.value;
    cache = out;
    cacheAt = Date.now();
    return out;
  }

  async function get(key) {
    return (await all())[key];
  }

  async function set(key, value, actor) {
    if (!(key in DEFAULTS)) throw new Error('Unknown setting: ' + key);
    const def = DEFAULTS[key];
    if (typeof def === 'number' && (typeof value !== 'number' || !isFinite(value) || value < 0)) {
      throw new Error(key + ' must be a non-negative number.');
    }
    if (typeof def === 'boolean' && typeof value !== 'boolean') throw new Error(key + ' must be true or false.');
    if (Array.isArray(def) && !Array.isArray(value)) throw new Error(key + ' must be a list.');
    if (typeof def === 'string' && (typeof value !== 'string' || value.length > 500)) throw new Error(key + ' must be text.');
    await pool.query(
      `INSERT INTO px_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [key, JSON.stringify(value), actor]
    );
    await pool.query(
      `INSERT INTO px_audit (actor, action, target_type, target_id, detail) VALUES ($1, 'setting_changed', 'setting', $2, $3)`,
      [actor, key, JSON.stringify({ value: SECRET_KEYS.indexOf(key) === -1 ? value : '(hidden)' })]
    );
    cache = null;
  }

  async function publicView() {
    const s = Object.assign({}, await all());
    for (const k of SECRET_KEYS) s[k] = s[k] ? '(set)' : '';
    return s;
  }

  async function seedAgents() {
    for (const a of AGENTS) {
      await pool.query(`INSERT INTO px_agent_status (agent) VALUES ($1) ON CONFLICT (agent) DO NOTHING`, [a.agent]);
    }
  }

  return { all, get, set, publicView, seedAgents, DEFAULTS, AGENTS };
}

module.exports = { createSettings, DEFAULTS, AGENTS };

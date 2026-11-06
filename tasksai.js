// tasksai.js - the AI relay for AutoTasks (the VinSolutions task extension).
//
// WHY IT RUNS HERE
//   AutoTasks used to ship with a Claude API key inside config.js. Anyone who
//   downloads an extension can open its files, so a public download would hand
//   out the key. Now the extension sends its request here and this server adds
//   the real key (ANTHROPIC_API_KEY in Railway). The download holds no secret.
//
// HOW THE EXTENSION TALKS TO IT
//   The extension points the Anthropic SDK at  <server>/api/tasks  as baseURL,
//   so the SDK posts to  /api/tasks/v1/messages  exactly like the real API.
//   Its "api key" is a random per-install id ("at_" + 32 hex), which is only
//   used to count and cap usage per install. The real key never leaves here.
//
// COST CONTROL (every number is a Railway env var, in US dollars)
//   - Haiku 5.5 ONLY (about $0.0005 a customer). TASKS_AI_MODELS can widen it, comma-separated, but never do that
//     without a reason: the whole product is priced on Haiku.
//   - max_tokens capped (TASKS_AI_MAX_TOKENS, default 16000).
//   - Per install per day: TASKS_AI_INSTALL_DAILY_USD (default 3.00).
//   - Whole service per day: TASKS_AI_DAILY_USD (default 75.00).
//   - Cost is measured from the usage Anthropic returns, at list prices.
//   - Days roll over at midnight TASKS_AI_TZ (default America/Denver).
//   - Kill switch: TASKS_AI_OFF=1.
//   - Blocks: TASKS_AI_BLOCKED_INSTALLS (comma-separated install ids).
//   Counts are in memory: a redeploy resets the day, which only ever errs
//   toward letting reps keep working.
//
// ROUTES
//   POST /api/tasks/v1/messages   the relay (Anthropic request and response shapes)
//   GET  /api/tasks/health        { configured, on, todayUsd, dailyUsd, installs }  (no secrets)

const express = require('express');
const fetch = require('node-fetch');

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const MAX_TOKENS = num(process.env.TASKS_AI_MAX_TOKENS, 16000);
const INSTALL_DAILY_USD = num(process.env.TASKS_AI_INSTALL_DAILY_USD, 3);
const DAILY_USD = num(process.env.TASKS_AI_DAILY_USD, 75);
const DAY_TZ = process.env.TASKS_AI_TZ || 'America/Denver';
const OFF = /^(1|true|yes|on)$/i.test(String(process.env.TASKS_AI_OFF || ''));
const BLOCKED = new Set(String(process.env.TASKS_AI_BLOCKED_INSTALLS || '').split(',').map((s) => s.trim()).filter(Boolean));
const INSTALL_RE = /^at_[a-f0-9]{32}$/;
const TIMEOUT_MS = 120000;

// Dollars per million tokens: [input, output]. Fast mode (speed: "fast") is 2x on Opus.
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};
const ALLOWED_MODELS = new Set(
  String(process.env.TASKS_AI_MODELS || 'claude-haiku-5-5').split(',').map((s) => s.trim()).filter((m) => PRICES[m])
);
// Headers the SDK may send that Anthropic needs to see.
const PASS_HEADERS = ['anthropic-version', 'anthropic-beta'];
const CORS_HEADERS = [
  'content-type', 'x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta',
  'anthropic-dangerous-direct-browser-access', 'x-stainless-arch', 'x-stainless-lang',
  'x-stainless-os', 'x-stainless-package-version', 'x-stainless-retry-count',
  'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-timeout',
  'x-stainless-helper-method', 'x-stainless-helper', 'x-stainless-async',
].join(', ');

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const usage = { day: today(), total: 0, perInstall: new Map(), calls: 0 };
function rollDay() {
  const d = today();
  if (d !== usage.day) {
    usage.day = d;
    usage.total = 0;
    usage.calls = 0;
    usage.perInstall.clear();
  }
}

function costOf(model, u, fast) {
  const p = PRICES[model];
  if (!p || !u) return 0;
  const k = fast ? 2 : 1;
  const inTok = (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
  return (k * (inTok * p[0] + (u.output_tokens || 0) * p[1])) / 1e6;
}

// Anthropic-shaped error so the SDK raises the right typed error in the extension.
// Limits and blocks are final for the day: x-should-retry tells the SDK not to retry them.
function fail(res, status, type, message, retry = status >= 500) {
  if (!retry) res.set('x-should-retry', 'false');
  return res.status(status).json({ type: 'error', error: { type, message } });
}

module.exports = function createTasksAi({ apiKey }) {
  const router = express.Router();

  router.use('/api/tasks', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', CORS_HEADERS);
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  router.get('/api/tasks/health', (req, res) => {
    rollDay();
    res.json({
      configured: !!apiKey,
      on: !OFF,
      day: usage.day,
      todayUsd: Number(usage.total.toFixed(4)),
      dailyUsd: DAILY_USD,
      installDailyUsd: INSTALL_DAILY_USD,
      installs: usage.perInstall.size,
      calls: usage.calls,
    });
  });

  router.post('/api/tasks/v1/messages', express.json({ limit: '4mb' }), async (req, res) => {
    rollDay();
    if (!apiKey) return fail(res, 503, 'api_error', 'AutoTasks AI is not set up on the server yet.');
    if (OFF) return fail(res, 503, 'overloaded_error', 'AutoTasks AI is paused for a moment. Try again soon.');

    // The SDK sends the install id as x-api-key, or as a Bearer token when pointed at a custom server.
    const install = String(req.get('x-api-key') || req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!INSTALL_RE.test(install)) return fail(res, 401, 'authentication_error', 'AutoTasks could not identify this install. Reload the extension.');
    if (BLOCKED.has(install)) return fail(res, 403, 'permission_error', 'This AutoTasks install is turned off.');

    const body = req.body && typeof req.body === 'object' ? { ...req.body } : null;
    if (!body || !Array.isArray(body.messages)) return fail(res, 400, 'invalid_request_error', 'Missing messages.');
    if (!ALLOWED_MODELS.has(body.model)) return fail(res, 400, 'invalid_request_error', `AutoTasks writes with Claude Haiku only (asked for ${body.model}). Update AutoTasks.`);
    if (body.speed) delete body.speed; // no fast mode: it bills double
    if (body.stream) return fail(res, 400, 'invalid_request_error', 'Streaming is not available in AutoTasks.');
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
    // Server tools and MCP spend money outside the token count; AutoTasks never uses them.
    delete body.mcp_servers;
    delete body.container;
    if (Array.isArray(body.tools) && body.tools.some((t) => t && t.type && t.type !== 'custom')) {
      return fail(res, 400, 'invalid_request_error', 'Server tools are not available in AutoTasks.');
    }

    const mine = usage.perInstall.get(install) || 0;
    if (usage.total >= DAILY_USD) return fail(res, 429, 'rate_limit_error', 'AutoTasks reached today\'s limit. It resets at midnight.');
    if (mine >= INSTALL_DAILY_USD) return fail(res, 429, 'rate_limit_error', 'You reached today\'s AutoTasks limit. It resets at midnight.');

    const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };
    for (const h of PASS_HEADERS) {
      const v = req.get(h);
      if (v) headers[h] = v;
    }
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const up = await fetch(UPSTREAM, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      const text = await up.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
      if (up.ok && json && json.usage) {
        const spent = costOf(body.model, json.usage, body.speed === 'fast' || json.usage.speed === 'fast');
        usage.total += spent;
        usage.calls += 1;
        usage.perInstall.set(install, mine + spent);
      }
      if (!up.ok) console.error('[tasksai] upstream', up.status, text.slice(0, 300));
      for (const h of ['request-id', 'retry-after']) {
        const v = up.headers.get(h);
        if (v) res.set(h, v);
      }
      // A billing problem on our account is ours, not the rep's: say it plainly.
      if (!up.ok && /credit balance|billing/i.test(text)) {
        return fail(res, 503, 'overloaded_error', 'AutoTasks AI is temporarily unavailable. Try again soon.');
      }
      res.status(up.status).type('application/json').send(text);
    } catch (e) {
      console.error('[tasksai] relay error', e.message);
      if (e.name === 'AbortError') return fail(res, 504, 'api_error', 'The AI took too long. Try again.');
      return fail(res, 502, 'api_error', 'Could not reach the AI. Try again.');
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
};

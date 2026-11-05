// photoscene.js — AutoPost Photo Scenes: stage a car's cover photo like a
// private seller took it on their driveway, with Photoroom's Image
// Editing API.
//
// WHY IT RUNS HERE
//   The Photoroom key is a paid credential. Anything shipped inside the Chrome
//   extension can be read by anyone who installs it, so the extension sends the
//   photo here (with its AutoPost session token) and this server talks to
//   Photoroom. The key lives only in Railway: PHOTOROOM_API_KEY.
//
// COST CONTROL (Photoroom Plus: 1,000 images/month)
//   - Only signed-in, paying (or comped) users: requireActiveSession.
//   - The extension sends ONE photo per car (the cover) and caches the result,
//     so retries and reposts of the same car don't pay again.
//   - Per user: PHOTO_SCENE_DAILY_LIMIT (default 10 cars per day), rolling over
//     at midnight PHOTO_SCENE_TZ (default America/Denver).
//   - Whole account: PHOTO_SCENE_MONTHLY_LIMIT (default 950 per month) so we
//     stop before Photoroom does.
//   - Counts live in Postgres (ap_photo_scene_usage) so a redeploy doesn't
//     reset them; in memory if the DB is unavailable. A failed staging gives
//     the photo back.
//
// POST /api/photo/scene  { image: "data:image/jpeg;base64,...", seed }
//   { ..., scene }  (ignored: every scene is the driveway now)
//   -> 200 { success, dataURL, uncertainty, remainingToday }
//   -> 429 { success:false, error, limit: 'daily' | 'monthly', remainingToday }
// GET  /api/photo/scene/quota   -> { used, limit, remaining }  (signed-in user, for the popup bar)
// GET  /api/photo/scene/health  -> { configured, dailyLimit }  (no secrets)

const express = require('express');

const PHOTOROOM_URL = 'https://image-api.photoroom.com/v2/edit';
const DAILY_LIMIT = Math.max(1, Number(process.env.PHOTO_SCENE_DAILY_LIMIT) || 10);
// Days roll over at local midnight for the dealers (Mountain time by default).
const DAY_TZ = process.env.PHOTO_SCENE_TZ || 'America/Denver';
const MONTHLY_LIMIT = Math.max(1, Number(process.env.PHOTO_SCENE_MONTHLY_LIMIT) || 950);
const TIMEOUT_MS = 70000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// One look: the owner pulled the car onto their driveway and shot it on a phone.
// Photoroom generates the scene and shadows the car to match. The prompt never
// fixes a viewpoint - dealer photos are 3/4 front, profile, rear 3/4, tight crops
// - it tells the model to build the driveway around the car's OWN angle, and
// referenceBox=originalImage (below) keeps the car exactly where the dealer's
// camera framed it, so the ground and horizon follow the real camera height.
const SCENES = {
  driveway: {
    prompt: 'A car parked on the clean concrete driveway of a nice suburban home on a sunny afternoon, ' +
      'an attached garage and a tidy front lawn with trimmed hedges behind it, the driveway continuing ' +
      'under and around the car at the same camera angle, height and perspective as the car, ' +
      'wheels resting naturally on the concrete, soft natural daylight, ' +
      'realistic candid photo taken on a phone by the owner selling their car',
    lighting: 'ai.preserve-hue-and-saturation'
  }
};

module.exports = function createPhotoScene(deps) {
  const requireActiveSession = deps.requireActiveSession;
  const pool = deps.pool || null;
  const router = express.Router();
  const memory = new Map(); // fallback: "user|day" -> count, "*|month" -> count
  let tableReady = null;

  function userKey(req) {
    const s = (req.user && req.user.session) || {};
    return String(s.email || s.clerkUserId || 'unknown').toLowerCase();
  }

  function today() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: DAY_TZ }).format(new Date()); } // YYYY-MM-DD
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }

  function ensureTable() {
    if (!pool) return Promise.reject(new Error('no db'));
    if (!tableReady) {
      tableReady = pool.query(
        'CREATE TABLE IF NOT EXISTS ap_photo_scene_usage (' +
        '  user_key TEXT NOT NULL,' +
        '  day DATE NOT NULL,' +
        '  count INTEGER NOT NULL DEFAULT 0,' +
        '  PRIMARY KEY (user_key, day))'
      ).catch((e) => { tableReady = null; throw e; });
    }
    return tableReady;
  }

  // Reserve one photo for this user today. Returns { ok, remaining, limit }.
  async function reserve(who) {
    const day = today();
    try {
      await ensureTable();
      const month = await pool.query(
        'SELECT COALESCE(SUM(count), 0)::int AS n FROM ap_photo_scene_usage WHERE day >= $1',
        [day.slice(0, 7) + '-01']
      );
      if (month.rows[0].n >= MONTHLY_LIMIT) return { ok: false, limit: 'monthly', remaining: 0 };
      const r = await pool.query(
        'INSERT INTO ap_photo_scene_usage (user_key, day, count) VALUES ($1, $2, 1) ' +
        'ON CONFLICT (user_key, day) DO UPDATE SET count = ap_photo_scene_usage.count + 1 ' +
        'WHERE ap_photo_scene_usage.count < $3 RETURNING count',
        [who, day, DAILY_LIMIT]
      );
      if (!r.rows.length) return { ok: false, limit: 'daily', remaining: 0 };
      return { ok: true, remaining: Math.max(0, DAILY_LIMIT - r.rows[0].count) };
    } catch (e) {
      if (pool) console.error('photoscene: usage DB unavailable, counting in memory:', e.message);
      const k = who + '|' + day, mk = '*|' + day.slice(0, 7);
      if ((memory.get(mk) || 0) >= MONTHLY_LIMIT) return { ok: false, limit: 'monthly', remaining: 0 };
      const n = memory.get(k) || 0;
      if (n >= DAILY_LIMIT) return { ok: false, limit: 'daily', remaining: 0 };
      memory.set(k, n + 1);
      memory.set(mk, (memory.get(mk) || 0) + 1);
      return { ok: true, remaining: Math.max(0, DAILY_LIMIT - n - 1) };
    }
  }

  // Staging failed: give the photo back.
  async function release(who) {
    const day = today();
    try {
      await ensureTable();
      await pool.query(
        'UPDATE ap_photo_scene_usage SET count = GREATEST(count - 1, 0) WHERE user_key = $1 AND day = $2',
        [who, day]
      );
    } catch (e) {
      const k = who + '|' + day, mk = '*|' + day.slice(0, 7);
      if (memory.get(k)) memory.set(k, memory.get(k) - 1);
      if (memory.get(mk)) memory.set(mk, memory.get(mk) - 1);
    }
  }

  async function usedToday(who) {
    const day = today();
    try {
      await ensureTable();
      const r = await pool.query('SELECT count FROM ap_photo_scene_usage WHERE user_key = $1 AND day = $2', [who, day]);
      return r.rows.length ? r.rows[0].count : 0;
    } catch (e) {
      return memory.get(who + '|' + day) || 0;
    }
  }

  router.get('/api/photo/scene/quota', requireActiveSession, async (req, res) => {
    const used = Math.min(DAILY_LIMIT, await usedToday(userKey(req)));
    res.json({ success: true, used, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used) });
  });

  router.get('/api/photo/scene/health', (req, res) => {
    res.json({ configured: !!process.env.PHOTOROOM_API_KEY, scenes: Object.keys(SCENES), dailyLimit: DAILY_LIMIT });
  });

  router.post('/api/photo/scene', requireActiveSession, async (req, res) => {
    const apiKey = process.env.PHOTOROOM_API_KEY;
    if (!apiKey) return res.status(503).json({ success: false, error: 'Photo scenes are not configured' });

    const body = req.body || {};
    const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(String(body.image || ''));
    if (!m) return res.status(400).json({ success: false, error: 'Expected a base64 image data URL' });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length < 2000 || bytes.length > MAX_IMAGE_BYTES) {
      return res.status(400).json({ success: false, error: 'Image size out of range' });
    }
    const scene = 'driveway'; // park / night / older names all map here now
    const who = userKey(req);
    const quota = await reserve(who);
    if (!quota.ok) {
      console.log('photoscene:', quota.limit, 'limit reached | user', who);
      return res.status(429).json({
        success: false,
        limit: quota.limit,
        remainingToday: 0,
        dailyLimit: DAILY_LIMIT,
        error: quota.limit === 'daily' ? 'Daily limit reached (' + DAILY_LIMIT + ' cars per day)' : 'Photo scenes are paused for this month'
      });
    }

    const form = new FormData();
    form.append('imageFile', new Blob([bytes], { type: 'image/' + (m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()) }), 'car.jpg');
    form.append('background.prompt', SCENES[scene].prompt);
    const seed = Math.abs(parseInt(body.seed, 10)) % 2147483647;
    if (seed) form.append('background.seed', String(seed));
    form.append('shadow.mode', 'ai.auto-with-overrides');
    form.append('lighting.mode', SCENES[scene].lighting);
    form.append('outputSize', 'originalImage');
    // Keep the car where the dealer framed it (no re-centering / padding), so the
    // generated driveway matches that photo's angle and camera height.
    form.append('referenceBox', 'originalImage');
    form.append('export.format', 'jpeg');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const started = Date.now();
    try {
      const r = await fetch(PHOTOROOM_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'pr-ai-background-model-version': 'background-studio-beta-2025-03-17',
          'pr-ai-shadows-model-version': '2026-04-15'
        },
        body: form,
        signal: ctrl.signal
      });
      if (!r.ok) {
        let msg = '';
        try { const j = await r.json(); msg = (j && j.error && j.error.message) || j.detail || ''; } catch (e) {}
        console.error('photoscene: Photoroom', r.status, msg, '| user', who);
        await release(who);
        // Out of credits / bad key is our problem, not the user's request.
        const status = (r.status === 401 || r.status === 402 || r.status === 403) ? 503 : (r.status === 429 ? 503 : 502);
        return res.status(status).json({ success: false, error: 'Photo scene service unavailable (' + r.status + ')' });
      }
      const out = Buffer.from(await r.arrayBuffer());
      const uncertainty = parseFloat(r.headers.get('x-uncertainty-score'));
      console.log('photoscene:', scene, '|', out.length, 'bytes |', Date.now() - started, 'ms | uncertainty', uncertainty, '| user', who, '| left today', quota.remaining);
      res.json({
        success: true,
        dataURL: 'data:image/jpeg;base64,' + out.toString('base64'),
        uncertainty: isFinite(uncertainty) ? uncertainty : null,
        remainingToday: quota.remaining,
        dailyLimit: DAILY_LIMIT
      });
    } catch (e) {
      console.error('photoscene: request failed:', e.name === 'AbortError' ? 'timeout' : e.message, '| user', who);
      await release(who);
      res.status(504).json({ success: false, error: 'Photo scene timed out' });
    } finally {
      clearTimeout(timer);
    }
  });

  return { router };
};

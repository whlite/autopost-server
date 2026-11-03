// photoscene.js — AutoPost Photo Scenes: put a car's exterior photos into a
// realistic "private seller" park scene, or onto clean black / white, with
// Photoroom's Image Editing API.
//
// WHY IT RUNS HERE
//   The Photoroom key is a paid credential. Anything shipped inside the Chrome
//   extension can be read by anyone who installs it, so the extension sends the
//   photo here (with its AutoPost session token) and this server talks to
//   Photoroom. The key lives only in Railway: PHOTOROOM_API_KEY.
//
// COST CONTROL
//   - Only signed-in, paying (or comped) users: requireActiveSession.
//   - The extension already filters to exterior shots on-device before calling.
//   - Per-user daily cap: PHOTO_SCENE_DAILY_LIMIT (default 150 images/day).
//
// POST /api/photo/scene  { image: "data:image/jpeg;base64,...", scene, seed }
//   -> 200 { success, dataURL, uncertainty }   (uncertainty: Photoroom's cut-out
//      confidence, 0 = sure, 1 = unsure; the extension keeps the original above
//      a threshold)
// GET  /api/photo/scene/health  -> { configured }  (no secrets, no credits used)

const express = require('express');

const PHOTOROOM_URL = 'https://image-api.photoroom.com/v2/edit';
const DAILY_LIMIT = Math.max(1, Number(process.env.PHOTO_SCENE_DAILY_LIMIT) || 150);
const TIMEOUT_MS = 70000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Three looks, chosen to be dependable:
//   outdoor - the car "taken to the park" by a private seller: Photoroom
//             generates the scene and relights/shadows the car to match.
//   black / white - clean solid backdrops with a real contact shadow; no
//             generation, so nothing can come out strange.
const OUTDOOR_PROMPT = 'A car parked in a quiet parking spot at the edge of a green city park on a sunny afternoon, ' +
  'mature shade trees, a grassy lawn and a walking path behind it, clean asphalt, soft natural daylight, ' +
  'realistic candid photo taken on a phone by a private seller';
const SCENES = {
  outdoor: { prompt: OUTDOOR_PROMPT },
  black: { color: '0B0B0C' },
  white: { color: 'FFFFFF' }
};
// Scene names from earlier extension builds.
const LEGACY = { driveway: 'outdoor', street: 'outdoor', lot: 'outdoor', scenic: 'outdoor' };

module.exports = function createPhotoScene(deps) {
  const requireActiveSession = deps.requireActiveSession;
  const router = express.Router();
  const usage = new Map(); // email|day -> count

  function userKey(req) {
    const s = (req.user && req.user.session) || {};
    return String(s.email || s.userId || s.username || 'unknown').toLowerCase();
  }

  function takeQuota(who) {
    const day = new Date().toISOString().slice(0, 10);
    const k = who + '|' + day;
    const n = usage.get(k) || 0;
    if (n >= DAILY_LIMIT) return false;
    usage.set(k, n + 1);
    if (usage.size > 5000) {
      for (const key of usage.keys()) if (!key.endsWith('|' + day)) usage.delete(key);
    }
    return true;
  }

  router.get('/api/photo/scene/health', (req, res) => {
    res.json({ configured: !!process.env.PHOTOROOM_API_KEY, scenes: Object.keys(SCENES), dailyLimit: DAILY_LIMIT });
  });

  router.post('/api/photo/scene', requireActiveSession, async (req, res) => {
    const apiKey = process.env.PHOTOROOM_API_KEY;
    if (!apiKey) return res.status(503).json({ success: false, error: 'Photo scenes are not configured' });

    const body = req.body || {};
    const asked = LEGACY[body.scene] || body.scene;
    const scene = Object.prototype.hasOwnProperty.call(SCENES, asked) ? asked : 'outdoor';
    const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(String(body.image || ''));
    if (!m) return res.status(400).json({ success: false, error: 'Expected a base64 image data URL' });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length < 2000 || bytes.length > MAX_IMAGE_BYTES) {
      return res.status(400).json({ success: false, error: 'Image size out of range' });
    }
    const who = userKey(req);
    if (!takeQuota(who)) {
      return res.status(429).json({ success: false, error: 'Daily photo scene limit reached' });
    }

    const form = new FormData();
    form.append('imageFile', new Blob([bytes], { type: 'image/' + (m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()) }), 'car.jpg');
    if (SCENES[scene].prompt) {
      form.append('background.prompt', SCENES[scene].prompt);
      // Same seed for every photo of one car keeps them in the same "place".
      const seed = Math.abs(parseInt(body.seed, 10)) % 2147483647;
      if (seed) form.append('background.seed', String(seed));
    } else {
      form.append('background.color', SCENES[scene].color);
    }
    form.append('shadow.mode', 'ai.auto-with-overrides');
    form.append('lighting.mode', 'ai.preserve-hue-and-saturation');
    form.append('outputSize', 'originalImage');
    form.append('padding', '0.08');
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
        // Out of credits / bad key is our problem, not the user's request.
        const status = (r.status === 401 || r.status === 402 || r.status === 403) ? 503 : (r.status === 429 ? 429 : 502);
        return res.status(status).json({ success: false, error: 'Photo scene service unavailable (' + r.status + ')' });
      }
      const out = Buffer.from(await r.arrayBuffer());
      const uncertainty = parseFloat(r.headers.get('x-uncertainty-score'));
      console.log('photoscene:', scene, '|', out.length, 'bytes |', Date.now() - started, 'ms | uncertainty', uncertainty, '| user', who);
      res.json({
        success: true,
        dataURL: 'data:image/jpeg;base64,' + out.toString('base64'),
        uncertainty: isFinite(uncertainty) ? uncertainty : null
      });
    } catch (e) {
      console.error('photoscene: request failed:', e.name === 'AbortError' ? 'timeout' : e.message, '| user', who);
      res.status(504).json({ success: false, error: 'Photo scene timed out' });
    } finally {
      clearTimeout(timer);
    }
  });

  return { router };
};

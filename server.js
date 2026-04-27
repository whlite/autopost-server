const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

const PORT = process.env.PORT || 8080;

// Sheet ID is not the dangerous secret. This fallback keeps the server alive.
const SHEET_ID = process.env.SHEET_ID || '1IFSySEWA6fO_xYBlZXhb5skbzMQiMjUf';

// Claude/Anthropic key stays protected in Railway Variables.
// This checks multiple possible variable names.
const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY ||
  process.env.CLAUDE_API_KEY ||
  process.env.ANTHROPIC_KEY ||
  process.env.CLAUDE_KEY;

// Session secret fallback keeps server alive for now.
// Later we can force this into Railway only.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'temporary-autopost-session-secret-change-this-in-railway-very-long-2026';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const loginAttempts = new Map();

console.log('AutoPost booting...');
console.log('SHEET_ID loaded:', !!SHEET_ID);
console.log('AI key loaded:', !!ANTHROPIC_API_KEY);
console.log(
  'AI env names found:',
  Object.keys(process.env).filter((k) => k.includes('ANTHROPIC') || k.includes('CLAUDE'))
);
console.log('SESSION_SECRET loaded:', !!SESSION_SECRET);
console.log('PORT:', PORT);

function now() {
  return Date.now();
}

function normalizeUsername(username) {
  return String(username || '').toLowerCase().trim();
}

function safeEqual(a, b) {
  const aString = String(a || '');
  const bString = String(b || '');

  const aBuf = Buffer.from(aString);
  const bBuf = Buffer.from(bString);

  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function rateLimitLogin(username, ip) {
  const key = `${ip}:${normalizeUsername(username)}`;
  const existing = loginAttempts.get(key) || {
    count: 0,
    firstAttempt: now()
  };

  const windowMs = 1000 * 60 * 10;

  if (now() - existing.firstAttempt > windowMs) {
    loginAttempts.set(key, {
      count: 1,
      firstAttempt: now()
    });

    return { allowed: true };
  }

  existing.count += 1;
  loginAttempts.set(key, existing);

  if (existing.count > 10) {
    return {
      allowed: false,
      error: 'Too many login attempts. Try again later.'
    };
  }

  return { allowed: true };
}

function createSessionToken(payload) {
  const session = {
    username: normalizeUsername(payload.username),
    deviceId: String(payload.deviceId || ''),
    issuedAt: now(),
    expiresAt: now() + SESSION_TTL_MS
  };

  const body = Buffer.from(JSON.stringify(session)).toString('base64url');

  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');

  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return {
      valid: false,
      error: 'Missing token'
    };
  }

  const parts = token.split('.');

  if (parts.length !== 2) {
    return {
      valid: false,
      error: 'Invalid token format'
    };
  }

  const [body, sig] = parts;

  if (!body || !sig) {
    return {
      valid: false,
      error: 'Invalid token format'
    };
  }

  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');

  if (!safeEqual(sig, expectedSig)) {
    return {
      valid: false,
      error: 'Invalid token signature'
    };
  }

  let session;

  try {
    session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return {
      valid: false,
      error: 'Invalid token body'
    };
  }

  if (!session.expiresAt || now() > session.expiresAt) {
    return {
      valid: false,
      error: 'Session expired'
    };
  }

  return {
    valid: true,
    session
  };
}

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === ',' && !inQ) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }

  cols.push(cur.trim());

  return cols;
}

async function getUsers() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Google Sheet fetch failed: ${res.status}`);
  }

  const text = await res.text();
  const lines = text.trim().split('\n');

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());

  function getCol(cols, name, fallbackIndex) {
    const index = headers.indexOf(name.toLowerCase());

    if (index >= 0) {
      return cols[index] || '';
    }

    return cols[fallbackIndex] || '';
  }

  const users = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) {
      continue;
    }

    const cols = parseCsvLine(lines[i]);

    const username = normalizeUsername(getCol(cols, 'username', 0));
    const password = String(getCol(cols, 'password', 1) || '').trim();
    const activeRaw = String(getCol(cols, 'active', 2) || '').trim().toUpperCase();

    const plan = String(getCol(cols, 'plan', 3) || 'starter').trim();
    const subscriptionStatus = String(getCol(cols, 'subscriptionstatus', 4) || '').trim().toLowerCase();
    const deviceLimitRaw = Number(getCol(cols, 'devicelimit', 5) || 1);

    if (!username || username === 'username') {
      continue;
    }

    users.push({
      username,
      password,
      active: activeRaw === 'TRUE',
      plan,
      subscriptionStatus,
      deviceLimit: Number.isFinite(deviceLimitRaw) && deviceLimitRaw > 0 ? deviceLimitRaw : 1
    });
  }

  return users;
}

async function findUser(username) {
  const users = await getUsers();
  return users.find((u) => u.username === normalizeUsername(username));
}

function publicUser(user) {
  return {
    username: user.username,
    active: user.active,
    plan: user.plan || 'starter',
    subscriptionStatus: user.subscriptionStatus || '',
    deviceLimit: user.deviceLimit || 1
  };
}

async function requireActiveSession(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const tokenFromHeader = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const token = tokenFromHeader || req.body.token;

    const verified = verifySessionToken(token);

    if (!verified.valid) {
      return res.status(401).json({
        success: false,
        active: false,
        error: verified.error
      });
    }

    const user = await findUser(verified.session.username);

    if (!user || !user.active) {
      return res.status(403).json({
        success: false,
        active: false,
        error: 'Account inactive. Please check your subscription.'
      });
    }

    req.session = verified.session;
    req.user = user;

    next();
  } catch (e) {
    console.error('Session check error:', e.message);

    return res.status(500).json({
      success: false,
      active: false,
      error: 'Server error'
    });
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'AutoPost server running',
    version: '2.3',
    auth: 'token',
    sheetLoaded: !!SHEET_ID,
    aiConfigured: !!ANTHROPIC_API_KEY
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: '2.3',
    time: new Date().toISOString(),
    sheetLoaded: !!SHEET_ID,
    aiConfigured: !!ANTHROPIC_API_KEY
  });
});

// TEMPORARY DEBUG ROUTE
// This does NOT show your key. It only shows whether Railway can see it.
// We will delete this after the key works.
app.get('/debug-env', (req, res) => {
  res.json({
    hasAnthropicApiKey: !!process.env.ANTHROPIC_API_KEY,
    hasClaudeApiKey: !!process.env.CLAUDE_API_KEY,
    hasAnthropicKey: !!process.env.ANTHROPIC_KEY,
    hasClaudeKey: !!process.env.CLAUDE_KEY,
    matchingEnvNames: Object.keys(process.env).filter((k) =>
      k.includes('ANTHROPIC') || k.includes('CLAUDE')
    )
  });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password, deviceId } = req.body;

    const normalizedUsername = normalizeUsername(username);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    const limited = rateLimitLogin(normalizedUsername, ip);

    if (!limited.allowed) {
      return res.status(429).json({
        success: false,
        error: limited.error
      });
    }

    console.log('Login attempt:', normalizedUsername);

    const user = await findUser(normalizedUsername);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password'
      });
    }

    if (!safeEqual(user.password, String(password || '').trim())) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password'
      });
    }

    if (!user.active) {
      return res.status(403).json({
        success: false,
        error: 'Account inactive. Please check your subscription.'
      });
    }

    const token = createSessionToken({
      username: normalizedUsername,
      deviceId
    });

    console.log('Login success:', normalizedUsername);

    return res.json({
      success: true,
      token,
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
      user: publicUser(user)
    });
  } catch (e) {
    console.error('Login error:', e.message);

    return res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

app.post('/verify-session', requireActiveSession, async (req, res) => {
  return res.json({
    success: true,
    active: true,
    user: publicUser(req.user)
  });
});

app.post('/logout', (req, res) => {
  return res.json({
    success: true
  });
});

app.post('/describe', requireActiveSession, async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(501).json({
        success: false,
        error: 'AI description service is not configured'
      });
    }

    const { vehicle = {}, settings = {} } = req.body;

    const extra = String(settings.aiInstructions || '').trim();
    const dealerText = String(vehicle.dealerDescription || '').slice(0, 2000);
    const mileage = vehicle.mileage ? Number(vehicle.mileage).toLocaleString() + ' miles' : '';

    const prompt = `You are writing a Facebook Marketplace car listing. Use this exact format:

2019 Mercedes-Benz GLC 300
- Exterior: Polar White
- Interior: Black
- Drivetrain: AWD 4MATIC
- Transmission: 9-Speed Automatic
- Engine: 2.0L Turbocharged 4-Cylinder
- Mileage: 66,131 miles

DM for more info! We carry Porsche, Mercedes & Audi.

Vehicle title: ${vehicle.title || 'Unknown'}
Exterior color: ${vehicle.color || 'find in dealer text'}
${mileage ? 'Mileage: ' + mileage : ''}

Dealer page text:
${dealerText || 'Not available'}

Rules:
1. First line must be year make model only.
2. Specs must use "- Label: Value".
3. Do not invent colors.
4. Use known vehicle specs only when highly confident.
5. Do not include emojis.
6. After specs, add one blank line.
${extra ? '7. Then add this text exactly:\n' + extra : '7. End with: DM for more info!'}

Write the listing now.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();

      console.error('Anthropic error:', aiRes.status, errText.slice(0, 500));

      return res.status(502).json({
        success: false,
        error: 'AI description failed'
      });
    }

    const data = await aiRes.json();
    const description = data.content && data.content[0] ? data.content[0].text.trim() : '';

    return res.json({
      success: true,
      description
    });
  } catch (e) {
    console.error('Describe error:', e.message);

    return res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

app.listen(PORT, () => {
  console.log(`AutoPost running on port ${PORT}`);
});

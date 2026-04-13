const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SHEET_ID = process.env.SHEET_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3000;

async function getUsers() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  console.log('Fetching sheet:', url);
  const res = await fetch(url);
  const text = await res.text();
  console.log('Sheet raw (first 300):', text.slice(0, 300));

  const lines = text.trim().split('\n');
  const users = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Parse CSV properly handling quoted fields
    const cols = [];
    let current = '';
    let inQuote = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') {
        inQuote = !inQuote;
      } else if (line[c] === ',' && !inQuote) {
        cols.push(current.trim());
        current = '';
      } else {
        current += line[c];
      }
    }
    cols.push(current.trim());

    const username = (cols[0] || '').toLowerCase().trim();
    const password = (cols[1] || '').trim();
    const active = (cols[2] || '').toUpperCase() === 'TRUE';

    if (username && username !== 'username') {
      users.push({ username, password, active });
    }
  }

  console.log('Parsed users:', users.map(u => ({ username: u.username, active: u.active })));
  return users;
}

app.get('/', (req, res) => {
  res.json({ status: 'AutoPost server running', version: '1.0' });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Login attempt:', username);

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const users = await getUsers();
    const user = users.find(u => u.username === username.toLowerCase().trim());

    if (!user) {
      console.log('User not found:', username);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (user.password !== password.trim()) {
      console.log('Wrong password for:', username);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.active) {
      console.log('Inactive user:', username);
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    console.log('Login success:', username);
    res.json({ success: true, message: 'Welcome to AutoPost!' });

  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
});

app.post('/describe', async (req, res) => {
  try {
    const { username, password, vehicle, settings } = req.body;

    const users = await getUsers();
    const user = users.find(u => u.username === (username || '').toLowerCase().trim());
    if (!user || user.password !== (password || '').trim() || !user.active) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const includeMileage = settings.chkMileage !== false;
    const extra = (settings.aiInstructions || '').trim();
    const dealerText = (vehicle.dealerDescription || '').slice(0, 1500);

    const prompt =
      'Write a Facebook Marketplace vehicle listing.\n\n' +
      'EXACT FORMAT:\n' +
      '[Year] [Make] [Model]\n' +
      '- Exterior: [color — omit line if unknown]\n' +
      '- Interior: [color — omit line if unknown]\n' +
      '- Drivetrain: [AWD/FWD/RWD/4WD]\n' +
      '- Transmission: [e.g. 7-Speed Automatic]\n' +
      '- Engine: [e.g. 2.0L Turbo 4-Cylinder]\n' +
      (includeMileage && vehicle.mileage ? '- Mileage: ' + Number(vehicle.mileage).toLocaleString() + ' miles\n' : '') +
      '\n' +
      (extra ? 'MANDATORY CUSTOM TEXT (include word for word):\n' + extra + '\n\n' : '') +
      'RULES:\n- Use vehicle knowledge for specs\n- Omit color lines if unknown\n- NO price, NO VIN\n- Include all custom text\n\n' +
      'VEHICLE:\nTitle: ' + (vehicle.title || '') + '\nYear: ' + (vehicle.year || '') +
      '\nExterior: ' + (vehicle.color || 'unknown') +
      '\nMileage: ' + (vehicle.mileage ? Number(vehicle.mileage).toLocaleString() + ' miles' : 'not listed') +
      '\nDealer text:\n' + dealerText;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await aiRes.json();
    const text = data.content && data.content[0] ? data.content[0].text : '';
    res.json({ description: text });

  } catch (e) {
    console.error('Describe error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log('AutoPost server running on port', PORT));

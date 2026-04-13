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

// Hardcoded as fallback in case env vars don't load
const SHEET_ID = process.env.SHEET_ID || '1IFSySEWA6fO_xYBlZXhb5skbzMQiMjUf';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const PORT = process.env.PORT || 8080;

console.log('SHEET_ID:', SHEET_ID);
console.log('PORT:', PORT);
console.log('API KEY set:', !!CLAUDE_API_KEY);

async function getUsers() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  console.log('Fetching:', url);
  const res = await fetch(url);
  const text = await res.text();
  console.log('Sheet response (first 200):', text.slice(0, 200));

  const lines = text.trim().split('\n');
  const users = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cols = [];
    let cur = '';
    let inQ = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') { inQ = !inQ; }
      else if (line[c] === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else { cur += line[c]; }
    }
    cols.push(cur.trim());

    const username = (cols[0] || '').toLowerCase().trim();
    const password = (cols[1] || '').trim();
    const active = (cols[2] || '').toUpperCase() === 'TRUE';

    if (username && username !== 'username') {
      users.push({ username, password, active });
      console.log('Found user:', username, '| active:', active);
    }
  }
  return users;
}

app.get('/', (req, res) => {
  res.json({ status: 'AutoPost server running', version: '1.0', sheetId: SHEET_ID });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Login attempt:', username);

    const users = await getUsers();
    const user = users.find(u => u.username === (username || '').toLowerCase().trim());

    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (user.password !== (password || '').trim()) return res.status(401).json({ error: 'Invalid username or password' });
    if (!user.active) return res.status(403).json({ error: 'Account suspended. Contact support.' });

    console.log('Login success:', username);
    res.json({ success: true });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
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
      'Write a Facebook Marketplace vehicle listing.\n\nEXACT FORMAT:\n' +
      '[Year] [Make] [Model]\n- Exterior: [color — omit if unknown]\n' +
      '- Interior: [color — omit if unknown]\n- Drivetrain: [AWD/FWD/RWD]\n' +
      '- Transmission: [type]\n- Engine: [type]\n' +
      (includeMileage && vehicle.mileage ? '- Mileage: ' + Number(vehicle.mileage).toLocaleString() + ' miles\n' : '') +
      '\n' + (extra ? 'MANDATORY: ' + extra + '\n\n' : '') +
      'RULES: Use vehicle knowledge for specs. Omit unknown colors. No price/VIN.\n\n' +
      'VEHICLE:\nTitle: ' + (vehicle.title||'') + '\nYear: ' + (vehicle.year||'') +
      '\nColor: ' + (vehicle.color||'unknown') +
      '\nMileage: ' + (vehicle.mileage ? Number(vehicle.mileage).toLocaleString()+' miles' : 'not listed') +
      '\nDealer text:\n' + dealerText;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });

    const data = await aiRes.json();
    res.json({ description: data.content && data.content[0] ? data.content[0].text : '' });
  } catch (e) {
    console.error('Describe error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log('AutoPost running on port', PORT));

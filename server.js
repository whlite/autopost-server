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

// Fetch users from Google Sheet
async function getUsers() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Users`;
  const res = await fetch(url);
  const text = await res.text();
  const lines = text.trim().split('\n');
  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (cols[0]) {
      users.push({
        username: cols[0].toLowerCase(),
        password: cols[1],
        active: cols[2] ? cols[2].toUpperCase() === 'TRUE' : false
      });
    }
  }
  return users;
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AutoPost server running' });
});

// Login endpoint
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const users = await getUsers();
    const user = users.find(u => u.username === username.toLowerCase().trim());

    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (user.password !== password.trim()) return res.status(401).json({ error: 'Invalid username or password' });
    if (!user.active) return res.status(403).json({ error: 'Account suspended. Contact support.' });

    res.json({ success: true, message: 'Welcome to AutoPost!' });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
});

// Generate AI description
app.post('/describe', async (req, res) => {
  try {
    const { username, password, vehicle, settings } = req.body;

    // Re-verify credentials on every request
    const users = await getUsers();
    const user = users.find(u => u.username === username.toLowerCase().trim());
    if (!user || user.password !== password.trim() || !user.active) {
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
      'RULES:\n' +
      '- Use your vehicle knowledge for specs\n' +
      '- Omit Exterior/Interior if unknown\n' +
      '- NO price, NO VIN, NO stock number\n' +
      '- Include all custom text exactly\n\n' +
      'VEHICLE:\n' +
      'Title: ' + (vehicle.title || '') + '\n' +
      'Year: ' + (vehicle.year || '') + '\n' +
      'Exterior color: ' + (vehicle.color || 'unknown') + '\n' +
      'Mileage: ' + (vehicle.mileage ? Number(vehicle.mileage).toLocaleString() + ' miles' : 'not listed') + '\n' +
      'Dealer text:\n' + dealerText;

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
    res.status(500).json({ error: 'Server error generating description' });
  }
});

app.listen(PORT, () => console.log('AutoPost server running on port', PORT));

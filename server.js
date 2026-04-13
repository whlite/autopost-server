const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SHEET_ID = '1IFSySEWA6fO_xYBlZXhb5skbzMQiMjUf';
const CLAUDE_API_KEY = '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';
const PORT = process.env.PORT || 8080;

console.log('SHEET_ID:', SHEET_ID);
console.log('PORT:', PORT);

async function getUsers() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  const res = await fetch(url);
  const text = await res.text();
  const lines = text.trim().split('\n');
  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = [];
    let cur = '', inQ = false;
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
    }
  }
  return users;
}

app.get('/', (req, res) => {
  res.json({ status: 'AutoPost server running', version: '1.0' });
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

    // Verify credentials
    const users = await getUsers();
    const user = users.find(u => u.username === (username || '').toLowerCase().trim());
    if (!user || user.password !== (password || '').trim() || !user.active) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const extra = (settings.aiInstructions || '').trim();
    const includeMileage = settings.chkMileage !== false;
    const dealerText = (vehicle.dealerDescription || '').slice(0, 2000);
    const mileage = vehicle.mileage ? Number(vehicle.mileage).toLocaleString() + ' miles' : '';

    console.log('---');
    console.log('Vehicle:', vehicle.title);
    console.log('Custom instructions:', extra || '(none)');
    console.log('Mileage:', mileage || 'not found');
    console.log('Dealer text length:', dealerText.length);

    // Build prompt with a concrete example the AI must follow
    const prompt = `You are writing a Facebook Marketplace car listing. Study this PERFECT example carefully:

EXAMPLE:
2019 Mercedes-Benz GLC 300
- Exterior: Polar White
- Interior: Black
- Drivetrain: AWD 4MATIC
- Transmission: 9-Speed Automatic
- Engine: 2.0L Turbocharged 4-Cylinder
- Mileage: 66,131 miles

DM for more info! We carry Porsche, Mercedes & Audi.

NOW write the listing for this vehicle using the EXACT same format:

Vehicle title: ${vehicle.title || 'Unknown'}
Exterior color: ${vehicle.color || 'find in dealer text'}
${mileage ? 'Mileage: ' + mileage : ''}

Dealer page text (find interior color, drivetrain, engine, transmission here):
${dealerText || 'Not available'}

RULES YOU MUST FOLLOW:
1. First line = year make model ONLY. No dashes. No bullets. No extra words.
2. Each spec = "- Label: Value" format
3. Use your built-in knowledge for engine/transmission/drivetrain specs for this exact vehicle
4. Only omit a line if you truly cannot find or know the value
5. DO NOT write "- Year:", "- Make:", "- Model:", "- Miles:" as bullets - those are WRONG
6. After the specs, add ONE blank line
${extra ? '7. Then add this text EXACTLY as written, word for word:\n' + extra : '7. End with: DM for more info!'}

Write the listing now:`;

    console.log('Prompt length:', prompt.length);

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await aiRes.json();
    const description = data.content && data.content[0] ? data.content[0].text.trim() : '';
    console.log('Description output:\n' + description);
    console.log('---');

    res.json({ description });

  } catch (e) {
    console.error('Describe error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.listen(PORT, () => console.log('AutoPost running on port', PORT));

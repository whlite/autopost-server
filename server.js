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
console.log('API KEY starts with:', CLAUDE_API_KEY.slice(0, 20));
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
// Use the full prompt sent from the extension
const prompt = settings.promptOverride || buildPrompt(vehicle, settings);
console.log('Generating description for:', vehicle.title);
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
const description = data.content && data.content[0] ? data.content[0].text : '';
console.log('Description generated:', description.slice(0, 100));
res.json({ description });
} catch (e) {
console.error('Describe error:', e.message);
res.status(500).json({ error: 'Server error: ' + e.message });
}
});
function buildPrompt(vehicle, settings) {
const extra = (settings.aiInstructions || '').trim();
const includeMileage = settings.chkMileage !== false;
const dealerText = (vehicle.dealerDescription || '').slice(0, 2000);
return 'Write a detailed Facebook Marketplace vehicle listing with bullet points.\n\n' +
'FORMAT:\n[Year] [Make] [Model]\n' +
'- Exterior Color: [color]\n- Interior Color: [color]\n' +
'- Body Style: [type]\n- Drivetrain: [AWD/FWD/RWD]\n' +
'- Transmission: [type]\n- Engine: [specs and hp]\n' +
(includeMileage && vehicle.mileage ? '- Mileage: ' + Number(vehicle.mileage).toLocaleString() + ' miles\n' : '') +
'- Condition: [Excellent/Good/Fair]\n\n' +
(extra ? extra + '\n\n' : '') +
'Use your vehicle knowledge for specs. Extract colors from dealer text.\n\n' +
'Title: ' + (vehicle.title || '') + '\n' +
'Color: ' + (vehicle.color || 'unknown') + '\n' +
'Dealer text:\n' + dealerText;
}
app.listen(PORT, () => console.log('AutoPost running on port', PORT));

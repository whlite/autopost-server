// diagreport.mjs: reads an AutoTasks diagnostic and answers two questions.
//   1. READINESS: do we have everything needed to code this CRM, the same way VinSolutions was coded?
//   2. REPORT: a compact, paste-able text of what the diagnostic found.
//
// THE STANDARD. VinSolutions was coded from what content.js had to do. Every check below is one of those jobs, so a CRM
// that passes all of them can be coded right the first time:
//   LIST     find each task row, its customer id, name, vehicle, the Text / Email / Call buttons, Refresh
//   TEXT     click a text task -> where the text box appears, how fast, the box, the Send button, the window type
//   EMAIL    click an email task -> the composer, subject, the body editor (frame, rich text), template, Send, Cancel
//   CUSTOMER open a customer -> notes and history (who, when, direction), phones, vehicle, trade, status, opt-in, lazy loading
//   SEND     a real send to the tester themself -> what proves it went out
//   DONE     finishing a task and refreshing
//
// One copy of this file ships in the extension and one on the server (autopost-server/diagreport.mjs). Keep them identical.

// ---- shared reading helpers
const frames = (s) => (s?.pages || []).flatMap((p, pi) => (p.frames || []).map((f) => ({ ...f, win: pi, popup: !!p.popup, active: !!p.active })));
const controls = (s) => frames(s).flatMap((f) => (f.controls || []).map((c) => ({ ...c, _f: f })));
const walk = (n, fn, depth = 0, path = []) => { if (!n) return; fn(n, depth, path); for (const k of n.k || []) walk(k, fn, depth + 1, [...path, n]); };
const nodes = (s, test) => { const out = []; for (const f of frames(s)) walk(f.tree, (n, d, p) => { if (test(n, p, f)) out.push({ n, f, p }); }); return out; };
const evs = (s, kind) => (s?.events || []).filter((e) => e.k === kind);
const RX = {
  text: /\b(text|sms|message|reply|respond|chat)\b/i,
  email: /e-?mail/i,
  call: /\b(call|phone|dial)\b/i,
  send: /\bsend\b/i,
  refresh: /refresh|reload|sync/i,
  subject: /subject/i,
  cancel: /cancel|close|discard/i,
  body: /message|body|text|sms|compose|write|type/i,
  phone: /phone|cell|mobile|tel\b/i,
  vehicle: /vehicle|make|model|year|vin\b|stock|trade/i,
  lead: /status|source|lead|rep|salesperson|assigned|created|received|contact/i,
};
// An id that survived masking: 9s (1.5.1+) or the older "[phone]" mask on a bare number.
const ID_RX = /9{4,}|\[phone\]/;
const DATE_RX = /\b9{1,2}\/9{1,2}\/9{2,4}\b|\b9{4}-99-99\b|\b9{1,2}:99\b/;
const NOISE_RX = /\b(menu|nav|navbar|tab|tablist|breadcrumb|pagination|pager|metric|stat|toolbar|footer|dropdown|option|tooltip|activity-bar)\b|ant-menu|MuiTab/i;
const PATH_NOISE_RX = /\b(nav|navbar|menu|breadcrumb|pagination|toolbar|dropdown)\b|ant-menu|activity-bar|metric/i;
const DIR_KEY_RX = /^data-(direction|tags?|channel|kind|medium|(msg|message|activity|note|event|interaction)-?type)$/;
const idOf = (sel = '') => (String(sel).match(/#([\w-]+)(?!.*#)/) || [])[1] || (String(sel).match(/data-testid="([^"]+)"(?!.*data-testid)/) || [])[1] || '';
// everything a control is known by: what it says, its name, id, test id and picture
const words = (c) => `${c.label || ''} ${c.name || ''} ${c.type || ''} ${c.icon || ''} ${idOf(c.sel).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')}`;
const label = (c) => `${c.label || ''} ${c.name || ''} ${c.type || ''}`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const short = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const urlKey = (u) => String(u || '').split('?')[0].split('#')[0];
const frameKey = (f) => `${f.popup ? 'P' : 'M'}|${urlKey(f.url)}|${f.fe || ''}`;

// Which windows and frames are NEW in a step: not seen in any earlier step (a text window left open is not the email
// window), or seen appearing while recording.
function stepContext(d) {
  const seen = new Set();
  const ctx = {};
  for (const s of d.steps || []) {
    const before = new Set(seen);
    for (const f of frames(s)) seen.add(frameKey(f));
    const adds = (s.events || []).filter((e) => e.k === 'dom').flatMap((e) => e.add || []);
    const added = new Set(adds.map((a) => a.sel));
    const addedFrames = new Set(adds.filter((a) => /^i?frame$/.test(a.tag) && a.id).map((a) => a.id));
    ctx[s.id] = { before, added, addedFrames, first: !before.size };
  }
  return ctx;
}
function freshness(c, cx) {
  if (!cx) return { fresh: false, score: 0 };
  const newWin = !cx.first && !cx.before.has(frameKey(c._f));
  const appeared = cx.added.has(c.sel) || (!!c._f.fe && cx.addedFrames.has(c._f.fe));
  return { fresh: newWin || appeared, newWin, appeared, score: (newWin ? 3 : 0) + (appeared ? 3 : 0) + (newWin && c._f.popup && c._f.top ? 1 : 0) };
}
// The best control for a job: new over old, visible over hidden, then the job's own preference.
function best(s, cx, pred, pref = () => 0) {
  const scored = controls(s).filter(pred).map((c) => { const fr = freshness(c, cx); return { ...c, ...fr, score: fr.score + (c.on ? 3 : -2) + pref(c) }; });
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}
// "Send" / "Send email" / a send-or-save picture button: yes. "Send <something specific>" (a brochure, a quote): weaker.
function sendScore(c) {
  const lab = String(c.label || '').trim(); const id = idOf(c.sel); const pic = `${c.icon || ''}`;
  let n = -20;
  if (/^send( (e-?mail|message|now))?$/i.test(lab)) n = 6;
  else if (/^send\b/i.test(lab)) n = /X/.test(lab) ? -1 : 2; // masked words after "Send": a special-purpose send
  if (/\bsend\b/i.test(pic)) n = Math.max(n, 6);
  if (/send/i.test(id)) n = Math.max(n, 0) + 3;
  else if (/save|submit/i.test(id) && !/draft|template|signature|contact|search/i.test(id)) n = Math.max(n, 0) + 2 + (!lab || c.type === 'image' ? 2 : 0);
  return n;
}
const where = (c) => (c ? `${c.tag}${c.type ? `[${c.type}]` : ''}${c.label ? ` "${c.label}"` : ''}${c.icon ? ` (picture: ${c.icon})` : ''} ${c.sel}${c.fresh ? (c.newWin ? ' (in the window that opened)' : ' (appeared after the click)') : ' (was already on the page)'}${c.on ? '' : ' (hidden)'}` : '');

// Groups of look-alike siblings (task rows, notes): same tag + first class, 2 or more of them.
function groups(s, onlyFrame) {
  const out = [];
  for (const f of frames(s)) {
    if (onlyFrame && !onlyFrame(f)) continue;
    walk(f.tree, (n, depth, path) => {
      const by = new Map();
      for (const k of n.k || []) {
        if (!/^(tr|li|div|article|section|span|a)$/.test(k.t)) continue;
        const key = `${k.t}.${(k.c || '').split(' ')[0]}|${k.a?.role || ''}`;
        const g = by.get(key) || { items: [], count: 0 };
        g.items.push(k); g.count += k.n || 1; by.set(key, g);
      }
      for (const [key, g] of by) {
        const prev = !/^\w+\.\|/.test(key) && out.find((o) => o.f === f && o.key === key);
        if (prev) { prev.items.push(...g.items); prev.count += g.count; } else out.push({ key, items: g.items, count: g.count, f, path: [...path, n] });
      }
    });
  }
  return out.filter((g) => g.count >= 2);
}
const flat = (n) => JSON.stringify(n);
const sizeOf = (n) => { let k = 0; walk(n, () => { k++; }); return k; };
const classOf = (n) => `${n.c || ''} ${n.i || ''} ${Object.keys(n.a || {}).join(' ')}`;
function idAttr(n) {
  let hit = null;
  walk(n, (x) => {
    if (hit) return;
    const e = Object.entries(x.a || {}).find(([k, v]) => k.startsWith('data-') && ID_RX.test(v) && !/date|time|phone/.test(k));
    if (e) hit = { tag: x.t, attr: e[0], value: e[1] };
    else if (x.i && ID_RX.test(x.i) && !hit) hit = { tag: x.t, attr: 'id', value: x.i };
    else if (x.a?.href && /\{n\}|\{id\}/.test(x.a.href)) hit = { tag: x.t, attr: 'href', value: x.a.href };
  });
  return hit;
}

// The task list: the group of rows that looks most like tasks.
function taskRows(L) {
  const cands = groups(L).filter((g) => !g.path.some((p) => /^(nav|header|thead|select)$/.test(p.t) || PATH_NOISE_RX.test(classOf(p))));
  let top = null;
  for (const g of cands) {
    const first = g.items[0];
    const js = flat(g.items.slice(0, 3));
    let score = Math.min(g.count, 25) / 5;
    const size = sizeOf(first);
    if (size > 250) score -= 8; else if (size > 120) score -= 3;
    if (!first.c) score -= 2;
    if (/^tr$/.test(first.t) || first.a?.role === 'row') score += 2;
    if (/row|task|item|card|lead|record/i.test(first.c || '')) score += 1;
    if (NOISE_RX.test(classOf(first))) score -= 6;
    if (idAttr(first)) score += 3;
    if (/"t":"(button|a)"/.test(js)) score += 2;
    if (/"x":"(Text|Email|Phone|Call|Text Reply|Send Text|Send Email|E-?mail)"|"aria-label":"[^"]*(text|email|call)/i.test(js)) score += 4;
    if (/"x":"9{4}\s/.test(js)) score += 1; // a year: a vehicle in the row
    if (!top || score > top.score) top = { ...g, score };
  }
  return top && top.score >= 3 ? top : null;
}
// The notes / history list on a customer's page.
function noteList(C) {
  let top = null;
  for (const g of groups(C)) {
    const first = g.items[0]; const js = flat(g.items.slice(0, 3));
    let score = Math.min(g.count, 20) / 5;
    if (/note|history|activity|timeline|comment|event|log|message|conversation|interaction/i.test(classOf(first))) score += 3;
    const dirAttr = g.items.some((n) => Object.keys(n.a || {}).some((k) => DIR_KEY_RX.test(k)));
    const named = /note|history|activity|timeline|comment|event|log|message|conversation|interaction/i.test(classOf(first));
    if (dirAttr) score += 3;
    if (DATE_RX.test(js)) score += 3; else score -= 4;
    if (!named && !dirAttr) score -= 4;
    if (NOISE_RX.test(classOf(first)) || g.path.some((p) => PATH_NOISE_RX.test(classOf(p)))) score -= 6;
    if (!top || score > top.score) top = { ...g, score };
  }
  return top && top.score >= 5 ? top : null;
}

// The rich-text email body: a frame that is all editor (designMode), a contenteditable, or a frame the composer holds
// whose name says editor/content/body.
function emailBody(E, cx) {
  const fs = frames(E);
  const designed = fs.find((f) => f.editable && !f.top);
  if (designed) return { kind: 'rich-text editor in a frame (whole frame is the editor)', where: `frame ${designed.frameId} inside ${urlKey(designed.url)}` };
  const ce = nodes(E, (n) => n.a?.contenteditable === 'true' || n.a?.contenteditable === '')[0];
  if (ce) return { kind: `contenteditable <${ce.n.t}>${ce.f.top ? '' : ' inside a frame'}`, where: ce.n.i ? `#${ce.n.i}` : ce.n.c ? `.${ce.n.c.split(' ')[0]}` : ce.n.t };
  for (const f of fs) {
    const ed = (f.frames || []).find((x) => /editor|content|body|compose|mce|cke|rich|rad/i.test(`${x.id || ''} ${x.name || ''}`));
    if (ed && freshness({ _f: f, sel: '' }, cx).newWin !== false) {
      const child = fs.find((x) => !x.top && x.win === f.win && urlKey(x.url) === urlKey(f.url) && x.nodes <= 60);
      if (child || ed.on !== false) return { kind: 'rich-text editor in a frame', where: `iframe #${ed.id || ed.name}` };
    }
  }
  const ta = best(E, cx, (c) => c.tag === 'textarea' || c.type === 'textbox', (c) => (RX.body.test(words(c)) ? 2 : 0));
  if (ta && ta.fresh && ta.on) return { kind: 'plain text box', where: where(ta) };
  return null;
}

export function analyze(d) {
  const S = Object.fromEntries((d.steps || []).map((s) => [s.id, s]));
  const CX = stepContext(d);
  const checks = [];
  const add = (group, id, name, ok, evidence, fix) => checks.push({ group, id, name, ok: !!ok, evidence: ok ? evidence : '', fix: ok ? '' : fix });

  // ---- LIST
  const L = S.tasks;
  const rows = L && taskRows(L);
  const row = rows?.items[0];
  add('LIST', 'list.page', 'Task list found', rows, rows ? `rows <${row.t}${row.c ? '.' + row.c.split(' ')[0] : ''}> x${rows.count}` : '', 'We couldn\'t find a list of tasks. Redo "Your task list" with several tasks showing on screen.');
  const rid = rows && rows.items.map(idAttr).find(Boolean);
  add('LIST', 'list.rowid', 'Each row carries an id (customer or task)', rid, rid ? `${rid.tag} ${rid.attr}="${rid.value}"` : '', 'Rows had no id we could see. Add a note saying where the customer\'s id shows (address or attribute) after they open one.');
  const anchor = rows && /"t":"a"|customer-?name|contact-?name/i.test(flat(rows.items));
  add('LIST', 'list.name', 'Customer name link in the row', anchor, 'link inside the row', 'No link to the customer inside a task row. Note how a customer is opened from the list.');
  const rowJs = rows ? flat(rows.items) : '';
  const taskBtns = L ? controls(L).filter((c) => c.tag === 'button' || c.tag === 'a' || c.type === 'button' || c.type === 'image') : [];
  const kinds = new Set(taskBtns.map((c) => (RX.email.test(words(c)) ? 'email' : RX.text.test(words(c)) ? 'text' : RX.call.test(words(c)) ? 'call' : '')).filter(Boolean));
  for (const [k, rx] of [['email', /"x":"[^"]*e-?mail/i], ['text', /"x":"[^"]*\b(text|sms)\b/i], ['call', /"x":"[^"]*\b(call|phone)\b/i]]) if (rx.test(rowJs)) kinds.add(k);
  add('LIST', 'list.types', 'Text / Email / Call tasks tell themselves apart', kinds.has('text') && kinds.has('email'), `found: ${[...kinds].join(', ')}`, `Only found: ${[...kinds].join(', ') || 'none'}. We need to see a row with a Text task AND a row with an Email task (and a Call task if you have them).`);
  add('LIST', 'list.refresh', 'Refresh control', L && controls(L).some((c) => RX.refresh.test(words(c))) || evs(S.done, 'click').some((c) => RX.refresh.test(`${c.label} ${c.cls} ${c.id}`)), 'refresh button', 'No Refresh button seen. Redo "Finish a task and refresh" and press the CRM\'s refresh.');
  add('LIST', 'list.vehicle', 'Vehicle shown in the row', rows && /"x":"9{4}\s/.test(rowJs), 'a year + vehicle text in the row', 'Could not see a vehicle in the task rows (fine if the CRM does not show one there).');

  // ---- TEXT
  const T = S.text; const tx = CX.text;
  const tClicks = evs(T, 'click');
  add('TEXT', 'text.click', 'The click on the Text task was recorded', T && tClicks.length, T ? `${tClicks.length} click(s)` : '', 'We didn\'t see you click a Text button. Redo this step and click a task\'s Text button while it\'s running.');
  const tBox = T && best(T, tx, (c) => c.tag === 'textarea' || c.type === 'textbox' || /contenteditable/.test(`${c.type}`) || (c.tag === 'input' && /^(text|)$/.test(c.type || '') && RX.body.test(words(c))), (c) => (c.tag === 'textarea' ? 2 : 0) + (RX.body.test(words(c)) ? 1 : 0) - (/search/i.test(words(c)) ? 6 : 0));
  const tOpen = tBox?.on && (tBox.fresh || tBox._f.popup) ? (tBox._f.popup ? 'a new browser window/tab' : tBox.newWin ? 'a frame inside the page' : 'on the page (appeared after the click)') : '';
  add('TEXT', 'text.window', 'We know how the text window opens', tOpen, tOpen, 'Nothing new seemed to open. Press Ready only after the text box is on screen.');
  add('TEXT', 'text.box', 'Message box found', tBox && (tBox.fresh || tBox._f.popup) && tBox.on, where(tBox), 'The text box was not in the capture. Make sure the text window is open and empty when you press Ready.');
  const tSend = T && best(T, tx, (c) => /^(button|a|input)$/.test(c.tag) || /button/.test(c.type || ''), (c) => (/^\s*send\b/i.test(c.label || '') ? 5 : /\bsend\b/i.test(words(c)) ? 3 : -20) - (RX.email.test(words(c)) ? 4 : 0) + (tBox && c._f.frameId === tBox._f.frameId && c._f.win === tBox._f.win ? 2 : 0));
  add('TEXT', 'text.send', 'Send button found', tSend && tSend.score > 0 && (tSend.fresh || tSend._f.popup) && tSend.on, where(tSend) + (tSend?.off ? ' (disabled while empty)' : ''), 'No Send button in the text window. Redo with the text window open when you press Ready.');
  const tFirst = tClicks[0];
  const tReady = T && tFirst && [...evs(T, 'dom').filter((e) => (e.add || []).some((a) => /^(textarea|input|i?frame)$/.test(a.tag))).map((e) => e.t), ...(T.tabEvents || []).filter((e) => e.k === 'tab-loaded').map((e) => e.t)].filter((t) => t >= tFirst.t).sort((a, b) => a - b)[0];
  add('TEXT', 'text.timing', 'How long the text window takes to be ready', tReady != null, tReady != null ? secs(tReady - tFirst.t) : '', 'Could not time it.');
  add('TEXT', 'text.shot', 'Screenshot of the text window', T?.shots?.length, `${T?.shots?.length || 0} screenshot(s)`, `No screenshot${T?.shotErrors ? ` (${T.shotErrors[0]})` : ' (pictures were off)'}.`);

  // ---- EMAIL
  const E = S.email; const ex = CX.email;
  add('EMAIL', 'email.click', 'The click on the Email task was recorded', E && evs(E, 'click').length, E ? `${evs(E, 'click').length} click(s)` : '', 'We didn\'t see you click an Email button. Redo this step and click a task\'s Email button while it\'s running.');
  const eSub = E && best(E, ex, (c) => RX.subject.test(words(c)) && /^(input|textarea)$/.test(c.tag));
  const eSubOk = eSub && (eSub.fresh || eSub._f.popup) && eSub.on;
  const eOpen = eSubOk ? (eSub._f.popup ? 'a new browser window/tab' : eSub.newWin ? 'a frame inside the page' : 'on the page (appeared after the click)') : '';
  add('EMAIL', 'email.window', 'We know how the email composer opens', eOpen, eOpen, 'We couldn\'t find a new email window. Close the text window first, then open the email and press Ready once it\'s on screen.');
  add('EMAIL', 'email.subject', 'Subject field', eSubOk, where(eSub), 'No Subject field seen in a new window.');
  const near = (c) => (eSub && c._f.win === eSub._f.win ? 3 : 0) + (eSub && c._f.frameId === eSub._f.frameId ? 1 : 0);
  const eBody = E && emailBody(E, ex);
  add('EMAIL', 'email.body', 'Body editor found (and what kind it is)', eBody, eBody ? `${eBody.kind}: ${eBody.where}` : '', 'The email body editor was not in the capture. Redo with the composer fully loaded (wait for the editor to appear).');
  const eTpl = E && best(E, ex, (c) => c.tag === 'select' && /template|signature|content/i.test(words(c)), near);
  add('EMAIL', 'email.template', 'Template / signature picker (if the CRM has one)', true, eTpl ? where(eTpl) : 'none seen (ok if the CRM has no templates)', '');
  const eSend = E && best(E, ex, (c) => /^(button|a|input)$/.test(c.tag) || /button/.test(c.type || ''),
    (c) => sendScore(c) + near(c) - (/\b(text|sms)\b/i.test(words(c)) ? 6 : 0));
  const eSends = E && eSend ? controls(E).filter((c) => sendScore(c) > 0 && c.on && c._f.win === eSend._f.win && c.sel !== eSend.sel).slice(0, 4) : [];
  add('EMAIL', 'email.send', 'Send button', eSend && eSend.score > 0 && (eSend.fresh || eSend._f.popup) && eSend.on, where(eSend) + (eSends.length ? `  | other send-like buttons there: ${eSends.map((c) => `${c.label || c.icon || ''} #${idOf(c.sel)}`.trim()).join(', ')}` : ''), 'No Send button in the new email window. Redo with the composer open when you press Ready.');
  const eCancel = E && best(E, ex, (c) => /^(button|a|input)$/.test(c.tag) || /button/.test(c.type || ''), (c) => (RX.cancel.test(words(c)) ? 4 : -20) + near(c) - (/attach|upload|progress/i.test(words(c)) ? 3 : 0));
  add('EMAIL', 'email.cancel', 'Cancel / close button', eCancel && eCancel.score > 0, where(eCancel), 'No Cancel or Close button seen (needed to close a window we opened).');
  add('EMAIL', 'email.shot', 'Screenshot of the email window', E?.shots?.length, `${E?.shots?.length || 0} screenshot(s)`, `No screenshot${E?.shotErrors ? ` (${E.shotErrors[0]})` : ' (pictures were off)'}.`);

  // ---- CUSTOMER
  const C = S.customer;
  const notes = C && noteList(C);
  add('CUSTOMER', 'cust.page', 'Customer page captured', C && frames(C).length, C ? `${frames(C).length} frame(s)` : '', 'Redo "A customer\'s page".');
  const nf = notes?.items[0];
  add('CUSTOMER', 'cust.notes', 'Notes / history items found', notes, notes ? `<${nf.t}${nf.c ? '.' + nf.c.split(' ')[0] : ''}> x${notes.count}` : '', 'No notes/history list seen. Scroll the customer\'s history into view before pressing Ready.');
  const dir = notes && notes.items.map((n) => Object.entries(n.a || {}).filter(([k]) => DIR_KEY_RX.test(k))).find((e) => e.length);
  const dirText = notes && /inbound|outbound|incoming|outgoing|received|sent|\bfrom\b|\bto\b/i.test(flat(notes.items));
  add('CUSTOMER', 'cust.direction', 'Each note says inbound/outbound, type and date', notes && (dir || dirText) && DATE_RX.test(flat(notes.items)), dir ? dir.map(([k, v]) => `${k}=${v}`).join(' ') + ' + dates' : 'words like sent/received + dates', 'We could not tell received from sent messages. Pick a customer who has texted or emailed you back.');
  const nameEl = C && nodes(C, (n) => /customer-?name|contact-?name|cust-?name|CustomerName/i.test(`${n.i || ''} ${n.c || ''} ${n.a?.['data-testid'] || ''}`))[0];
  add('CUSTOMER', 'cust.name', 'Where the customer\'s name is', nameEl, nameEl ? `${nameEl.n.t}${nameEl.n.i ? '#' + nameEl.n.i : ''}${nameEl.n.c ? '.' + nameEl.n.c.split(' ')[0] : ''}${nameEl.n.a?.['data-testid'] ? `[data-testid="${nameEl.n.a['data-testid']}"]` : ''}` : '', 'We couldn\'t spot the customer\'s name on their page (we use it to greet them). Add a note saying where it shows.');
  const phone = C && (controls(C).some((c) => /tel:/.test(c.type || '') || RX.phone.test(label(c))) || nodes(C, (n) => n.a?.href?.startsWith('tel:')).length || nodes(C, (n) => RX.phone.test(n.x || '')).length);
  add('CUSTOMER', 'cust.phone', 'Phone numbers (tel: links or labelled fields)', phone, 'found', 'No phone field or tel: link seen on the customer page.');
  const labs = C && nodes(C, (n) => /^(label|th|dt|span|div|td|b|strong)$/.test(n.t) && n.x && n.x.length < 40 && (RX.vehicle.test(n.x) || RX.lead.test(n.x))).map((x) => x.n.x);
  add('CUSTOMER', 'cust.fields', 'Lead / vehicle / trade / status labels', labs?.length >= 3, labs ? short([...new Set(labs)].slice(0, 8).join(', '), 120) : '', 'Fewer than 3 lead or vehicle labels seen. Open a customer with an active lead.');
  const lazy = C && (evs(C, 'net').length || evs(C, 'dom').length > 1);
  add('CUSTOMER', 'cust.lazy', 'Loading observed (what loads as you scroll)', lazy, `${evs(C, 'net').length} network call(s), ${evs(C, 'dom').length} page change(s)`, 'No loading activity seen. Scroll to the notes while recording.');
  add('CUSTOMER', 'cust.opt', 'Opted-out / blocked customer captured', S.blocked, S.blocked ? 'step done' : '', 'Optional but important: capture one customer who cannot be texted or emailed so we can find how the CRM shows it.');

  // ---- SEND
  const X = S.send;
  const sendClick = X && evs(X, 'click').find((c) => RX.send.test(`${c.label} ${c.cls} ${c.id}`) || /save|submit/i.test(`${c.id}`));
  add('SEND', 'send.click', 'A real test send was recorded', sendClick, sendClick ? `click ${short(sendClick.sel)} at ${secs(sendClick.t)}` : '', 'Optional but the best way to prove sending: send a text or email to your OWN number/address with the recording on.');
  const sendNet = X && evs(X, 'net').filter((e) => e.m === 'POST' && e.t >= (sendClick?.t || 0));
  const closed = X && ((X.tabEvents || []).some((e) => e.k === 'tab-closed') || evs(X, 'unload').length);
  const echoed = X && evs(X, 'dom').some((e) => e.t >= (sendClick?.t || 0) && e.addN);
  add('SEND', 'send.proof', 'What proves it sent (request, window closing, or message appearing)', sendClick && (sendNet?.length || closed || echoed), [sendNet?.length ? `POST ${short(sendNet[0].p)} -> ${sendNet[0].s} in ${sendNet[0].ms}ms` : '', closed ? 'window/page closed afterwards' : '', echoed ? 'page changed afterwards' : ''].filter(Boolean).join('; '), 'Without a real send we have to guess how to confirm a message went out.');

  // ---- DONE
  const Dn = S.done;
  add('DONE', 'done.step', 'Completing a task + refresh', Dn && evs(Dn, 'click').length, Dn ? `${evs(Dn, 'click').length} click(s), ${evs(Dn, 'net').length} network call(s)` : '', 'Optional: shows how a finished task leaves the list.');

  // ---- overall
  add('ALL', 'all.shots', 'Screenshots for the required steps', ['tasks', 'text', 'email', 'customer'].every((k) => S[k]?.shots?.length), 'all four', `Some required steps have no screenshot${d.pictures && d.pictures !== 'yes' ? ` (${d.pictures})` : ''}.`);
  add('ALL', 'all.frames', 'Every window and frame was readable', !(d.steps || []).some((s) => s.permissionAsk && !s.permissionAsk.granted), 'yes', 'The tester did not allow a second site the CRM uses (its pop-ups live there). Ask them to redo the step and choose Allow.');

  const required = checks.filter((c) => !/^(cust\.opt|send\.|done\.|list\.vehicle|list\.refresh|text\.shot|email\.shot|all\.shots|text\.timing|email\.template|cust\.lazy)/.test(c.id));
  const missing = required.filter((c) => !c.ok);
  return { checks, missing, passed: checks.filter((c) => c.ok).length, total: checks.length, ready: !missing.length, requiredTotal: required.length };
}

export function buildReport(d) {
  const a = analyze(d);
  const out = [];
  const P = (s = '') => out.push(s);
  P(`AUTOTASKS DIAGNOSTIC: ${d.crm || '(CRM not named)'}  ·  ${d.host || ''}`);
  P(`AutoTasks ${d.version} · ${d.browser || ''} · screen ${d.screen || ''} · ${d.at}`);
  if (d.email) P(`Tester: ${d.email}`);
  if (d.note) P(`Tester's note: ${d.note}`);
  P('');
  P(`READINESS: ${a.ready ? 'READY TO CODE' : `NOT YET (${a.missing.length} gap${a.missing.length === 1 ? '' : 's'})`}  ·  ${a.passed}/${a.total} checks pass`);
  let group = '';
  for (const c of a.checks) {
    if (c.group !== group) { group = c.group; P(`  [${group}]`); }
    P(`   ${c.ok ? 'PASS' : 'MISS'}  ${c.name}${c.ok ? (c.evidence ? `  ->  ${short(c.evidence, 110)}` : '') : `  ->  ${c.fix}`}`);
  }
  for (const s of d.steps || []) {
    P('');
    P(`==== STEP: ${s.label} (${s.id})${s.seconds ? `  recorded ${s.seconds}s` : ''} ====`);
    for (const [pi, p] of (s.pages || []).entries()) {
      P(`  window ${pi}${p.active ? ' (the CRM tab)' : p.popup ? ' (another browser window)' : ' (another tab)'}`);
      for (const f of p.frames) {
        const b = f.built || {};
        P(`    frame ${f.frameId}${f.top ? ' (top)' : ''}  ${f.url}  ${f.nodes} nodes · ${f.controls?.length || 0} controls · built: ${['react', 'angular', 'aspnet'].filter((k) => b[k]).join('/') || 'plain'}, ${b.testids || 0} test ids`);
        if (f.frames?.length) P(`      contains frames: ${f.frames.map((x) => `${x.id || x.name || '(unnamed)'}${x.src ? ' <- ' + short(x.src, 70) : ''}${x.on ? '' : ' (hidden)'}`).join(' | ')}`);
        const seen = new Map();
        for (const c of f.controls || []) { const k = `${c.tag}|${c.type || ''}|${c.label || ''}|${c.sel}`; const e = seen.get(k) || { c, n: 0 }; e.n++; seen.set(k, e); }
        for (const { c, n } of [...seen.values()].slice(0, 40)) P(`      ${c.on ? ' ' : 'x'} ${c.tag}${c.type ? `[${c.type}]` : ''}${c.label ? ` "${c.label}"` : ''}${c.name ? ` name=${c.name}` : ''}${c.off ? ' (disabled)' : ''}${n > 1 ? ` x${n}` : ''}  ${c.sel}`);
        const marks = new Set();
        walk(f.tree, (n) => { if (n.i) marks.add(`#${n.i}`); for (const [k, v] of Object.entries(n.a || {})) if (/^data-(testid|test|qa|cy|action|type|row|id)/.test(k)) marks.add(`[${k}="${v}"]`); });
        if (marks.size) P(`      landmarks: ${short([...marks].slice(0, 30).join('  '), 600)}`);
        const reps = []; walk(f.tree, (n) => { if (n.n >= 2) reps.push(`<${n.t}${n.c ? '.' + n.c.split(' ')[0] : ''}> x${n.n}`); });
        if (reps.length) P(`      repeating: ${[...new Set(reps)].slice(0, 12).join('  ')}`);
      }
    }
    const tl = [...(s.events || []).map((e) => ({ ...e, src: 'page' })), ...(s.tabEvents || []).map((e) => ({ ...e, src: 'tab' }))].sort((x, y) => x.t - y.t);
    if (tl.length) {
      P('  TIMELINE (what happened while recording):');
      let lastLine = ''; let rep = 0;
      for (const e of tl.slice(0, 160)) {
        let line = '';
        if (e.src === 'tab') line = `${e.k.toUpperCase()} ${e.u || ''}`;
        else if (e.k === 'click') line = `CLICK ${e.tag}${e.id ? '#' + e.id : ''}${e.cls ? '.' + e.cls.split(' ')[0] : ''}${e.label ? ` "${e.label}"` : ''}  [${e.sel}]`;
        else if (e.k === 'dom') line = `PAGE +${e.addN}/-${e.remN}${(e.add || []).length ? ': ' + e.add.slice(0, 4).map((a) => `${a.tag}${a.id ? '#' + a.id : ''}${a.src ? ' <- ' + short(a.src, 50) : ''}${a.label ? ` "${a.label}"` : ''}`).join(', ') : ''}`;
        else if (e.k === 'attr') line = `STATE ${(e.items || []).slice(0, 3).map((i) => `${short(i.sel, 40)} ${i.name}="${short(i.to, 30)}"`).join('; ')}`;
        else if (e.k === 'net') line = `NET ${e.m} ${short(e.p, 90)} -> ${e.s} (${e.ms}ms)`;
        else if (e.k === 'open') line = `WINDOW.OPEN ${e.u}`;
        else if (e.k === 'url') line = `ADDRESS -> ${e.u}`;
        else if (e.k === 'submit') line = `FORM SUBMIT ${e.method || ''} ${e.action || ''}`;
        else line = `${e.k.toUpperCase()}${e.fr ? ' in ' + e.fr : ''}`;
        if (line === lastLine) { rep++; continue; }
        if (rep) P(`        (repeated x${rep})`);
        rep = 0; lastLine = line;
        P(`    +${secs(e.t).padStart(6)}  ${e.top === 1 || e.src === 'tab' ? '' : '[frame] '}${line}`);
      }
      if (rep) P(`        (repeated x${rep})`);
    }
    if (s.permissionAsk) P(`  permission: asked for ${s.permissionAsk.origins.join(', ')} -> ${s.permissionAsk.granted ? 'allowed' : 'DENIED'}`);
    if (s.shots?.length) P(`  screenshots: ${s.shots.length} (${s.shots.map((x) => `${x.window} ${x.w}x${x.h}`).join(', ')})`);
  }
  return out.join('\n');
}

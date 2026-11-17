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

const frames = (s) => (s?.pages || []).flatMap((p, pi) => (p.frames || []).map((f) => ({ ...f, win: pi, popup: !!p.popup, active: !!p.active })));
const controls = (s) => frames(s).flatMap((f) => (f.controls || []).map((c) => ({ ...c, _f: f })));
const walk = (n, fn, depth = 0, path = []) => { if (!n) return; fn(n, depth, path); for (const k of n.k || []) walk(k, fn, depth + 1, [...path, n]); };
const nodes = (s, test) => { const out = []; for (const f of frames(s)) walk(f.tree, (n, d, p) => { if (test(n, p, f)) out.push({ n, f, p }); }); return out; };
const evs = (s, kind) => (s?.events || []).filter((e) => e.k === kind);
const has = (rx, ...vals) => vals.some((v) => v && rx.test(String(v)));
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
const label = (c) => `${c.label || ''} ${c.name || ''} ${c.type || ''}`;
// Controls that were already on the page before the click (the task row's own buttons) are not the window that opened.
// A control counts as NEW if recording saw it appear, or it lives in another window or frame.
const addedSels = (s) => new Set((s?.events || []).filter((e) => e.k === 'dom').flatMap((e) => (e.add || []).map((a) => a.sel)));
const isNew = (s, c, sels) => sels.has(c.sel) || !c._f.top || c._f.popup;
const pick = (s, pred) => { const sels = addedSels(s); const all = controls(s).filter(pred); const n = all.find((c) => isNew(s, c, sels)); return n ? { ...n, fresh: true } : all[0] ? { ...all[0], fresh: false } : null; };
const where = (c) => (c ? `${c.tag}${c.label ? ` "${c.label}"` : ''} ${c.sel}${c.fresh ? ' (appeared after the click)' : ' (was already on the page)'}` : '');
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const short = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

// An element appearing counts as "the text window" if a box to type in appeared, a frame appeared, or a window opened.
function appeared(s) {
  const adds = evs(s, 'dom').flatMap((e) => (e.add || []).map((a) => ({ ...a, t: e.t })));
  const typing = adds.filter((a) => /^(textarea|input)$/.test(a.tag) || a.cls?.includes('editor') || a.type === 'text');
  const frameAdds = adds.filter((a) => /^i?frame$/.test(a.tag));
  const tabs = (s?.tabEvents || []).filter((e) => e.k === 'tab-opened');
  const dialogs = adds.filter((a) => a.role === 'dialog' || /modal|dialog|overlay/i.test(a.cls || ''));
  return { adds, typing, frameAdds, tabs, dialogs };
}

export function analyze(d) {
  const S = Object.fromEntries((d.steps || []).map((s) => [s.id, s]));
  const checks = [];
  const add = (group, id, name, ok, evidence, fix) => checks.push({ group, id, name, ok: !!ok, evidence: ok ? evidence : '', fix: ok ? '' : fix });

  // ---- LIST
  const L = S.tasks;
  const rows = L ? nodes(L, (n, p, f) => f.top && /^(tr|li|div)$/.test(n.t) && n.n >= 2 && JSON.stringify(n.k || []).includes('"t":"button"') || (n.n >= 2 && /^(tr|li)$/.test(n.t))) : [];
  const row = rows[0]?.n;
  add('LIST', 'list.page', 'Task list found', L && rows.length, row ? `repeating row <${row.t}${row.c ? '.' + row.c.split(' ')[0] : ''}> x${row.n}` : '', 'Redo "Your task list" with tasks showing on screen.');
  const rowAttr = row && Object.entries(row.a || {}).find(([k, v]) => k.startsWith('data-') && /9{3,}/.test(v));
  const rowId = row && (rowAttr || (row.i && /9{3,}/.test(row.i)));
  add('LIST', 'list.rowid', 'Each row carries the customer id', rowId, rowAttr ? `${rowAttr[0]}="${rowAttr[1]}"` : '', 'Rows had no id we could see. Add a note saying where the customer\'s id shows (address or attribute) after they open one.');
  const anchor = row && JSON.stringify(row).includes('"t":"a"');
  add('LIST', 'list.name', 'Customer name link in the row', anchor, 'link inside the row', 'No link to the customer inside a task row. Note how a customer is opened from the list.');
  const taskBtns = L ? controls(L).filter((c) => c.tag === 'button' || c.tag === 'a' || c.type === 'button') : [];
  const kinds = new Set(taskBtns.map((c) => (RX.email.test(label(c)) ? 'email' : RX.text.test(label(c)) ? 'text' : RX.call.test(label(c)) ? 'call' : '')).filter(Boolean));
  add('LIST', 'list.types', 'Text / Email / Call buttons tell themselves apart', kinds.has('text') && kinds.has('email'), `found: ${[...kinds].join(', ')}`, `Only found: ${[...kinds].join(', ') || 'none'}. We need to see a row with a Text task AND a row with an Email task (and a Call task if you have them).`);
  add('LIST', 'list.refresh', 'Refresh control', L && controls(L).some((c) => RX.refresh.test(label(c))) || evs(S.done, 'click').some((c) => RX.refresh.test(`${c.label} ${c.cls}`)), 'refresh button', 'No Refresh button seen. Redo "Finish a task and refresh" and press the CRM\'s refresh.');
  const veh = L && nodes(L, (n) => n.x && /^9{4}\s/.test(n.x)).length > 0;
  add('LIST', 'list.vehicle', 'Vehicle shown in the row', veh, 'a year + vehicle text in the row', 'Could not see a vehicle in the task rows (fine if the CRM does not show one there).');

  // ---- TEXT
  const T = S.text;
  const tAp = T && appeared(T);
  add('TEXT', 'text.click', 'The click on the Text task was recorded', T && evs(T, 'click').length, T ? `${evs(T, 'click').length} click(s), last on ${short(evs(T, 'click').slice(-1)[0]?.sel || '')}` : '', 'Redo "Open a text task": press Start BEFORE clicking the Text button.');
  const kindT = tAp && (tAp.tabs.length ? 'a new browser window/tab' : tAp.frameAdds.length ? 'a frame inside the page' : tAp.dialogs.length ? 'a dialog on the page' : tAp.typing.length ? 'a box inline on the page' : '');
  add('TEXT', 'text.window', 'We know how the text window opens', kindT, kindT || '', 'Nothing seemed to open. Press Done only after the text box is on screen.');
  const tBox = T && pick(T, (c) => (c.tag === 'textarea' || c.type === 'textbox' || /^(text|)$/.test(c.type || '') && c.tag === 'input') && (RX.body.test(label(c)) || c.tag === 'textarea'));
  add('TEXT', 'text.box', 'Message box found', tBox, where(tBox), 'The text box was not in the capture. Make sure the text window is open and empty when you press Done.');
  const sendOnly = (c) => /^\s*send\b/i.test(c.label || '') && !/(text|email|sms)\b/i.test(c.label || '');
  const tSend = T && (pick(T, sendOnly) || pick(T, (c) => RX.send.test(label(c)) && !RX.email.test(label(c))));
  add('TEXT', 'text.send', 'Send button found', tSend && tSend.fresh, where(tSend) + (tSend?.off ? ' (disabled while empty)' : ''), tSend ? 'The only Send we saw was already on the page before the text window opened (it may be the task row\'s own button). Redo with the text window open when you press Done.' : 'No Send button seen in the text window.');
  const first = evs(T, 'click')[0]; const ready = tAp && [...tAp.typing, ...tAp.frameAdds].map((a) => a.t).filter((t) => first && t >= first.t).sort((a, b) => a - b)[0];
  add('TEXT', 'text.timing', 'How long the text window takes to be ready', ready != null && first, ready != null && first ? secs(ready - first.t) : '', 'Could not time it (the window may be in another site we could not read).');
  add('TEXT', 'text.shot', 'Screenshot of the text window', T?.shots?.length, `${T?.shots?.length || 0} screenshot(s)`, 'No screenshot (the tester turned them off or the window could not be photographed).');

  // ---- EMAIL
  const E = S.email;
  const eAp = E && appeared(E);
  add('EMAIL', 'email.click', 'The click on the Email task was recorded', E && evs(E, 'click').length, E ? `${evs(E, 'click').length} click(s)` : '', 'Redo "Open an email task": press Start BEFORE clicking the Email button.');
  const kindE = eAp && (eAp.tabs.length ? 'a new browser window/tab' : eAp.frameAdds.length ? 'a frame inside the page' : eAp.dialogs.length ? 'a dialog on the page' : eAp.typing.length ? 'inline on the page' : '');
  add('EMAIL', 'email.window', 'We know how the email composer opens', kindE, kindE || '', 'Nothing seemed to open. Press Done only after the email composer is on screen.');
  const eSub = E && pick(E, (c) => RX.subject.test(label(c)));
  add('EMAIL', 'email.subject', 'Subject field', eSub, where(eSub), 'No Subject field seen.');
  const eEditFrame = E && frames(E).find((f) => /^about:|blank|editor|compose|rich|mce|ck/i.test(`${f.url} ${f.title}`) && f.nodes <= 40) || null;
  const eBodyNode = E && nodes(E, (n, p, f) => n.a?.contenteditable === 'true' && (!f.top || f.popup))[0];
  const eBody = E && (pick(E, (c) => c.tag === 'textarea' || /contenteditable/.test(`${c.type}`) || c.type === 'textbox') || null);
  add('EMAIL', 'email.body', 'Body editor found (and what kind it is)', (eBody && eBody.fresh) || eBodyNode || eEditFrame, eBodyNode ? `contenteditable <${eBodyNode.n.t}${eBodyNode.n.c ? '.' + eBodyNode.n.c.split(' ')[0] : ''}> inside ${eBodyNode.f.top ? 'the page' : 'a frame (rich-text editor)'}` : eBody ? where(eBody) : eEditFrame ? 'rich-text editor frame' : '', 'The email body editor was not in the capture. Redo with the composer fully loaded (wait for the editor to appear).');
  const eTpl = E && controls(E).find((c) => c.tag === 'select' && /template|signature/i.test(`${label(c)} ${c.sel}`));
  add('EMAIL', 'email.template', 'Template / signature picker (if the CRM has one)', true, eTpl ? eTpl.sel : 'none seen (ok if the CRM has no templates)', '');
  const eSend = E && (pick(E, sendOnly) || pick(E, (c) => /^\s*send\s+e-?mail/i.test(c.label || '') || (c.type === 'submit' && c.tag === 'button')));
  add('EMAIL', 'email.send', 'Send button', eSend && eSend.fresh, where(eSend), eSend ? 'The only Send we saw was already on the page before the composer opened. Redo with the composer open when you press Done.' : 'No Send button seen in the email window.');
  const eCancel = E && pick(E, (c) => RX.cancel.test(label(c)));
  add('EMAIL', 'email.cancel', 'Cancel / close button', eCancel, where(eCancel), 'No Cancel or Close button seen (needed to close a window we opened).');
  add('EMAIL', 'email.shot', 'Screenshot of the email window', E?.shots?.length, `${E?.shots?.length || 0} screenshot(s)`, 'No screenshot of the email window.');

  // ---- CUSTOMER
  const C = S.customer;
  const notes = C && nodes(C, (n) => n.n >= 2 && /^(div|li|tr|article|section)$/.test(n.t) && (n.c || n.a));
  const noteKind = notes?.find((x) => Object.keys(x.n.a || {}).some((k) => /direction|tag|kind|type/.test(k)));
  add('CUSTOMER', 'cust.page', 'Customer page captured', C && frames(C).length, C ? `${frames(C).length} frame(s)` : '', 'Redo "A customer\'s page".');
  add('CUSTOMER', 'cust.notes', 'Notes / history items found', notes?.length, notes?.length ? `repeating item <${notes[0].n.t}${notes[0].n.c ? '.' + notes[0].n.c.split(' ')[0] : ''}> x${notes[0].n.n}` : '', 'No repeating notes/history list seen. Scroll the customer\'s history into view before pressing Done.');
  add('CUSTOMER', 'cust.direction', 'Each note says inbound/outbound, type and date', noteKind || (notes?.length && notes[0].n.k?.length >= 2), noteKind ? Object.entries(noteKind.n.a).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' ') : 'structure has separate date/text pieces', 'We could not tell inbound from outbound. Include a customer who has both a received and a sent message.');
  const phone = C && (controls(C).some((c) => /tel:/.test(c.type || '') || RX.phone.test(label(c))) || nodes(C, (n) => n.a?.href?.startsWith('tel:')).length || nodes(C, (n) => RX.phone.test(n.x || '')).length);
  add('CUSTOMER', 'cust.phone', 'Phone numbers (tel: links or labelled fields)', phone, 'found', 'No phone field or tel: link seen on the customer page.');
  const labs = C && nodes(C, (n) => /^(label|th|dt|span|div)$/.test(n.t) && n.x && (RX.vehicle.test(n.x) || RX.lead.test(n.x))).map((x) => x.n.x);
  add('CUSTOMER', 'cust.fields', 'Lead / vehicle / trade / status labels', labs?.length >= 3, labs ? short([...new Set(labs)].slice(0, 8).join(', '), 120) : '', 'Fewer than 3 lead or vehicle labels seen. Open a customer with an active lead.');
  const lazy = C && (evs(C, 'net').length || evs(C, 'dom').length > 1);
  add('CUSTOMER', 'cust.lazy', 'Lazy loading observed (does anything load as you scroll?)', lazy, `${evs(C, 'net').length} network call(s), ${evs(C, 'dom').length} page change(s)`, 'No loading activity seen. Scroll to the notes while recording.');
  add('CUSTOMER', 'cust.opt', 'Opted-out / blocked customer captured', S.blocked, S.blocked ? 'step done' : '', 'Optional but important: capture one customer who cannot be texted or emailed so we can find how the CRM shows it.');

  // ---- SEND
  const X = S.send;
  const sendClick = X && evs(X, 'click').find((c) => RX.send.test(`${c.label} ${c.cls} ${c.id}`));
  add('SEND', 'send.click', 'A real test send was recorded', sendClick, sendClick ? `click ${short(sendClick.sel)} at ${secs(sendClick.t)}` : '', 'Optional but the best way to prove sending: send a text or email to your OWN number/address with the recording on.');
  const sendNet = X && evs(X, 'net').filter((e) => e.m === 'POST' && e.t >= (sendClick?.t || 0));
  const closed = X && ((X.tabEvents || []).some((e) => e.k === 'tab-closed') || evs(X, 'unload').length);
  const echoed = X && evs(X, 'dom').some((e) => e.t >= (sendClick?.t || 0) && e.addN);
  add('SEND', 'send.proof', 'What proves it sent (request, window closing, or message appearing)', sendClick && (sendNet?.length || closed || echoed), [sendNet?.length ? `POST ${short(sendNet[0].p)} -> ${sendNet[0].s} in ${sendNet[0].ms}ms` : '', closed ? 'window/page closed afterwards' : '', echoed ? 'page changed afterwards' : ''].filter(Boolean).join('; '), 'Without a real send we have to guess how to confirm a message went out.');

  // ---- DONE
  const Dn = S.done;
  add('DONE', 'done.step', 'Completing a task + refresh', Dn && evs(Dn, 'click').length, Dn ? `${evs(Dn, 'click').length} click(s), ${evs(Dn, 'net').length} network call(s)` : '', 'Optional: shows how a finished task leaves the list.');

  // ---- overall
  add('ALL', 'all.shots', 'Screenshots for the required steps', ['tasks', 'text', 'email', 'customer'].every((k) => S[k]?.shots?.length), 'all four', 'Some required steps have no screenshot.');
  add('ALL', 'all.frames', 'Every window and frame was readable', !(d.steps || []).some((s) => s.permissionAsk && !s.permissionAsk.granted), 'yes', 'The tester did not allow a second site the CRM uses (its pop-ups live there). Ask them to redo the step and choose Allow.');

  const required = checks.filter((c) => !/^(cust\.opt|send\.|done\.|list\.vehicle|list\.refresh|text\.shot|email\.shot|all\.shots|text\.timing|email\.template)/.test(c.id));
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

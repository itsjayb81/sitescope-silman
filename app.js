/* SiteScope: offline-first. Everything saves on the phone first, then syncs to the office Google Sheet + Drive. */
'use strict';

// ---------- storage ----------
const LS = 'sitescope.v1';
const DEFAULT_MATERIALS = [
  { id: 'asphalt', name: 'Asphalt (AC14)', density: 2.4, compaction: 1.0, rate: 180, unit: 't' },
  { id: 'concrete', name: 'Concrete (25 MPa)', density: 2.4, compaction: 1.0, rate: 300, unit: 'm3' },
  { id: 'crushed', name: 'Crushed rock (20mm FCR)', density: 1.6, compaction: 1.3, rate: 45, unit: 't' },
  { id: 'topsoil', name: 'Topsoil', density: 1.3, compaction: 1.2, rate: 60, unit: 't' },
  { id: 'gravel', name: 'Gravel (20mm)', density: 1.6, compaction: 1.1, rate: 70, unit: 't' },
  { id: 'sand', name: 'Sand (washed)', density: 1.6, compaction: 1.15, rate: 55, unit: 't' },
];
const OFFICE_LINK = 'https://script.google.com/macros/s/AKfycbw044abhJhKzcvc_CxmqsKgLOg_WmB18o8PTuMsqU7jaOx1S2dUSIxEpGQiC7JdCZbG/exec';
const fresh = () => ({
  jobs: [{ id: 'j1', name: 'Sample job', site: '' }], activeJob: 'j1',
  photos: [], measures: [], calcs: [], queue: [],
  materials: DEFAULT_MATERIALS, settings: { syncUrl: OFFICE_LINK, who: '', waste: 10 },
  lastSync: null, lastRates: null,
});
let S;
try { S = Object.assign(fresh(), JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { S = fresh(); }
if (!S.settings.syncUrl) S.settings.syncUrl = OFFICE_LINK;
const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { toast('Phone storage full'); } };

// photos live in IndexedDB (too big for localStorage)
const idb = new Promise((res, rej) => {
  const r = indexedDB.open('sitescope', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('photos');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idbOp = (mode, fn) => idb.then(db => new Promise((res, rej) => {
  const tx = db.transaction('photos', mode); const rq = fn(tx.objectStore('photos'));
  tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error);
}));
const putPhoto = (id, blob) => idbOp('readwrite', s => s.put(blob, id));
const getPhoto = id => idbOp('readonly', s => s.get(id));
const delPhoto = id => idbOp('readwrite', s => s.delete(id));

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };
const money = n => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const f = (n, d = 2) => n.toLocaleString('en-AU', { maximumFractionDigits: d });
const job = () => S.jobs.find(j => j.id === S.activeJob) || S.jobs[0];
const jobName = id => (S.jobs.find(j => j.id === id) || {}).name || 'Unknown job';
const when = t => new Date(t).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
function toast(m) {
  const t = document.createElement('div');
  t.textContent = m;
  t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#231d18;color:#fff;padding:12px 18px;border-radius:12px;font-weight:700;z-index:9;max-width:90%';
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}
const ico = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>', cam: '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="14" r="4"/>',
  rule: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>', calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h2M12 12h2M8 16h2M12 16h2"/>',
  jobs: '<path d="M4 7h16v13H4zM9 7V4h6v3"/>', sync: '<path d="M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5M6 3v4h4M18 21v-4h-4"/>',
};
const svg = k => `<svg viewBox="0 0 24 24">${ico[k]}</svg>`;

// ---------- calculator (exact formulas from the design handoff) ----------
function calc(m, L, W, Dmm, wastePct, rate) {
  const vol = L * W * Dmm / 1000;
  const tonnes = vol * m.density * m.compaction;
  const order = m.unit === 'm3' ? vol * m.compaction * (1 + wastePct / 100) : tonnes * (1 + wastePct / 100);
  return { vol, tonnes, order, cost: order * rate, area: L * W };
}
window.__calc = calc;

// ---------- sync ----------
let syncing = false;
const online = () => navigator.onLine;
function enqueue(kind, data) { S.queue.push({ qid: uid(), kind, data, t: Date.now() }); save(); drawPill(); trySync(); }
async function post(body) {
  const r = await fetch(S.settings.syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const blobToB64 = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });
async function trySync(manual) {
  if (syncing) return;
  if (!S.settings.syncUrl) { if (manual) toast('Add the office link in Sync first'); return; }
  if (!online()) { if (manual) toast('No signal. Saved on phone.'); return; }
  syncing = true; drawPill();
  try {
    while (S.queue.length) {
      const q = S.queue[0]; const item = Object.assign({}, q);
      if (q.kind === 'photo') { const b = await getPhoto(q.data.id); if (!b) { S.queue.shift(); continue; } item.b64 = await blobToB64(b); }
      const res = await post({ action: 'push', who: S.settings.who, item });
      if (!res.ok) throw new Error(res.error || 'office said no');
      if (q.kind === 'photo') { const p = S.photos.find(p => p.id === q.data.id); if (p) p.uploaded = true; }
      S.queue.shift(); save(); drawPill();
    }
    const pull = await (await fetch(S.settings.syncUrl + '?action=pull')).json();
    if (pull.ok) {
      if (Array.isArray(pull.jobs) && pull.jobs.length) {
        const map = new Map(S.jobs.map(j => [j.id, j]));
        pull.jobs.forEach(j => map.set(j.id, Object.assign(map.get(j.id) || {}, j)));
        S.jobs = [...map.values()]; if (!S.jobs.find(j => j.id === S.activeJob)) S.activeJob = S.jobs[0].id;
      }
      if (Array.isArray(pull.materials) && pull.materials.length) S.materials = pull.materials;
    }
    S.lastSync = Date.now(); save();
    if (manual) toast('Synced with office');
  } catch (e) { if (manual) toast('Sync failed. Will retry.'); }
  syncing = false; drawPill(); if (screen === 'sync' || screen === 'jobs' || screen === 'home') render();
}
window.addEventListener('online', () => { drawPill(); trySync(); });
window.addEventListener('offline', drawPill);
setInterval(() => { if (S.queue.length) trySync(); }, 60000);

function drawPill() {
  const p = $('#syncpill'); if (!p) return;
  const n = S.queue.length;
  p.className = 'pill' + (!online() ? ' off' : n ? ' q' : '');
  p.textContent = syncing ? 'Syncing...' : !online() ? 'Offline' + (n ? ' · ' + n + ' waiting' : '') : n ? n + ' to send' : 'Synced';
  p.onclick = () => go('sync');
  $('#jobline').textContent = job() ? job().name : '';
}

// ---------- screens ----------
let screen = 'home';
const TABS = [['home', 'Home'], ['cam', 'Camera'], ['measure', 'Measure'], ['calc', 'Calc'], ['jobs', 'Jobs']];
const tabIcon = { home: 'home', cam: 'cam', measure: 'rule', calc: 'calc', jobs: 'jobs' };
function go(s) { screen = s; render(); $('#screen').scrollTop = 0; }
function drawTabs() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="${screen === k ? 'on' : ''}" data-go="${k}">${svg(tabIcon[k])}${l}</button>`).join('');
}
function render() {
  drawTabs(); drawPill();
  const fn = { home, cam, measure, calc: calcScreen, jobs, sync }[screen] || home;
  $('#screen').innerHTML = fn();
  const after = { cam: camAfter, measure: measureAfter, calc: calcAfter, jobs: jobsAfter, sync: syncAfter }[screen];
  if (after) after();
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go);
});

function home() {
  const j = job(); const jid = j.id;
  const np = S.photos.filter(p => p.job === jid).length, nm = S.measures.filter(m => m.job === jid).length, nc = S.calcs.filter(c => c.job === jid).length;
  return `<div class="hero"><div><h2>Silman Bros</h2><p>Photos, measures and quotes, straight to the office.</p></div></div>
  <div class="big">
    <button data-go="cam">${svg('cam')}Photo</button>
    <button data-go="measure">${svg('rule')}Measure</button>
    <button data-go="calc">${svg('calc')}Calc</button></div>
  <div class="card active"><label>Active job</label><h3>${esc(j.name)}</h3>
    <div class="note">${esc(j.site || 'No address yet')}</div>
    <div class="row" style="margin-top:12px"><span class="tag">${np} photos</span><span class="tag">${nm} measures</span><span class="tag">${nc} quotes</span></div>
    <button class="btn sec sm" style="margin-top:12px" data-go="jobs">Change job</button></div>
  <div class="card"><h3>Latest on this job</h3>${recent(jid)}</div>`;
}
function recent(jid) {
  const all = [
    ...S.photos.filter(p => p.job === jid).map(p => ({ t: p.t, a: 'Photo', b: p.name })),
    ...S.measures.filter(m => m.job === jid).map(m => ({ t: m.t, a: 'Measure', b: `${m.name}: ${f(m.l)} x ${f(m.w)} m, ${f(m.d, 0)} mm` })),
    ...S.calcs.filter(c => c.job === jid).map(c => ({ t: c.t, a: 'Quote', b: `${c.material}: ${f(c.order)} ${c.unit === 'm3' ? 'm3' : 't'} · ${money(c.cost)}` })),
  ].sort((a, b) => b.t - a.t).slice(0, 6);
  return all.length ? all.map(x => `<div class="item"><div><b>${esc(x.a)}</b><small>${esc(x.b)}</small></div><small>${when(x.t)}</small></div>`).join('') : '<div class="empty">Nothing yet. Take a photo or measure to start.</div>';
}

// --- camera
function cam() {
  const list = S.photos.filter(p => p.job === job().id).slice().reverse();
  return `<h2>Photo</h2>
  <div class="card"><label>Name the photo first</label><input id="pname" placeholder="e.g. Pothole at gate 2" autocomplete="off">
    <label style="margin-top:12px">Where on site</label><input id="ploc" placeholder="e.g. North driveway" autocomplete="off">
    <input id="pfile" type="file" accept="image/*" capture="environment" hidden>
    <button class="btn" style="margin-top:14px" id="shoot">Take photo</button>
    <div class="note" style="margin-top:8px">GPS and time are saved automatically.</div></div>
  <div class="card"><h3>This job (${list.length})</h3>${list.length ? '<div id="plist"></div>' : '<div class="empty">No photos yet.</div>'}</div>`;
}
function camAfter() {
  const input = $('#pfile');
  $('#shoot').onclick = () => { if (!$('#pname').value.trim()) { toast('Name the photo first'); $('#pname').focus(); return; } input.click(); };
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    const name = $('#pname').value.trim(), loc = $('#ploc').value.trim();
    const gps = await getGps();
    const blob = await shrink(file);
    const id = uid();
    await putPhoto(id, blob);
    const rec = { id, job: job().id, name, loc, t: Date.now(), lat: gps && gps.lat, lng: gps && gps.lng, uploaded: false };
    S.photos.push(rec); save();
    enqueue('photo', { id, job: rec.job, jobName: job().name, name, loc, t: rec.t, lat: rec.lat, lng: rec.lng });
    toast(gps ? 'Saved with GPS' : 'Saved (no GPS)'); render();
  };
  const holder = $('#plist');
  if (holder) S.photos.filter(p => p.job === job().id).slice().reverse().forEach(async p => {
    const row = document.createElement('div'); row.className = 'item';
    row.innerHTML = `<img class="thumb" alt=""><div style="flex:1"><b>${esc(p.name)}</b><small>${esc(p.loc || '')} ${when(p.t)}${p.lat ? ' · GPS' : ''}</small></div><span class="tag ${p.uploaded ? 'ok' : ''}">${p.uploaded ? 'Sent' : 'Waiting'}</span>`;
    holder.appendChild(row);
    const b = await getPhoto(p.id); if (b) row.querySelector('img').src = URL.createObjectURL(b);
  });
}
function getGps() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }), () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  });
}
function shrink(file) { // phone photos are huge; cut to ~1600px so uploads work on weak signal
  return new Promise(res => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => { URL.revokeObjectURL(url); res(b || file); }, 'image/jpeg', 0.82);
    };
    img.onerror = () => res(file); img.src = url;
  });
}

// --- measure
function measure() {
  const list = S.measures.filter(m => m.job === job().id).slice().reverse();
  return `<h2>Measure</h2>
  <div class="card"><label>Name</label><input id="mname" placeholder="e.g. Car park bay A">
    <div class="row" style="margin-top:12px"><div><label>Length (m)</label><input id="ml" inputmode="decimal"></div><div><label>Width (m)</label><input id="mw" inputmode="decimal"></div></div>
    <div style="margin-top:12px"><label>Depth (mm)</label><input id="md" inputmode="decimal" value="50"></div>
    <div class="result" style="margin-top:14px"><small>Area</small><div class="n" id="marea">0 m2</div></div>
    <button class="btn" style="margin-top:14px" id="msave">Save to job</button></div>
  <div class="card"><h3>Saved (${list.length})</h3>${list.map(m => `<div class="item"><div><b>${esc(m.name)}</b><small>${f(m.l)} x ${f(m.w)} m, ${f(m.d, 0)} mm · ${f(m.l * m.w)} m2</small></div><button class="btn sm sec" data-tocalc="${m.id}">Quote it</button></div>`).join('') || '<div class="empty">None yet.</div>'}</div>`;
}
function measureAfter() {
  const upd = () => { $('#marea').textContent = f(num($('#ml').value) * num($('#mw').value)) + ' m2'; };
  ['#ml', '#mw'].forEach(s => $(s).oninput = upd);
  $('#msave').onclick = () => {
    const l = num($('#ml').value), w = num($('#mw').value), d = num($('#md').value);
    if (!l || !w) { toast('Add length and width'); return; }
    const rec = { id: uid(), job: job().id, name: $('#mname').value.trim() || 'Area', l, w, d, t: Date.now() };
    S.measures.push(rec); save(); enqueue('measure', Object.assign({ jobName: job().name }, rec)); toast('Saved'); render();
  };
  document.querySelectorAll('[data-tocalc]').forEach(b => b.onclick = () => { prefill = S.measures.find(m => m.id === b.dataset.tocalc); go('calc'); });
}

// --- calculator
let prefill = null;
function calcScreen() {
  const list = S.calcs.filter(c => c.job === job().id).slice().reverse();
  return `<h2>Calculate</h2>
  <div class="card"><label>Material</label><select id="cm">${S.materials.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
    <div class="row" style="margin-top:12px"><div><label>Length (m)</label><input id="cl" inputmode="decimal"></div><div><label>Width (m)</label><input id="cw" inputmode="decimal"></div></div>
    <div class="row" style="margin-top:12px"><div><label>Depth (mm)</label><input id="cd" inputmode="decimal" value="50"></div><div><label>Waste %</label><input id="cx" inputmode="decimal" value="${S.settings.waste}"></div></div>
    <div style="margin-top:12px"><label id="crl">Rate</label><input id="cr" inputmode="decimal"></div></div>
  <div class="result"><small>Order this much</small><div class="n" id="cord">0</div><small id="cdet"></small>
    <div style="margin-top:12px"><small>Cost ex GST</small><div class="n" id="ccost" style="font-size:30px">$0</div></div></div>
  <button class="btn" id="csave">Save quote to job</button>
  <div class="note">Estimate only. Confirm densities and rates with your supplier.</div>
  <div class="card"><h3>Quotes on this job (${list.length})</h3>${list.map(c => `<div class="item"><div><b>${esc(c.material)}</b><small>${f(c.l)} x ${f(c.w)} m, ${f(c.d, 0)} mm</small></div><div style="text-align:right"><b>${money(c.cost)}</b><small>${f(c.order)} ${c.unit === 'm3' ? 'm3' : 't'}</small></div></div>`).join('') || '<div class="empty">None yet.</div>'}</div>`;
}
function calcAfter() {
  const sel = $('#cm');
  const mat = () => S.materials.find(m => m.id === sel.value) || S.materials[0];
  const setRate = () => { const m = mat(); $('#cr').value = m.rate; $('#crl').textContent = `Rate ($ per ${m.unit === 'm3' ? 'm3' : 'tonne'})`; };
  let last = null;
  const upd = () => {
    const m = mat(), r = calc(m, num($('#cl').value), num($('#cw').value), num($('#cd').value), num($('#cx').value), num($('#cr').value));
    last = r; const u = m.unit === 'm3' ? 'm3' : 't';
    $('#cord').textContent = f(r.order) + ' ' + u;
    $('#cdet').textContent = `${f(r.area)} m2 · ${f(r.vol)} m3 · ${f(r.tonnes)} t before waste`;
    $('#ccost').textContent = money(r.cost);
  };
  sel.onchange = () => { setRate(); upd(); };
  ['#cl', '#cw', '#cd', '#cx', '#cr'].forEach(s => $(s).oninput = upd);
  setRate();
  if (prefill) { $('#cl').value = prefill.l; $('#cw').value = prefill.w; $('#cd').value = prefill.d; prefill = null; }
  upd();
  $('#csave').onclick = () => {
    if (!last || !last.order) { toast('Add measurements first'); return; }
    const m = mat();
    const rec = { id: uid(), job: job().id, material: m.name, unit: m.unit, l: num($('#cl').value), w: num($('#cw').value), d: num($('#cd').value), waste: num($('#cx').value), rate: num($('#cr').value), vol: last.vol, tonnes: last.tonnes, order: last.order, cost: last.cost, t: Date.now() };
    S.calcs.push(rec); save(); enqueue('calc', Object.assign({ jobName: job().name }, rec)); toast('Quote saved'); render();
  };
}

// --- jobs
function jobs() {
  return `<h2>Jobs</h2>
  <div class="card"><label>New job</label><input id="jn" placeholder="Job name"><input id="js" placeholder="Site address (optional)" style="margin-top:10px">
    <button class="btn" style="margin-top:12px" id="jadd">Add job</button></div>
  ${S.jobs.map(j => `<div class="card ${j.id === S.activeJob ? 'active' : ''}"><div class="item" style="padding:0;border:0"><div><b>${esc(j.name)}</b><small>${esc(j.site || '')}</small></div>${j.id === S.activeJob ? '<span class="tag ok">Active</span>' : `<button class="btn sm sec" data-pick="${j.id}">Use</button>`}</div></div>`).join('')}`;
}
function jobsAfter() {
  $('#jadd').onclick = () => {
    const name = $('#jn').value.trim(); if (!name) { toast('Name the job'); return; }
    const j = { id: uid(), name, site: $('#js').value.trim() }; S.jobs.push(j); S.activeJob = j.id; save();
    enqueue('job', j); go('home');
  };
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { S.activeJob = b.dataset.pick; save(); go('home'); });
}

// --- sync + settings
function sync() {
  return `<h2>Office sync</h2>
  <div class="card"><div class="item" style="padding-top:0"><div><b>${S.queue.length} waiting to send</b><small>${S.lastSync ? 'Last synced ' + when(S.lastSync) : 'Never synced'}</small></div><span class="tag ${online() ? 'ok' : ''}">${online() ? 'Signal' : 'No signal'}</span></div>
    <button class="btn" id="syncnow">Sync now</button></div>
  <div class="card"><label>Your name</label><input id="who" value="${esc(S.settings.who)}" placeholder="e.g. Mick">
    <label style="margin-top:12px">Office link</label><input id="surl" value="${esc(S.settings.syncUrl)}" placeholder="Paste the office link">
    <label style="margin-top:12px">Default waste %</label><input id="swaste" inputmode="decimal" value="${S.settings.waste}">
    <button class="btn sec" style="margin-top:14px" id="ssave">Save settings</button></div>
  <div class="card"><h3>Rates</h3><div class="note" style="margin-bottom:8px">The office can change these in the sheet. They update here on sync.</div>
    ${S.materials.map(m => `<div class="item"><div><b>${esc(m.name)}</b><small>${m.density} t/m3 · compaction ${m.compaction}</small></div><b>${money(m.rate)}/${m.unit === 'm3' ? 'm3' : 't'}</b></div>`).join('')}</div>`;
}
function syncAfter() {
  $('#syncnow').onclick = () => trySync(true);
  $('#ssave').onclick = () => {
    S.settings.who = $('#who').value.trim(); S.settings.syncUrl = $('#surl').value.trim(); S.settings.waste = num($('#swaste').value) || 10;
    save(); toast('Saved'); trySync(true);
  };
}

// ---------- splash (once per launch) ----------
function splash() {
  try { if (sessionStorage.getItem('ss.splash')) return; } catch (e) {}
  const d = document.createElement('div'); d.className = 'splash';
  d.innerHTML = '<img src="brand/logo-white.webp" alt="Silman Bros Asphalting"><div><h1>Scope it.<br>Measure it.<br>Order it.</h1><p>The name you can trust, now on your phone.</p><button class="btn">Open SiteScope</button><small>Works with no signal</small></div>';
  d.querySelector('button').onclick = () => { try { sessionStorage.setItem('ss.splash', '1'); } catch (e) {} d.remove(); };
  document.body.appendChild(d);
}

// ---------- start ----------
render(); splash();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// The Upload / Route Map switch and the Route Map tab. app.js owns the Upload tab and is not touched.
import { readTab, planAdd, buildInput, summaryText, formatBytes, acceptHeight, MAX_BYTES } from './mapdata.js';
import { listFiles, putFiles, removeFile, loadCloud, saveCloud, clearCloud, state as storeState } from './mapstore.js';
import { checkCode, cleanResponse, describe, syncCloud } from './mapcloud.js';
import { storedTag } from './releases.js';

const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'), tabs: $('tabs'),
  tabBtns: [...document.querySelectorAll('#tabs [role="tab"]')],
  viewUpload: $('view-upload'), viewMap: $('view-map'),
  file: $('map-file'), add: $('map-add'), addEmpty: $('map-add-empty'),
  empty: $('map-empty'), bar: $('map-bar'), summary: $('map-summary'),
  manage: $('map-manage'), list: $('map-list'), volatile: $('map-volatile'),
  msgs: $('map-msgs'), card: $('map-card'), frame: $('map-frame'),
  codePanel: $('map-code-panel'), codeForm: $('map-code-form'), code: $('map-code'), codeGo: $('map-code-go'),
  codeHint: $('map-code-hint'), cloud: $('map-cloud'), cloudDetail: $('map-cloud-detail'),
  cloudMsgs: $('map-cloud-msgs'), refresh: $('map-refresh'),
};

const TAB_KEY = 'scourge-tab';
const M = {
  tab: 'upload', files: [], busy: false, frameLoaded: false, frameStarted: false,
  // The downloaded map. settled: there is something to draw from (saved data or a first answer).
  cloud: { loaded: false, hasCode: false, settled: false, syncing: false, response: null, result: null, hint: '', tag: null, last: 0 },
};
const RECHECK_MS = 20000; // flipping between tabs shouldn't ask the relay every time

/* ---------- tabs ---------- */

function saveTab(tab) {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode: the choice just isn't remembered */ }
}
function loadTab() {
  try { return readTab(localStorage.getItem(TAB_KEY)); } catch { return readTab(null); }
}

function showTab(tab, { focus = false, save = true } = {}) {
  M.tab = tab;
  el.page.dataset.tab = tab;
  el.tabs.dataset.tab = tab;
  for (const b of el.tabBtns) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  el.viewUpload.hidden = tab !== 'upload';
  el.viewMap.hidden = tab !== 'map';
  if (save) saveTab(tab);
  if (tab === 'map') { syncMap(); openCloud({ force: false }); }
  window.scrollTo(0, 0);
}

for (const b of el.tabBtns) {
  b.addEventListener('click', () => { if (b.dataset.tab !== M.tab) showTab(b.dataset.tab); });
}
el.tabs.addEventListener('keydown', (e) => {
  const order = el.tabBtns.map((b) => b.dataset.tab);
  const i = order.indexOf(M.tab);
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = order[(i + 1) % order.length];
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = order[(i - 1 + order.length) % order.length];
  else if (e.key === 'Home') next = order[0];
  else if (e.key === 'End') next = order[order.length - 1];
  if (next) { e.preventDefault(); showTab(next, { focus: true }); }
});

/* ---------- messages (text only, never HTML) ---------- */

const MSG_ICON = { good: 'i-check', bad: 'i-warn', warn: 'i-warn' };

function showMessages(items, target = el.msgs) {
  target.textContent = '';
  for (const { kind, text } of items) {
    const li = document.createElement('li');
    li.className = 'line';
    li.dataset.kind = kind;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + MSG_ICON[kind]);
    svg.appendChild(use);
    const span = document.createElement('span');
    span.textContent = text;
    li.append(svg, span);
    target.appendChild(li);
  }
}

/* ---------- file list ---------- */

const KIND_LABEL = { csv: 'Results', json: 'Route data' };

function renderFiles() {
  const has = M.files.length > 0;
  el.empty.hidden = has;
  el.addEmpty.hidden = has;
  el.bar.hidden = !has;
  el.manage.hidden = !has;
  renderCard();
  el.volatile.hidden = storeState.persistent;
  if (!has) { el.list.textContent = ''; return; }

  el.summary.textContent = summaryText(M.files);
  el.list.textContent = '';
  for (const r of M.files) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'file-text';
    const name = document.createElement('p');
    name.className = 'file-name';
    name.textContent = r.name;
    const meta = document.createElement('p');
    meta.className = 'caption secondary';
    meta.textContent = `${KIND_LABEL[r.kind] || 'File'}, ${formatBytes(r.size)}`;
    text.append(name, meta);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'link danger';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${r.name}`);
    rm.addEventListener('click', () => onRemove(r.name));
    li.append(text, rm);
    el.list.appendChild(li);
  }
}

async function refresh() {
  try {
    M.files = await listFiles();
  } catch {
    M.files = [];
    showMessages([{ kind: 'bad', text: 'The saved route files could not be read on this device.' }]);
  }
  renderFiles();
  syncMap();
}

/* ---------- add and remove ---------- */

const pick = () => { if (!M.busy) el.file.click(); };
el.add.addEventListener('click', pick);
el.addEmpty.addEventListener('click', pick);

function setBusy(on) {
  M.busy = on;
  el.add.disabled = on;
  el.addEmpty.disabled = on;
}

el.file.addEventListener('change', async () => {
  const picked = [...el.file.files];
  el.file.value = '';
  if (!picked.length || M.busy) return;
  setBusy(true);
  const out = [];
  try {
    const { accepted, rejected } = await planAdd(
      M.files,
      picked.map((f) => ({ name: f.name, size: f.size, read: () => f.text() })),
      MAX_BYTES,
    );
    for (const r of rejected) out.push({ kind: 'bad', text: r.reason });
    if (accepted.length) {
      try {
        await putFiles(accepted);
        const n = accepted.length;
        const allReplaced = accepted.every((a) => a.replaced);
        out.unshift({ kind: 'good', text: `${allReplaced ? 'Updated' : 'Added'} ${n} ${n === 1 ? 'file' : 'files'}.` });
      } catch {
        out.push({ kind: 'bad', text: 'This device could not store the files. It may be out of space.' });
      }
    }
  } catch {
    out.push({ kind: 'bad', text: 'Something went wrong reading those files. Try again.' });
  }
  showMessages(out);
  await refresh();
  setBusy(false);
});

async function onRemove(name) {
  const idx = M.files.findIndex((r) => r.name === name);
  try {
    await removeFile(name);
    showMessages([]);
  } catch {
    showMessages([{ kind: 'bad', text: `Could not remove ${name}.` }]);
  }
  await refresh();
  const rows = el.list.querySelectorAll('button');
  const target = rows[Math.min(idx, rows.length - 1)];
  (target || el.addEmpty).focus({ preventScroll: true });
}

/* ---------- the downloaded map ---------- */

const cloudStore = { loadCloud, saveCloud, clearCloud };

function renderCloud() {
  const c = M.cloud;
  el.codePanel.hidden = c.hasCode || !c.loaded; // not before the saved code has been looked up
  el.cloud.hidden = !c.hasCode;
  el.codeGo.disabled = c.syncing;
  el.codeHint.hidden = !c.hint;
  el.codeHint.textContent = c.hint;
  el.refresh.disabled = c.syncing;
  el.refresh.textContent = c.syncing ? 'Refreshing…' : 'Refresh';
  if (!c.hasCode) { showMessages([], el.cloudMsgs); el.cloudDetail.textContent = ''; return; }
  if (c.result) {
    const d = describe(c.result, c.tag);
    el.cloudDetail.textContent = d.detail;
    showMessages(d.notices, el.cloudMsgs);
  } else {
    el.cloudDetail.textContent = 'Checking for the latest map…';
    showMessages([], el.cloudMsgs);
  }
  renderCard();
}

// The map is drawn for hand-added files, or once there is a download (or a first
// answer, even an empty one, so the page can say there is no prediction yet).
function showCard() {
  return M.files.length > 0 || (M.cloud.hasCode && M.cloud.settled);
}
function renderCard() { el.card.hidden = !showCard(); }

function applyResult(r) {
  const c = M.cloud;
  c.result = r;
  c.hasCode = r.status !== 'need-code' && r.status !== 'bad-code';
  c.response = r.response;
  c.settled = c.hasCode;
  c.hint = r.status === 'bad-code' ? describe(r, c.tag).notices[0].text : '';
}

// Show what is saved right away, then ask the relay. The map never waits on the network.
async function openCloud({ force = true } = {}) {
  const c = M.cloud;
  if (c.syncing || (!force && Date.now() - c.last < RECHECK_MS)) return;
  c.syncing = true;
  renderCloud();
  try {
    let rec = null;
    try { rec = await loadCloud(); } catch { /* unreadable storage: ask for the code again */ }
    c.hasCode = !!(rec && rec.code);
    c.loaded = true;
    if (c.hasCode && rec.response && !c.response) {
      c.response = cleanResponse(rec.response);
      c.settled = true;
      c.result = { status: 'cached', fetched: rec.fetched, response: c.response };
    }
    renderCloud();
    pushData();
    if (!c.hasCode) return;
    try { c.tag = await storedTag(); } catch { c.tag = null; }
    applyResult(await syncCloud({ store: cloudStore, fetchFn: (u, init) => fetch(u, init), tag: c.tag }));
    c.last = Date.now();
  } finally {
    c.syncing = false;
    renderCloud();
    syncMap();
    pushData();
  }
}

el.codeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (M.cloud.syncing) return;
  const check = checkCode(el.code.value);
  M.cloud.hint = check.message;
  if (!check.ok) { renderCloud(); el.code.focus(); return; }
  try {
    await saveCloud({ code: check.value });
  } catch {
    M.cloud.hint = 'This device could not save the code.';
    renderCloud();
    return;
  }
  el.code.value = '';
  M.cloud.response = null;
  M.cloud.result = null;
  M.cloud.settled = false;
  await openCloud();
});
el.refresh.addEventListener('click', () => openCloud());

/* ---------- the map frame ---------- */

function pushData() {
  if (!M.frameLoaded || !showCard()) return;
  const r = M.cloud.response;
  const input = buildInput(M.files, {
    simulated: r && r.sim,
    recorded: r && r.recorded,
    recordedUpdated: r && r.recorded_updated,
  });
  const win = el.frame.contentWindow;
  try {
    const api = win && win.ScourgeMap;
    if (api && typeof api.load === 'function') api.load(input);
    else if (win) win.postMessage({ type: 'scourge-map-load', input }, location.origin);
  } catch {
    showMessages([{ kind: 'bad', text: 'The map could not show these files.' }]);
  }
}

// Load the page the first time the tab is opened with something to draw, then keep it fed.
function syncMap() {
  if (M.tab !== 'map' || !showCard()) return;
  if (!M.frameStarted) {
    M.frameStarted = true;
    el.frame.src = 'map.html?embed=1';
    return;
  }
  pushData();
}

el.frame.addEventListener('load', () => { M.frameLoaded = true; pushData(); });

// The page reports its height so it grows with its content and the phone scrolls
// one page, not a box inside a page. Only our own origin and our own frame count.
let appliedHeight = 0;
window.addEventListener('message', (e) => {
  if (M.tab !== 'map') return; // a hidden frame has no real size
  const h = acceptHeight(e, el.frame.contentWindow, location.origin);
  if (h === null || Math.abs(h - appliedHeight) < 2) return;
  appliedHeight = h;
  el.frame.style.height = h + 'px';
});

/* ---------- start ---------- */

showTab(loadTab(), { save: false });
refresh();

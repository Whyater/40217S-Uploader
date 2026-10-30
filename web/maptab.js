// The Upload / Route Map switch and the Route Map tab. app.js owns the Upload tab and is not touched.
import { readTab, planAdd, buildInput, summaryText, formatBytes, acceptHeight, MAX_BYTES } from './mapdata.js';
import { listFiles, putFiles, removeFile, state as storeState } from './mapstore.js';

const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'), tabs: $('tabs'),
  tabBtns: [...document.querySelectorAll('#tabs [role="tab"]')],
  viewUpload: $('view-upload'), viewMap: $('view-map'),
  file: $('map-file'), add: $('map-add'), addEmpty: $('map-add-empty'),
  empty: $('map-empty'), bar: $('map-bar'), summary: $('map-summary'),
  manage: $('map-manage'), list: $('map-list'), volatile: $('map-volatile'),
  msgs: $('map-msgs'), card: $('map-card'), frame: $('map-frame'),
};

const TAB_KEY = 'scourge-tab';
const M = { tab: 'upload', files: [], busy: false, frameLoaded: false, frameStarted: false };

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
  if (tab === 'map') syncMap();
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

function showMessages(items) {
  el.msgs.textContent = '';
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
    el.msgs.appendChild(li);
  }
}

/* ---------- file list ---------- */

const KIND_LABEL = { csv: 'Results', json: 'Route data' };

function renderFiles() {
  const has = M.files.length > 0;
  el.empty.hidden = has;
  el.bar.hidden = !has;
  el.manage.hidden = !has;
  el.card.hidden = !has;
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

/* ---------- the map frame ---------- */

function pushData() {
  if (!M.frameLoaded || !M.files.length) return;
  const input = buildInput(M.files);
  const win = el.frame.contentWindow;
  try {
    const api = win && win.ScourgeMap;
    if (api && typeof api.load === 'function') api.load(input);
    else if (win) win.postMessage({ type: 'scourge-map-load', input }, location.origin);
  } catch {
    showMessages([{ kind: 'bad', text: 'The map could not show these files.' }]);
  }
}

// Load the page the first time the tab is opened with files, then keep it fed.
function syncMap() {
  if (M.tab !== 'map' || !M.files.length) return;
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

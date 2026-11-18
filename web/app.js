import { support, requestBrain, knownBrain, openBrain, closeBrain } from './transport.js';
import {
  slotModes, shortTag, buildTitle, buildCatalog, olderList, validateKeepName, idleUploadText, progressText,
  runSlotUploads, resultText, lostText, erasedSlots,
  checkLatest, downloadByTag, loadBuild, loadBuildByTag, listStored, setPicked,
  getKept, setKept, removeKept, KEPT_RESET_TEXT, KEPT_UNREADABLE_TEXT, loadFullBuilds, loadPublished, cleanupStored,
} from './releases.js';
import { queryBrain, uploadProgram } from './protocol/index.js';
import { Recorder, requestRecordPort, knownRecordPort } from './record.js';
import { recordRules, idleLine, lineKind, RECORD_HELP } from './recordui.js';
import { loadCloud } from './mapstore.js';

const $ = (id) => document.getElementById(id);
const el = {
  net: $('net'), netText: $('net-text'),
  unsupported: $('unsupported'),
  buildTitle: $('build-title'), buildDetail: $('build-detail'),
  newer: $('newer'), newerText: $('newer-text'),
  getLatest: $('get-latest'),
  pick: $('build-pick'), keepBtn: $('keep-btn'), keepMenu: $('keep-menu'),
  keepAdd: $('keep-add'), keepRename: $('keep-rename'), keepRemove: $('keep-remove'),
  catalogMsg: $('catalog-msg'), catalogMsgText: $('catalog-msg-text'), catalogRetry: $('catalog-retry'),
  slots: $('slots'),
  olderDlg: $('older-dlg'), olderList: $('older-list'), olderMsg: $('older-msg'), olderRetry: $('older-retry'), olderCancel: $('older-cancel'),
  keepDlg: $('keep-dlg'), keepForm: $('keep-form'), keepTitle: $('keep-title'), keepName: $('keep-name'),
  keepPreview: $('keep-preview'), keepError: $('keep-error'), keepCancel: $('keep-cancel'),
  conn: $('conn'), connText: $('conn-text'),
  status: $('status'), statusText: $('status-text'), statusIcon: document.querySelector('#status use'),
  upload: $('upload'), uploadLabel: $('upload-label'),
  tests: $('tests'), putTester: $('put-tester'), testerNote: $('tester-note'),
  recHelp: $('rec-help'), recRecord: $('rec-record'), recSend: $('rec-send'),
  recStatus: $('rec-status'), recText: $('rec-text'), recIcon: document.querySelector('#rec-status use'),
  details: $('details'), log: $('log'), copyLog: $('copy-log'),
};

const S = {
  build: null,
  busy: false,
  recording: false, // from the tap on Record Results until the recording ends
  stopping: false,
  downloading: false,
  offline: !navigator.onLine,
  newerTag: null,   // tag of a published build newer than the stored one
  result: null,     // { kind, text } shown until the user changes something
  stored: [],        // tags stored on this device
  kept: {},          // tag -> name, or null when unreadable
  fullBuilds: null,  // [{tag, note}] or null when unknown
  published: null,   // [{tag, date, assets}] newest first, or null
  newestTag: null,   // the build bundled with this site
  catalogError: '',
  keepMode: 'add',
  pct: null,        // upload percent while busy
  conn: 'idle',     // idle | checking | connected
  sup: { serial: false, usb: false },
};

const supported = () => S.sup.serial || S.sup.usb;
// The Mac app says "click"; a touch screen taps.
const tap = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches ? 'tap' : 'click');
const TESTER = { slot: 8, name: 'Scourge Tester', files: ['tester-hot.package.bin', 'tester-cold.package.bin', 'tester-project.pros'] };
const testerOk = () => !!S.build && TESTER.files.every((f) => S.build.files[f] && S.build.files[f].length);

/* ---------- build text (same wording as the Mac app) ---------- */

function buildSummary(rel) {
  const tag = String(rel.tag || '');
  const first = String(rel.notes || '').split('\n')[0].trim();
  let sha = '';
  let subject = '';
  let m = /^Built from robot code commit ([0-9a-fA-F]{7,40})$/.exec(first);
  if (m) sha = m[1].slice(0, 7);
  else if ((m = /^Built from ([0-9a-fA-F]+):\s*(.*)$/.exec(first))) { sha = m[1].slice(0, 7); subject = m[2]; }
  if (!sha) {
    const t = /^build-\d{1,9}-([0-9a-fA-F]{7,40})$/.exec(tag);
    if (t) sha = t[1].slice(0, 7);
  }
  const short = shortTag(tag);
  const isCI = short !== tag;
  let title = isCI ? short : subject;
  const parts = [];
  if (!title) title = String(rel.title || '').trim() || `Build ${tag}`;
  else if (!isCI) parts.push(`Build ${tag}`);
  if (sha) parts.push(`commit ${sha}`);
  let detail = parts.join(', ');
  detail = detail.charAt(0).toUpperCase() + detail.slice(1);
  const when = fmtTime(rel.built_at);
  if (when) detail += (detail ? '\n' : '') + `Built ${when}`;
  return { title, detail };
}

/* ---------- log ---------- */

const logLines = [];
function log(msg, level) {
  const t = new Date().toTimeString().slice(0, 8);
  const line = `${t}  ${level === 'error' ? 'ERROR ' : ''}${msg}`;
  logLines.push(line);
  el.log.textContent = logLines.join('\n');
  el.log.scrollTop = el.log.scrollHeight;
}

el.copyLog.addEventListener('click', async () => {
  const text = logLines.length ? logLines.join('\n') : 'Nothing has run yet.';
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el.log);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  el.copyLog.textContent = ok ? 'Copied' : 'Select the log and copy it';
  setTimeout(() => { el.copyLog.textContent = 'Copy Log'; }, 1800);
});

/* ---------- small renderers ---------- */

let workTimer = null;
let workBase = '';
let workStart = 0;
function paintWork() {
  const s = Math.max(0, Math.floor((Date.now() - workStart) / 1000));
  el.statusText.textContent = `${workBase} (${s} s)`;
}

const KIND_ICON = { idle: 'i-info', work: 'i-clock', good: 'i-check', bad: 'i-warn', warn: 'i-warn' };

function setStatus(kind, text) {
  if (kind === 'work') {
    if (el.status.dataset.kind === 'work' && workBase === text) return;
    if (el.status.dataset.kind !== 'work') workStart = Date.now();
    workBase = text;
    if (!workTimer) workTimer = setInterval(paintWork, 1000);
  } else {
    if (workTimer) { clearInterval(workTimer); workTimer = null; }
    if (el.status.dataset.kind === kind && el.statusText.textContent === text) return;
  }
  el.status.dataset.kind = kind;
  el.statusIcon.setAttribute('href', '#' + (KIND_ICON[kind] || 'i-info'));
  if (kind === 'work') paintWork(); else el.statusText.textContent = text;
  el.status.classList.remove('enter');
  void el.status.offsetWidth;
  el.status.classList.add('enter');
}

function setConn(state) {
  S.conn = state;
  const map = {
    idle: ['idle', 'Brain connects when you upload'],
    checking: ['idle', 'Checking for a brain…'],
    connected: ['good', 'Brain connected'],
    unavailable: ['idle', 'Connection status unavailable'],
  };
  const [kind, text] = map[state] || map.idle;
  el.conn.dataset.kind = kind;
  el.connText.textContent = text;
}

// "Oct 24, 2026 6:58 PM", local time, like the Mac app.
function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} ${time}`;
}

const keptName = (tag) => (S.kept && S.kept[tag]) || '';
const buildLabel = () => (S.build ? buildTitle(S.build.release.tag, keptName(S.build.release.tag)) : '');
const goTap = () => (tap() === 'tap' ? 'Tap' : 'Click');

function idleStatus() {
  if (!supported()) return ['bad', "This browser can't connect to the brain. Open this page in Chrome on Android, or Chrome or Edge on a computer."];
  if (S.downloading) return ['work', 'Downloading robot code…'];
  if (!S.build) return ['idle', `${goTap()} Get Latest to download a build first.`];
  return ['idle', idleUploadText(S.build, buildLabel())];
}

function renderSlots() {
  const rows = slotModes(S.build);
  el.slots.replaceChildren(...rows.map((m) => {
    const li = document.createElement('li');
    li.dataset.present = S.build ? String(m.present) : 'true';
    const n = document.createElement('span');
    n.className = 'slot-n';
    n.textContent = `Slot ${m.slot}`;
    const what = document.createElement('span');
    what.className = 'slot-what';
    what.textContent = `${m.label}, ${!S.build || m.present ? m.name : 'Not in this build'}`;
    li.append(n, what);
    return li;
  }));
}

// "Build 437 · full build · Not downloaded"
function optionText(item) {
  return [item.title, item.label, item.stored ? '' : 'Not downloaded'].filter(Boolean).join(' · ');
}

function renderPicker() {
  const groups = buildCatalog({ newestTag: S.newestTag, fullBuilds: S.fullBuilds, stored: S.stored, kept: S.kept });
  const current = S.build ? S.build.release.tag : '';
  const nodes = [];
  for (const g of groups) {
    const og = document.createElement('optgroup');
    og.label = g.title;
    for (const item of g.items) {
      const o = document.createElement('option');
      o.value = item.tag;
      o.textContent = optionText(item);
      og.appendChild(o);
    }
    nodes.push(og);
  }
  if (!groups.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No build yet';
    nodes.push(o);
  }
  const older = document.createElement('option');
  older.value = '__older__';
  older.textContent = 'Older Build…';
  nodes.push(older);
  el.pick.replaceChildren(...nodes);
  el.pick.value = current;
  if (el.pick.value !== current) el.pick.selectedIndex = 0;
}

function renderKeepMenu() {
  const tag = S.build ? S.build.release.tag : null;
  const isKept = !!tag && !!S.kept && Object.prototype.hasOwnProperty.call(S.kept, tag);
  el.keepAdd.hidden = isKept;
  el.keepRename.hidden = !isKept;
  el.keepRemove.hidden = !isKept;
  // An unreadable kept list still allows Keep: saving backs the old list up as kept.bak and starts over.
  el.keepBtn.disabled = !tag || S.busy || S.downloading;
  if (el.keepBtn.disabled) closeKeepMenu();
}

function render() {
  const busy = S.busy || S.downloading;

  // Build panel
  if (S.build) {
    const sum = buildSummary(S.build.release);
    el.buildTitle.hidden = true;
    el.buildDetail.textContent = sum.detail;
    el.buildDetail.hidden = !sum.detail;
  } else {
    el.buildTitle.hidden = false;
    el.buildTitle.textContent = 'No build downloaded yet';
    el.buildDetail.textContent = `${goTap()} Get Latest to download it.`;
    el.buildDetail.hidden = false;
  }
  el.newer.hidden = !S.newerTag;
  if (S.newerTag) el.newerText.textContent = `${buildTitle(S.newerTag, keptName(S.newerTag))} is available. ${goTap()} Get Latest to download it.`;
  el.catalogMsg.hidden = !S.catalogError;
  el.catalogMsgText.textContent = S.catalogError;
  el.getLatest.disabled = busy;
  el.getLatest.textContent = S.downloading ? 'Downloading…' : 'Get Latest';
  renderPicker();
  el.pick.disabled = busy;
  renderKeepMenu();
  renderSlots();

  el.unsupported.hidden = supported();
  if (!supported() && S.conn === 'idle') setConn('unavailable');

  // Robot Tests
  const rules = recordRules({
    uploading: S.busy, downloading: S.downloading, recording: S.recording, stopping: S.stopping,
    supported: supported(), testerOk: testerOk(), hasBuild: !!S.build, canSend: recorder.canSend,
  });
  el.putTester.disabled = rules.tester;
  el.recRecord.textContent = rules.recordLabel;
  el.recRecord.disabled = rules.record;
  el.recSend.disabled = rules.send;
  const noTester = !testerOk();
  el.testerNote.hidden = !noTester;
  el.testerNote.textContent = `The Scourge Tester is not in this build. ${goTap()} Get Latest or pick a newer build.`;

  // Status + button
  if (!S.busy) {
    const [k, t] = S.result ? [S.result.kind, S.result.text] : idleStatus();
    setStatus(k, t);
  }
  el.upload.dataset.working = S.busy ? 'true' : 'false';
  el.uploadLabel.textContent = S.busy ? `Uploading…${S.pct == null ? '' : ' ' + Math.round(S.pct) + '%'}` : 'Upload to Robot';
  el.upload.disabled = rules.upload;
}

function renderNet() {
  el.net.dataset.state = S.offline ? 'offline' : 'online';
  el.net.hidden = !S.offline;
  el.netText.textContent = 'You are offline.';
}

/* ---------- build library ---------- */

async function refreshLibrary() {
  try { S.stored = await listStored(); } catch (e) { S.stored = []; }
  try { S.kept = await getKept(); } catch (e) { S.kept = null; }
}

async function loadLists() {
  try {
    const f = await loadFullBuilds();
    S.fullBuilds = f.builds;
    if (!f.builds) log('Full builds list unavailable');
  } catch (e) { S.fullBuilds = null; }
  render();
}

// Run after a good download. Deletes nothing while a list is unknown.
async function tidy() {
  const gone = await cleanupStored({ newestTag: S.newestTag });
  if (gone.length) log(`Removed stored builds: ${gone.join(', ')}`);
  await refreshLibrary();
}

async function useBuild(tag) {
  const b = await loadBuildByTag(tag);
  if (!b) throw new Error("Couldn't read that build from this device. Download it again.");
  await setPicked(tag);
  S.build = b;
  S.result = null;
  log(`Picked ${b.release.title || tag}`);
}

async function publishedList(force) {
  if (S.published && !force) return S.published;
  S.published = await loadPublished();
  return S.published;
}

async function downloadTag(tag) {
  if (S.busy || S.downloading) return;
  S.downloading = true;
  S.result = null;
  S.catalogError = '';
  render();
  try {
    const from = { newest: 'the newest build on this site', bundled: 'a full build on this site', relay: "the team's relay" };
    const b = await downloadByTag(tag, {
      newestTag: S.newestTag,
      onSource: (src) => log(`Downloading ${shortTag(tag)} from ${from[src]}`),
      onProgress: ({ file, done, total }) => log(`Downloaded ${file} (${done} of ${total})`),
    });
    S.build = b;
    S.offline = false;
    renderNet();
    if (S.newerTag === b.release.tag) S.newerTag = null;
    await tidy();
    S.result = { kind: 'good', text: `Downloaded ${buildTitle(b.release.tag, keptName(b.release.tag))}. Ready to upload.` };
    log(`Downloaded ${b.release.title || b.release.tag}`);
  } catch (e) {
    const msg = (e && e.message) || 'The download failed.';
    S.result = { kind: 'bad', text: `Could not download the code. ${msg}` };
    S.catalogError = msg;
    log(`Download failed: ${msg}`, 'error');
  } finally {
    S.downloading = false;
    try { S.build = (await loadBuild()) || S.build; } catch { /* keep what we have */ }
    render();
  }
}

async function getLatest() {
  if (S.busy || S.downloading) return;
  S.catalogError = '';
  if (!S.newestTag) {
    // Not checked yet (or offline): check, which also learns the newest tag.
    await checkForNew({ download: true });
    return;
  }
  await downloadTag(S.newestTag);
}
el.getLatest.addEventListener('click', getLatest);

async function checkForNew({ download = false } = {}) {
  try {
    const r = await checkLatest();
    if (r.offline && r.error) {
      // Online but something (often public Wi-Fi sign-in) answered instead of GitHub.
      S.result = { kind: 'warn', text: S.build ? `${r.error} You can still upload the build you already have.` : r.error };
      log(`Update check failed: ${r.error}`, 'error');
    } else if (r.offline) {
      S.offline = true;
      renderNet();
      S.result = S.build
        ? { kind: 'idle', text: 'No internet connection. You can still upload the build you already have.' }
        : { kind: 'bad', text: `No internet connection. Connect to Wi-Fi, then ${tap()} Get Latest.` };
      log('Offline, skipped update check');
    } else {
      S.newestTag = (r.release && r.release.tag) || null;
      if (!S.build || download) {
        log(S.build ? 'Downloading the newest build' : 'No build stored, downloading');
        S.newerTag = null;
        render();
        await downloadTag(S.newestTag);
        return;
      }
      if (r.isNew) {
        S.newerTag = S.newestTag;
        log(`Newer build available: ${(r.release && (r.release.title || r.release.tag)) || 'a newer build'}`);
      } else {
        S.newerTag = null;
        log('Newest build is stored');
      }
    }
  } catch (e) {
    const msg = (e && e.message) || 'Could not check for new code.';
    S.result = { kind: 'warn', text: S.build ? `${msg} You can still upload the build you already have.` : msg };
    log(`Update check failed: ${msg}`, 'error');
  }
  render();
}

/* ---------- picker, older builds, keep ---------- */

el.pick.addEventListener('change', async () => {
  const tag = el.pick.value;
  if (tag === '__older__') {
    el.pick.value = S.build ? S.build.release.tag : '';
    openOlder();
    return;
  }
  if (!tag || (S.build && S.build.release.tag === tag)) return;
  if (S.stored.includes(tag)) {
    try { await useBuild(tag); } catch (e) { S.result = { kind: 'bad', text: e.message }; }
    render();
  } else {
    await downloadTag(tag);
  }
});

el.catalogRetry.addEventListener('click', async () => {
  S.catalogError = '';
  S.published = null;
  render();
  if (!S.newestTag) await checkForNew();
  else if (!S.stored.includes(S.newestTag)) await downloadTag(S.newestTag);
});

async function openOlder(force) {
  el.olderList.replaceChildren();
  el.olderMsg.hidden = true;
  el.olderRetry.hidden = true;
  if (!el.olderDlg.open) el.olderDlg.showModal();
  el.olderMsg.textContent = 'Loading builds…';
  el.olderMsg.hidden = false;
  let list;
  try {
    list = await publishedList(force);
  } catch (e) {
    el.olderMsg.textContent = (e && e.message) || "Couldn't load the build list.";
    el.olderRetry.hidden = false;
    return;
  }
  el.olderMsg.hidden = true;
  if (S.fullBuilds === null) { try { S.fullBuilds = (await loadFullBuilds()).builds; } catch { /* leave unknown */ } }
  const rows = olderList({ published: list, fullBuilds: S.fullBuilds, stored: S.stored, kept: S.kept });
  el.olderList.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'older-text';
    const t = document.createElement('span');
    t.textContent = r.title;
    const sub = document.createElement('span');
    sub.className = 'caption secondary';
    sub.textContent = [fmtDay(r.date), r.note, r.stored ? 'On this device' : ''].filter(Boolean).join(' · ');
    text.append(t, sub);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn bordered accent-text';
    b.textContent = r.stored ? 'Pick' : 'Download and Pick';
    b.addEventListener('click', async () => {
      el.olderDlg.close();
      if (r.stored) { try { await useBuild(r.tag); } catch (e) { S.result = { kind: 'bad', text: e.message }; } render(); }
      else await downloadTag(r.tag);
    });
    li.append(text, b);
    return li;
  }));
}
el.olderCancel.addEventListener('click', () => el.olderDlg.close());
el.olderRetry.addEventListener('click', () => openOlder(true));

function fmtDay(s) {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function closeKeepMenu() {
  el.keepMenu.hidden = true;
  el.keepBtn.setAttribute('aria-expanded', 'false');
}
el.keepBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = el.keepMenu.hidden;
  el.keepMenu.hidden = !open;
  el.keepBtn.setAttribute('aria-expanded', String(open));
  if (open) (el.keepMenu.querySelector('.menu-item:not([hidden])') || el.keepBtn).focus();
});
document.addEventListener('click', (e) => { if (!el.keepMenu.contains(e.target)) closeKeepMenu(); });
el.keepMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeKeepMenu(); el.keepBtn.focus(); } });

function openKeepDialog(mode) {
  closeKeepMenu();
  if (!S.build) return;
  S.keepMode = mode;
  const tag = S.build.release.tag;
  el.keepTitle.textContent = mode === 'add' ? 'Keep This Build' : 'Rename';
  el.keepName.value = mode === 'rename' ? keptName(tag) : '';
  el.keepError.hidden = true;
  paintKeepPreview();
  el.keepDlg.showModal();
  el.keepName.focus();
  el.keepName.select();
}

function paintKeepPreview() {
  const v = validateKeepName(el.keepName.value);
  const tag = S.build ? S.build.release.tag : '';
  el.keepPreview.textContent = v.ok ? `Shown as "${buildTitle(tag, v.value)}"` : 'Shown as the name you enter, then the build.';
}
el.keepName.addEventListener('input', () => { el.keepError.hidden = true; paintKeepPreview(); });
el.keepAdd.addEventListener('click', () => openKeepDialog('add'));
el.keepRename.addEventListener('click', () => openKeepDialog('rename'));
el.keepCancel.addEventListener('click', () => el.keepDlg.close());
el.keepForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = validateKeepName(el.keepName.value);
  if (!v.ok) { el.keepError.textContent = v.message; el.keepError.hidden = false; return; }
  try {
    const damaged = (await getKept()) === null;
    S.kept = await setKept(S.build.release.tag, v.value);
    log(`Kept ${shortTag(S.build.release.tag)} as "${v.value}"`);
    if (damaged) { S.result = { kind: 'warn', text: KEPT_RESET_TEXT }; log(KEPT_RESET_TEXT, 'error'); }
    el.keepDlg.close();
  } catch (err) {
    el.keepError.textContent = err && err.message === KEPT_UNREADABLE_TEXT ? err.message : "Couldn't save the name on this device.";
    el.keepError.hidden = false;
  }
  render();
});
el.keepRemove.addEventListener('click', async () => {
  closeKeepMenu();
  if (!S.build) return;
  try {
    S.kept = await removeKept(S.build.release.tag);
    log(`Stopped keeping ${shortTag(S.build.release.tag)}`);
  } catch (err) {
    S.result = { kind: 'bad', text: err.message || "Couldn't update the kept builds." };
  }
  render();
});

/* ---------- upload ---------- */

const STAGE_TEXT = {
  connect: 'Talking to the brain',
  library: 'Sending the PROS library',
  'library-skipped': 'PROS library already on the brain',
  stop: 'Stopping the running program',
  ini: 'Sending program info',
  bin: 'Sending the program',
  done: 'Finishing up',
};

// The library's name on the brain is a hash of the template names in
// project.pros, so it has to come from the same file PROS reads.
function projectInfo(bytes) {
  const state = JSON.parse(new TextDecoder().decode(bytes))['py/state'];
  const templates = Object.keys(state.templates);
  const kernel = state.templates.kernel;
  const meta = (kernel && (kernel['py/state'] || kernel).metadata) || {};
  return {
    templates,
    kernelVersion: kernel && (kernel['py/state'] || kernel).version,
    hotAddr: meta.hot_addr ? Number(meta.hot_addr) : undefined,
    coldAddr: meta.cold_addr ? Number(meta.cold_addr) : undefined,
  };
}

// One place to adapt if the protocol module's options change.
// Matches the desktop apps: `pros upload --after screen`, and say yes when
// PROS wants to clear out old libraries to make room.
function doUpload(port, build, job, slot, name, onProgress, onErased) {
  const f = build.files;
  const project = projectInfo(f[job.pros]);
  return uploadProgram(port, {
    bin: f[job.hot],
    coldBin: f[job.cold],
    coldTemplates: project.templates,
    hotAddr: project.hotAddr,
    coldAddr: project.coldAddr,
    ideVersion: project.kernelVersion,
    slot,
    name,
    runAfter: 'screen',
    // pros-cli asks before this on the command line, so ask here too.
    confirmEviction: (libs) => {
      const progs = libs.flatMap((l) => l.programs);
      const ok = window.confirm(
        'The brain is full of old PROS libraries. To make room, the uploader has to delete the 3 oldest' +
        (progs.length ? ` and these programs that use them: ${progs.join(', ')}` : '') +
        '. Delete them and keep uploading?');
      log(ok ? `Removing old libraries: ${libs.map((l) => l.library).join(', ')}` : 'Kept the old libraries');
      return ok;
    },
    onProgress: (p) => {
      if (p.stage === 'erased') { onErased(p.programs); return; }
      onProgress({ ...p, stage: STAGE_TEXT[p.stage] || p.stage });
    },
  });
}

let wake = null;
async function keepAwake(what = 'the upload') {
  try {
    if ('wakeLock' in navigator) {
      wake = await navigator.wakeLock.request('screen');
      log(`Screen will stay awake during ${what}`);
    }
  } catch (e) {
    log(`Could not keep the screen awake: ${e.message || e}`);
  }
}
async function releaseAwake() {
  try { if (wake) await wake.release(); } catch { /* already released */ }
  wake = null;
}

window.addEventListener('beforeunload', (e) => {
  if (!S.busy && !S.recording) return;
  e.preventDefault();
  e.returnValue = '';
});

// Connects to the brain, runs fn(port), and always puts things back.
// fn handles its own upload failures; this catches connection problems.
async function withBrain(startText, label, fn) {
  S.busy = true;
  S.result = null;
  S.pct = null;
  render();
  setStatus('work', startText);
  setConn('checking');
  log(`Upload start: ${label}`);

  let port = null;
  let contacted = false;
  try {
    port = await knownBrain();
    if (port) log('Using the brain Chrome already allowed');
    else {
      log('Asking Chrome for the brain');
      port = await requestBrain();
    }
    await keepAwake();
    port = (await openBrain(port)) || port;
    log('Port open');
    const info = await queryBrain(port);
    contacted = true;
    setConn('connected');
    log(`Brain answered: ${typeof info === 'string' ? info : JSON.stringify(info)}`);
    await fn(port);
  } catch (e) {
    const msg = (e && e.message) || 'The upload failed. Check the cable and try again.';
    log(`Upload failed: ${msg}`, 'error');
    if (e && e.stack) log(e.stack);
    S.result = { kind: 'bad', text: msg };
    el.details.open = true;
    // On a computer the brain shows up as two ports. If the one Chrome
    // remembered doesn't answer, forget it so the next tap asks again.
    // Only when the very first message failed, and only on a computer.
    if (e && e.code === 'NO_RESPONSE' && !contacted && support().serial && port && typeof port.forget === 'function') {
      try { await port.forget(); port = null; log('Forgot that port; the next upload will ask for the brain again'); } catch { /* keep going */ }
    }
  } finally {
    doUpload.lastStage = null;
    if (port) { await closeBrain(port); log('Port closed'); }
    await releaseAwake();
    S.busy = false;
    S.pct = null;
    setConn(supported() ? 'idle' : 'unavailable');
    render();
  }
}

function onStage({ stage, sent, total }) {
  const pct = total ? (sent / total) * 100 : null;
  S.pct = pct;
  el.uploadLabel.textContent = `Uploading…${pct == null ? '' : ' ' + Math.round(pct) + '%'}`;
  if (stage !== doUpload.lastStage) { doUpload.lastStage = stage; log(`Stage: ${stage}`); }
}

// Every program the picked build has, in slot order, sharing one library.
async function onUpload() {
  if (S.busy || S.downloading || S.recording || !S.build) return;
  const build = S.build;
  const label = buildLabel();
  await withBrain(`Uploading ${label}. Keep the cable plugged in.`, label, async (port) => {
    const res = await runSlotUploads(build, async (mode, ctx) => {
      log(`Slot ${mode.slot}: ${mode.label}, name "${mode.name}"`);
      await doUpload(port, build, { hot: mode.hot, cold: 'cold.package.bin', pros: 'project.pros' }, mode.slot, mode.name, onStage, (programs) => {
        log(`PROS removed: ${programs.join(', ')}`);
        ctx.erased(programs);
      });
      log(`Slot ${mode.slot} finished`);
    }, {
      onStart: ({ i, n, mode }) => { setStatus('work', progressText(label, i, n, mode)); },
    });
    if (res.failed) {
      log(`Slot ${res.failed.slot} failed: ${res.failed.message}`, 'error');
      if (res.failed.error && res.failed.error.stack) log(res.failed.error.stack);
      el.details.open = true;
    } else log('Upload finished');
    S.result = { kind: res.failed ? 'bad' : (res.lost.length ? 'warn' : 'good'), text: resultText(label, res) };
  });
}
el.upload.addEventListener('click', onUpload);

async function onTester() {
  if (S.busy || S.downloading || S.recording || !testerOk()) return;
  const build = S.build;
  el.tests.open = true;
  const label = 'Scourge Tester';
  await withBrain(`Uploading the Scourge Tester to slot ${TESTER.slot}. Keep the cable plugged in.`, `${label}, slot ${TESTER.slot}`, async (port) => {
    const erased = [];
    try {
      await doUpload(port, build, { hot: TESTER.files[0], cold: TESTER.files[1], pros: TESTER.files[2] }, TESTER.slot, TESTER.name, onStage, (programs) => {
        log(`PROS removed: ${programs.join(', ')}`);
        erased.push(...programs);
      });
    } catch (e) {
      // The erase happens before the program is sent, so it can stick even
      // when the upload then fails. A retry won't mention it again.
      const lost = erasedSlots(erased).filter((n) => n !== TESTER.slot);
      const msg = (e && e.message) || 'The upload failed. Check the cable and try again.';
      log(`Upload failed: ${msg}`, 'error');
      S.result = { kind: 'bad', text: lost.length ? `${msg} ${lostText(lost)}` : msg };
      el.details.open = true;
      return;
    }
    log('Upload finished');
    const lost = erasedSlots(erased).filter((n) => n !== TESTER.slot);
    S.result = lost.length
      ? { kind: 'warn', text: `Uploaded Scourge Tester to slot ${TESTER.slot}. ${lostText(lost)}` }
      : { kind: 'good', text: `Uploaded Scourge Tester to slot ${TESTER.slot}. Run it from the brain screen.` };
  });
}
el.putTester.addEventListener('click', onTester);

/* ---------- record and send results ---------- */

const RECORD_VERSION = 'web'; // the site has no version number of its own
let recSaid = false; // a status has come in since the page opened
function setRecLine(kind, text) {
  el.recStatus.dataset.kind = kind;
  el.recIcon.setAttribute('href', '#' + (KIND_ICON[kind] || 'i-info'));
  el.recText.textContent = text;
}
const recorder = new Recorder({
  onLine: () => {},
  onStatus: ({ text, kind }) => { recSaid = true; setRecLine(lineKind(kind), text); },
  onProgress: (tally) => { if (!recSaid) setRecLine('idle', idleLine({ tally })); render(); },
});
el.recHelp.textContent = RECORD_HELP;

async function savedCode() {
  try { const rec = await loadCloud(); return (rec && rec.code) || ''; } catch { return ''; }
}
// The code is saved on the Route Map tab, which has no event for it, so look again when the page comes back.
async function syncTeamCode() {
  const code = await savedCode();
  if (code) { recorder.teamCodeSaved(code); render(); }
}
window.addEventListener('focus', syncTeamCode);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncTeamCode(); });
el.tests.addEventListener('toggle', () => { if (el.tests.open) syncTeamCode(); });

async function onRecord() {
  if (S.recording) { S.stopping = true; recorder.stop(); render(); return; }
  if (S.busy || S.downloading) return;
  S.recording = true;
  render();
  try {
    // Asked inside the tap, so the browser lets the picker open.
    const link = (await knownRecordPort()) || (await requestRecordPort());
    await keepAwake('the recording');
    log('Recording started');
    await recorder.start(link);
    log('Recording ended');
  } catch (e) {
    recSaid = true;
    setRecLine('bad', (e && e.message) || 'Could not start recording.');
    log(`Recording failed: ${(e && e.message) || e}`, 'error');
  } finally {
    recorder.clearEarlyStop(); // a Stop that never reached start() must not end the next recording
    await releaseAwake();
    S.recording = false;
    S.stopping = false;
    render();
  }
}
el.recRecord.addEventListener('click', onRecord);

async function onSend() {
  if (!recorder.canSend || S.busy || S.recording) return;
  const code = await savedCode();
  const send = recorder.send({ version: RECORD_VERSION, testerBuild: S.build ? S.build.release.tag : '', code });
  render();
  await send;
  render();
}
el.recSend.addEventListener('click', onSend);

/* ---------- start ---------- */

window.addEventListener('online', () => {
  S.offline = false;
  renderNet();
  if (!S.busy && !S.downloading) { checkForNew(); if (!S.fullBuilds) loadLists(); }
});
window.addEventListener('offline', () => {
  S.offline = true;
  renderNet();
  if (!S.busy && !S.downloading) {
    S.result = S.build
      ? { kind: 'idle', text: 'No internet connection. You can still upload the build you already have.' }
      : { kind: 'bad', text: `No internet connection. Connect to Wi-Fi, then ${tap()} Get Latest.` };
    render();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => log(`Offline install unavailable: ${e.message || e}`));
}

async function start() {
  recorder.load();
  syncTeamCode();
  try { S.sup = support(); } catch { S.sup = { serial: false, usb: false }; }
  log(`Browser support: serial ${S.sup.serial ? 'yes' : 'no'}, usb ${S.sup.usb ? 'yes' : 'no'}`);
  setConn(supported() ? 'idle' : 'unavailable');
  renderNet();
  try { S.build = await loadBuild(); } catch (e) { log(`Could not read the stored build: ${e.message || e}`, 'error'); }
  if (S.build) log(`Stored build: ${S.build.release.title || S.build.release.tag}`);
  await refreshLibrary();
  render();
  loadLists();
  await checkForNew();
}
start();

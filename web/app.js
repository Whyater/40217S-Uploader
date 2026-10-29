import { support, requestBrain, knownBrain, openBrain, closeBrain } from './transport.js';
import { MODES, validateName, checkLatest, downloadLatest, loadBuild, modeAvailable } from './releases.js';
import { queryBrain, uploadProgram } from './protocol/index.js';

const $ = (id) => document.getElementById(id);
const el = {
  net: $('net'), netText: $('net-text'),
  unsupported: $('unsupported'),
  buildTitle: $('build-title'), buildDetail: $('build-detail'),
  newer: $('newer'), newerText: $('newer-text'),
  getLatest: $('get-latest'),
  mode: $('mode'), modeHint: $('mode-hint'),
  slot: $('slot'), name: $('name'), nameError: $('name-error'),
  conn: $('conn'), connText: $('conn-text'),
  status: $('status'), statusText: $('status-text'), statusIcon: document.querySelector('#status use'),
  upload: $('upload'), uploadLabel: $('upload-label'),
  tests: $('tests'), putTester: $('put-tester'), testerNote: $('tester-note'),
  details: $('details'), log: $('log'), copyLog: $('copy-log'),
};

const S = {
  build: null,
  modeId: MODES[0].id,
  busy: false,
  downloading: false,
  offline: !navigator.onLine,
  newerTag: null,   // tag of a published build newer than the stored one
  result: null,     // { kind, text } shown until the user changes something
  nameTouched: false,
  pct: null,        // upload percent while busy
  conn: 'idle',     // idle | checking | connected
  sup: { serial: false, usb: false },
};

const defaultNames = new Set(MODES.map((m) => m.name));
const curMode = () => MODES.find((m) => m.id === S.modeId) || MODES[0];
const modeOk = (m) => !!S.build && modeAvailable(S.build, m.id);
const supported = () => S.sup.serial || S.sup.usb;
// The Mac app says "click"; a touch screen taps.
const tap = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches ? 'tap' : 'click');
const TESTER = { slot: 8, name: 'Scourge Tester', files: ['tester-hot.package.bin', 'tester-cold.package.bin', 'tester-project.pros'] };
const testerOk = () => !!S.build && TESTER.files.every((f) => S.build.files[f] && S.build.files[f].length);

/* ---------- build text (same wording as the Mac app) ---------- */

function shortTag(tag) {
  const m = /^build-(\d+)(?=-|$)/.exec(tag || '');
  return m ? `Build ${m[1]}` : String(tag || '');
}

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

const missingModeText = (m) => `This build has no ${m.label} version. Switch to Competition or get a newer build.`;
const modeSuffix = (m) => (m.id === MODES[0].id ? '' : ` as ${m.label}`);

function nameMessage(v) {
  if (v.ok) return '';
  return v.value === '' ? 'Enter a program name.' : 'Use letters, numbers, spaces, - _ or . (20 max), starting with a letter or number.';
}

function idleStatus() {
  const m = curMode();
  if (!supported()) return ['bad', "This browser can't connect to the brain. Open this page in Chrome on Android, or Chrome or Edge on a computer."];
  if (S.downloading) return ['work', 'Downloading the latest robot code…'];
  if (!S.build) return ['idle', `${tap() === 'tap' ? 'Tap' : 'Click'} Get Latest to download a build first.`];
  if (!modeOk(m)) return ['warn', missingModeText(m)];
  if (!validateName(el.name.value).ok) return ['warn', `Fix the program name, then ${tap()} Upload to Robot.`];
  return ['idle', `Ready to upload ${shortTag(S.build.release.tag)}${modeSuffix(m)} to slot ${el.slot.value}. Plug the USB cable into the brain first.`];
}

function render() {
  const m = curMode();
  const busy = S.busy || S.downloading;

  // Build panel
  if (S.build) {
    const sum = buildSummary(S.build.release);
    el.buildTitle.textContent = sum.title;
    el.buildDetail.textContent = sum.detail;
    el.buildDetail.hidden = !sum.detail;
  } else {
    el.buildTitle.textContent = 'No build downloaded yet';
    el.buildDetail.textContent = `${tap() === 'tap' ? 'Tap' : 'Click'} Get Latest to download it.`;
    el.buildDetail.hidden = false;
  }
  el.newer.hidden = !S.newerTag;
  if (S.newerTag) el.newerText.textContent = `${shortTag(S.newerTag)} is available. ${tap() === 'tap' ? 'Tap' : 'Click'} Get Latest to download it.`;
  el.getLatest.disabled = busy;
  el.getLatest.textContent = S.downloading ? 'Downloading…' : 'Get Latest';

  // Mode picker: a mode the build lacks is greyed out, not hidden.
  for (const opt of el.mode.options) {
    opt.disabled = !!S.build && !modeAvailable(S.build, opt.value);
  }
  el.mode.value = S.modeId;
  if (S.build && !modeOk(m)) {
    el.modeHint.textContent = missingModeText(m);
    el.modeHint.hidden = false;
  } else {
    el.modeHint.hidden = true;
  }
  el.mode.disabled = busy;
  el.slot.disabled = busy;
  el.name.disabled = busy;

  // Name validation
  const v = validateName(el.name.value);
  const showErr = !v.ok && (S.nameTouched || el.name.value !== '');
  el.nameError.textContent = showErr ? nameMessage(v) : '';
  el.nameError.hidden = !showErr;
  el.name.setAttribute('aria-invalid', showErr ? 'true' : 'false');

  el.unsupported.hidden = supported();
  if (!supported() && S.conn === 'idle') setConn('unavailable');

  // Robot Tests
  const canTester = supported() && testerOk() && !busy;
  el.putTester.disabled = !canTester;
  const noTester = !testerOk();
  el.testerNote.hidden = !noTester;
  el.testerNote.textContent = `The Scourge Tester is not in the latest release yet. ${tap() === 'tap' ? 'Tap' : 'Click'} Get Latest.`;

  // Status + button
  if (!S.busy) {
    const [k, t] = S.result ? [S.result.kind, S.result.text] : idleStatus();
    setStatus(k, t);
  }
  el.upload.dataset.working = S.busy ? 'true' : 'false';
  el.uploadLabel.textContent = S.busy ? `Uploading…${S.pct == null ? '' : ' ' + Math.round(S.pct) + '%'}` : 'Upload to Robot';
  el.upload.disabled = S.busy || S.downloading || !supported() || !S.build || !modeOk(m);
}

function renderNet() {
  el.net.dataset.state = S.offline ? 'offline' : 'online';
  el.net.hidden = !S.offline;
  el.netText.textContent = 'You are offline.';
}

/* ---------- controls ---------- */

for (let i = 1; i <= 8; i++) {
  const o = document.createElement('option');
  o.value = o.textContent = String(i);
  el.slot.appendChild(o);
}

for (const m of MODES) {
  const o = document.createElement('option');
  o.value = m.id;
  o.textContent = m.label;
  el.mode.appendChild(o);
}
el.mode.addEventListener('change', () => {
  const m = MODES.find((x) => x.id === el.mode.value) || MODES[0];
  S.modeId = m.id;
  el.slot.value = String(m.slot);
  const cur = el.name.value;
  if (cur.trim() === '' || defaultNames.has(cur.trim())) el.name.value = m.name;
  S.result = null;
  render();
});

el.slot.addEventListener('change', () => { S.result = null; render(); });
el.name.addEventListener('input', () => { S.result = null; render(); });
el.name.addEventListener('blur', () => { S.nameTouched = true; render(); });
el.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.name.blur(); }
});

/* ---------- download ---------- */

async function getLatest() {
  if (S.busy || S.downloading) return;
  S.downloading = true;
  S.result = null;
  render();
  log('Downloading latest robot code');
  try {
    const b = await downloadLatest(({ file, done, total }) => {
      log(`Downloaded ${file} (${done} of ${total})`);
    });
    S.build = b || (await loadBuild());
    S.offline = false;
    renderNet();
    S.newerTag = null;
    S.result = { kind: 'good', text: `Downloaded ${shortTag(S.build.release.tag)}. Ready to upload.` };
    log(`Downloaded ${S.build ? S.build.release.title : 'build'}`);
  } catch (e) {
    const msg = (e && e.message) || 'The download failed.';
    S.result = { kind: 'bad', text: `Could not download the code. ${msg}` };
    log(`Download failed: ${msg}`, 'error');
  } finally {
    S.downloading = false;
    render();
  }
}
el.getLatest.addEventListener('click', getLatest);

async function checkForNew() {
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
    } else if (!S.build) {
      log('No build stored, downloading');
      render();
      await getLatest();
      return;
    } else if (r.isNew) {
      S.newerTag = (r.release && r.release.tag) || null;
      log(`Newer build available: ${(r.release && (r.release.title || r.release.tag)) || 'a newer build'}`);
    } else {
      S.newerTag = null;
      log('Build is current');
    }
  } catch (e) {
    const msg = (e && e.message) || 'Could not check for new code.';
    S.result = { kind: 'warn', text: S.build ? `${msg} You can still upload the build you already have.` : msg };
    log(`Update check failed: ${msg}`, 'error');
  }
  render();
}

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
function doUpload(port, job, slot, name, onProgress, onErased) {
  const f = S.build.files;
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
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      wake = await navigator.wakeLock.request('screen');
      log('Screen will stay awake during the upload');
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
  if (!S.busy) return;
  e.preventDefault();
  e.returnValue = '';
});

// A new build replaces the PROS library, and PROS deletes every program
// that used the old one. Work out which other slots need uploading again.
function lostSlots(erased, slot) {
  return [...new Set(erased.map((f) => Number((/^slot_(\d+)\.bin$/.exec(f) || [])[1])))]
    .filter((n) => n && n !== slot).sort((a, b) => a - b);
}
function lostText(lost) {
  const many = lost.length > 1;
  return `The new code replaced the PROS library, so the brain deleted ${many ? `the programs in slots ${lost.join(' and ')}` : `the program in slot ${lost[0]}`}. Upload ${many ? 'those modes' : 'that mode'} again if you need ${many ? 'them' : 'it'}.`;
}

// One upload path for the competition modes and the tester.
// job: { hot, cold, pros, slot, name, working, done, tail, label }
async function runJob(job) {
  const { slot, name } = job;
  S.busy = true;
  S.result = null;
  S.pct = null;
  render();
  setStatus('work', job.working);
  setConn('checking');
  log(`Upload start: ${job.label}, slot ${slot}, name "${name}"`);

  let port = null;
  let contacted = false;
  const erased = [];
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
    await doUpload(port, job, slot, name, ({ stage, sent, total }) => {
      const pct = total ? (sent / total) * 100 : null;
      S.pct = pct;
      el.uploadLabel.textContent = `Uploading…${pct == null ? '' : ' ' + Math.round(pct) + '%'}`;
      if (stage !== doUpload.lastStage) { doUpload.lastStage = stage; log(`Stage: ${stage}`); }
    }, (programs) => {
      log(`PROS removed: ${programs.join(', ')}`);
      erased.push(...programs);
    });
    log('Upload finished');
    const lost = lostSlots(erased, slot);
    S.result = lost.length
      ? { kind: 'warn', text: `${job.done} ${lostText(lost)}` }
      : { kind: 'good', text: `${job.done} Run it from the brain screen.` };
  } catch (e) {
    const msg = (e && e.message) || 'The upload failed. Check the cable and try again.';
    log(`Upload failed: ${msg}`, 'error');
    if (e && e.stack) log(e.stack);
    // The erase happens before the program is sent, so it can stick even
    // when the upload then fails. A retry won't mention it again.
    const lost = lostSlots(erased, slot);
    S.result = { kind: 'bad', text: lost.length ? `${msg} ${lostText(lost)}` : msg };
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

async function onUpload() {
  if (S.busy || S.downloading) return;
  const mode = curMode();
  const v = validateName(el.name.value);
  if (!v.ok) {
    S.nameTouched = true;
    S.result = null;
    render();
    el.name.focus();
    return;
  }
  if (!modeOk(mode)) return;
  const slot = Number(el.slot.value);
  const name = v.value;
  await runJob({
    hot: mode.hot, cold: 'cold.package.bin', pros: 'project.pros', slot, name,
    label: mode.label,
    working: `Uploading to slot ${slot}. Keep the cable plugged in.`,
    done: mode.id === MODES[0].id ? `Uploaded to slot ${slot}.` : `Uploaded ${name} (${mode.label}) to slot ${slot}.`,
  });
}
el.upload.addEventListener('click', onUpload);

async function onTester() {
  if (S.busy || S.downloading || !testerOk()) return;
  el.tests.open = true;
  await runJob({
    hot: TESTER.files[0], cold: TESTER.files[1], pros: TESTER.files[2], slot: TESTER.slot, name: TESTER.name,
    label: 'Scourge Tester',
    working: `Uploading the Scourge Tester to slot ${TESTER.slot}. Keep the cable plugged in.`,
    done: `Uploaded Scourge Tester to slot ${TESTER.slot}.`,
  });
}
el.putTester.addEventListener('click', onTester);

/* ---------- start ---------- */

window.addEventListener('online', () => {
  S.offline = false;
  renderNet();
  if (!S.busy && !S.downloading) checkForNew();
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
  try { S.sup = support(); } catch { S.sup = { serial: false, usb: false }; }
  log(`Browser support: serial ${S.sup.serial ? 'yes' : 'no'}, usb ${S.sup.usb ? 'yes' : 'no'}`);
  const m = curMode();
  el.slot.value = String(m.slot);
  el.name.value = m.name;
  setConn(supported() ? 'idle' : 'unavailable');
  renderNet();
  try { S.build = await loadBuild(); } catch (e) { log(`Could not read the stored build: ${e.message || e}`, 'error'); }
  if (S.build) log(`Stored build: ${S.build.release.title || S.build.release.tag}`);
  render();
  await checkForNew();
}
start();

import { support, requestBrain, knownBrain, openBrain, closeBrain } from './transport.js';
import { MODES, validateName, checkLatest, downloadLatest, loadBuild, modeAvailable } from './releases.js';
import { queryBrain, uploadProgram } from './protocol/index.js';

const $ = (id) => document.getElementById(id);
const el = {
  net: $('net'), netText: $('net-text'),
  unsupported: $('unsupported'),
  buildTitle: $('build-title'), buildMeta: $('build-meta'), codeNote: $('code-note'),
  getLatest: $('get-latest'), dlProgress: $('dl-progress'),
  modeSeg: $('mode-seg'), modeHint: $('mode-hint'),
  slot: $('slot'), name: $('name'), nameError: $('name-error'),
  status: $('status'), statusText: $('status-text'),
  upProgress: $('up-progress'), upload: $('upload'),
  details: $('details'), log: $('log'), copyLog: $('copy-log'),
};

const S = {
  build: null,
  modeId: MODES[0].id,
  busy: false,
  downloading: false,
  offline: !navigator.onLine,
  codeNote: null,   // { kind, text }
  result: null,     // { kind, text } shown until the user changes something
  nameTouched: false,
  sup: { serial: false, usb: false },
};

const defaultNames = new Set(MODES.map((m) => m.name));
const curMode = () => MODES.find((m) => m.id === S.modeId) || MODES[0];
const modeOk = (m) => !!S.build && modeAvailable(S.build, m.id);
const supported = () => S.sup.serial || S.sup.usb;

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
  setTimeout(() => { el.copyLog.textContent = 'Copy log'; }, 1800);
});

/* ---------- small renderers ---------- */

function setStatus(kind, text) {
  if (el.status.dataset.kind === kind && el.statusText.textContent === text) return;
  el.status.dataset.kind = kind;
  el.statusText.textContent = text;
  el.status.classList.remove('enter');
  void el.status.offsetWidth;
  el.status.classList.add('enter');
}

function setProgress(box, pct, caption) {
  const bar = box.querySelector('.bar');
  const fill = bar.firstElementChild;
  if (pct == null) {
    bar.dataset.indeterminate = 'true';
    bar.removeAttribute('aria-valuenow');
    fill.style.width = '';
  } else {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    delete bar.dataset.indeterminate;
    bar.setAttribute('aria-valuenow', String(p));
    fill.style.width = p + '%';
  }
  box.querySelector('.caption').textContent = caption || '';
}

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function idleStatus() {
  const m = curMode();
  if (!supported()) return ['warn', "This browser can't connect to the brain. Open this page in Chrome on Android, or Chrome or Edge on a computer."];
  if (S.downloading) return ['work', 'Downloading robot code. Keep this page open.'];
  if (!S.build) return ['idle', 'Get the robot code first, then plug in the brain and tap Upload to robot.'];
  if (!modeOk(m)) return ['warn', 'Pick another mode or get the latest code, then tap Upload to robot.'];
  if (!validateName(el.name.value).ok) return ['warn', 'Fix the program name, then tap Upload to robot.'];
  return ['idle', 'Ready. Plug the USB cable into the brain, then tap Upload to robot.'];
}

function render() {
  const m = curMode();
  const busy = S.busy || S.downloading;

  // Code panel
  if (S.build) {
    el.buildTitle.textContent = S.build.release.title || S.build.release.tag;
    el.buildTitle.classList.remove('empty');
    const when = fmtTime(S.build.release.built_at);
    el.buildMeta.textContent = when ? `Built ${when}` : '';
    el.buildMeta.hidden = !when;
  } else {
    el.buildTitle.textContent = 'No robot code downloaded yet.';
    el.buildTitle.classList.add('empty');
    el.buildMeta.hidden = true;
  }
  const n = S.codeNote;
  el.codeNote.textContent = n ? n.text : '';
  el.codeNote.dataset.kind = n ? n.kind : 'idle';
  el.getLatest.disabled = busy;
  el.getLatest.textContent = S.downloading ? 'Downloading…' : 'Get latest code';

  // Mode segments
  for (const inp of el.modeSeg.querySelectorAll('input')) {
    const mode = MODES.find((x) => x.id === inp.value);
    inp.checked = inp.value === S.modeId;
    inp.disabled = busy || (!!S.build && !modeAvailable(S.build, mode.id));
  }
  if (S.build && !modeOk(m)) {
    el.modeHint.textContent = `The downloaded build has no ${m.label} version. Get latest code, or ask the programmer.`;
    el.modeHint.hidden = false;
  } else {
    el.modeHint.hidden = true;
  }
  el.slot.disabled = busy;
  el.name.disabled = busy;

  // Name validation
  const v = validateName(el.name.value);
  const showErr = !v.ok && (S.nameTouched || el.name.value !== '');
  el.nameError.textContent = showErr ? v.message : '';
  el.nameError.hidden = !showErr;
  el.name.setAttribute('aria-invalid', showErr ? 'true' : 'false');

  // Unsupported panel
  el.unsupported.hidden = supported();

  // Status + button
  if (!S.busy) {
    const [k, t] = S.result ? [S.result.kind, S.result.text] : idleStatus();
    setStatus(k, t);
  }
  el.upload.dataset.working = S.busy ? 'true' : 'false';
  el.upload.textContent = S.busy ? 'Uploading…' : 'Upload to robot';
  el.upload.disabled = S.busy || S.downloading || !supported() || !S.build || !modeOk(m);
}

function renderNet() {
  el.net.dataset.state = S.offline ? 'offline' : 'online';
  el.netText.textContent = S.offline ? 'Offline' : 'Online';
}

/* ---------- controls ---------- */

for (let i = 1; i <= 8; i++) {
  const o = document.createElement('option');
  o.value = o.textContent = String(i);
  el.slot.appendChild(o);
}

for (const m of MODES) {
  const lab = document.createElement('label');
  const inp = document.createElement('input');
  inp.type = 'radio';
  inp.name = 'mode';
  inp.value = m.id;
  const face = document.createElement('span');
  face.className = 'seg-face';
  face.textContent = m.label;
  const sub = document.createElement('small');
  sub.textContent = `Slot ${m.slot}`;
  face.appendChild(sub);
  lab.append(inp, face);
  el.modeSeg.appendChild(lab);
  inp.addEventListener('change', () => {
    if (!inp.checked) return;
    S.modeId = m.id;
    el.slot.value = String(m.slot);
    const cur = el.name.value;
    if (cur.trim() === '' || defaultNames.has(cur)) el.name.value = m.name;
    S.result = null;
    render();
  });
}
el.modeSeg.setAttribute('role', 'radiogroup');
el.modeSeg.setAttribute('aria-label', 'Mode');

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
  setProgress(el.dlProgress, null, 'Starting download');
  el.dlProgress.hidden = false;
  render();
  log('Downloading latest robot code');
  try {
    const b = await downloadLatest(({ file, done, total }) => {
      const pct = total ? (done / total) * 100 : null;
      setProgress(el.dlProgress, pct, `${file}${pct == null ? '' : '  ' + Math.round(pct) + '%'}`);
    });
    S.build = b || (await loadBuild());
    S.offline = false;
    S.codeNote = { kind: 'good', text: 'You already have the latest code.' };
    log(`Downloaded ${S.build ? S.build.release.title : 'build'}`);
  } catch (e) {
    const msg = (e && e.message) || 'The download failed.';
    S.codeNote = { kind: 'bad', text: msg };
    log(`Download failed: ${msg}`, 'error');
  } finally {
    S.downloading = false;
    el.dlProgress.hidden = true;
    render();
  }
}
el.getLatest.addEventListener('click', getLatest);

async function checkForNew() {
  try {
    const r = await checkLatest();
    if (r.offline && r.error) {
      // Online but something (often public Wi-Fi sign-in) answered instead of GitHub.
      S.codeNote = { kind: 'warn', text: S.build ? `${r.error} You can still upload the code you already have.` : r.error };
      log(`Update check failed: ${r.error}`, 'error');
    } else if (r.offline) {
      S.offline = true;
      renderNet();
      S.codeNote = {
        kind: 'warn',
        text: S.build
          ? 'No internet connection. You can still upload the code you already have.'
          : 'No internet connection. Connect once to download the robot code.',
      };
      log('Offline, skipped update check');
    } else if (!S.build) {
      log('No build stored, downloading');
      render();
      await getLatest();
      return;
    } else if (r.isNew) {
      const t = (r.release && (r.release.title || r.release.tag)) || 'A newer build';
      S.codeNote = { kind: 'accent', text: `${t} is available. Tap Get latest code to download it.` };
      log(`Newer build available: ${t}`);
    } else {
      S.codeNote = { kind: 'good', text: 'You already have the latest code.' };
      log('Build is current');
    }
  } catch (e) {
    const msg = (e && e.message) || 'Could not check for new code.';
    S.codeNote = { kind: 'warn', text: S.build ? `${msg} You can still upload the code you already have.` : msg };
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
function doUpload(port, mode, slot, name, onProgress, onErased) {
  const f = S.build.files;
  const project = projectInfo(f['project.pros']);
  return uploadProgram(port, {
    bin: f[mode.hot],
    coldBin: f['cold.package.bin'],
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
  S.busy = true;
  S.result = null;
  render();
  setStatus('work', `Uploading ${mode.label} to slot ${slot}. Keep the cable plugged in.`);
  setProgress(el.upProgress, null, 'Connecting to the brain');
  el.upProgress.hidden = false;
  log(`Upload start: ${mode.label}, slot ${slot}, name "${name}"`);

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
    log(`Brain answered: ${typeof info === 'string' ? info : JSON.stringify(info)}`);
    await doUpload(port, mode, slot, name, ({ stage, sent, total }) => {
      const pct = total ? (sent / total) * 100 : null;
      setProgress(el.upProgress, pct, `${stage}${pct == null ? '' : '  ' + Math.round(pct) + '%'}`);
      if (stage !== doUpload.lastStage) { doUpload.lastStage = stage; log(`Stage: ${stage}`); }
    }, (programs) => {
      log(`PROS removed: ${programs.join(', ')}`);
      erased.push(...programs);
    });
    log('Upload finished');
    const lost = lostSlots(erased, slot);
    S.result = lost.length
      ? { kind: 'warn', text: `Uploaded ${mode.label} to slot ${slot}. ${lostText(lost)}` }
      : { kind: 'good', text: `Uploaded ${mode.label} to slot ${slot}. Run it from the brain screen.` };
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
    el.upProgress.hidden = true;
    render();
  }
}
el.upload.addEventListener('click', onUpload);

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
    S.codeNote = {
      kind: 'warn',
      text: S.build
        ? 'No internet connection. You can still upload the code you already have.'
        : 'No internet connection. Connect once to download the robot code.',
    };
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
  renderNet();
  try { S.build = await loadBuild(); } catch (e) { log(`Could not read the stored build: ${e.message || e}`, 'error'); }
  if (S.build) log(`Stored build: ${S.build.release.title || S.build.release.tag}`);
  render();
  await checkForNew();
}
start();

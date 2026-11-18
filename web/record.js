// Record Results, Stop Recording and Send Results for the web uploader, ported
// from the Mac app (Recording.swift, ResultsSubmission.swift, AppModel.swift)
// and the Windows app (Add-RecordLine, Send-Results). No DOM, so Node can test it.
//
// API
//   requestRecordPort()            ask for the cable (user gesture). Returns a link:
//                                  { via: 'serial' | 'usb', product: 'brain' | 'controller', port }
//   knownRecordPort()              a link already granted, or null when it can't tell which port
//   new Recorder({ onLine, onStatus, onProgress, storage })
//     .load()                      restore the last results saved in this browser
//     .start(link)                 record until stop(); resolves with { kind, file, error }
//     .stop()
//     .send({ version, testerBuild, code, fetchFn, relay })   Send Results
//     .teamCodeSaved(code)         a file sent without the map taking it can go again
//     .state, .file, .tally, .canSend, .csv
//   onLine(text, stream)           every line the robot printed (stream 'sout', 'serr', or '' for plain text)
//   onStatus({ text, kind })       kind is 'working', 'success', 'info' or 'error'
//   onProgress(tally)              counts while recording, and after it ends
//   ResultsTally                   .add(fields), .closed(), .summary, .statusLine, .sentLine(onMap), .usable
//   UserStreamDecoder, cobsDecode, TextLines, scourgeLine   the user port byte stream
//   buildCsv(lines), dataLines(text), tallyLines(lines), buildSubmission(...), sendResults(...)
//
// Where the robot's printf output comes from. `pros terminal` reads the brain's
// USB user port: the second CDC pair (interfaces 2/3; the upload uses 0/1). The
// PROS 4 kernel wraps each write in a COBS packet whose first 4 bytes name the
// stream ('sout', 'serr', 'kdbg', 'jinx') and ends it with a 0x00 (kernel
// ser_driver.c; pros-cli V5UserDevice.read). A program can turn COBS off, so
// plain text is read too. A controller has no user port: pros-cli switches it
// to the download channel and polls the user FIFO with ext command 0x27
// (V5WirelessPort, V5Device.user_fifo_read). Both paths are done the same way here.

import { SerialPort as PolyfillPort } from './vendor/serial-polyfill.js';
import { VEX_VENDOR_ID, BRAIN_PRODUCT_ID, closeBrain } from './transport.js';
import { SerialConnection, V5Device, withDownloadChannel, V5Error } from './protocol/index.js';
import { MANIFEST_URL, relayBase } from './mapcloud.js';

export const CONTROLLER_PRODUCT_ID = 0x0503;
export const RESULTS_HEADER = 'kind,test,key,value,unit';
const STORAGE_KEY = 'scourge-results-v1';
const SEND_TIMEOUT_MS = 60000;
const MAX_BODY_CHARS = 600000; // the relay's limit; it splits anything under this into issues itself
const CLIENT_HEADER = 'web-uploader';
const ROW_TAGS = new Set(['AP', 'AM', 'AS']);

export const TEXT = {
  neutral: 'Recording. On the controller, press X to send.',
  tester: 'Recording tester results. Keep the cable connected.',
  cutOff: 'That recording was cut off. Press X on the controller again.',
  full: 'Got the full recording. Tap Send Results.',
  waiting: "Waiting for the robot's radio...",
  radioDown: 'The controller could not reach the robot\'s radio. Turn the robot on and wait for the controller to link, or plug USB into the brain instead.',
  stopping: 'Stopping recording…',
  stoppedEarly: 'Recording stopped before it began.',
  nothing: 'Nothing was recorded.',
  saved: 'Results saved. Tap Send Results.',
  dropped: 'The connection to the robot dropped.',
  unexpected: 'Recording stopped unexpectedly.',
  quiet: 'No answer from the robot yet. Start the program on the brain. If it is running, stop and pick the port called User.',
  stopFirst: 'Stop recording before sending results.',
  noResults: 'No results yet.',
  alreadySent: 'Those results were already sent. Record again to send new ones.',
  sending: 'Sending results...',
  sentMap: 'Sent. It shows on the Route Map in about a minute.',
  sentNoMap: "Sent, but it won't show on the Route Map without the team code. Enter it in Route Map, then send again.",
  sentCut: 'Sent, but that recording was cut off. Press X on the controller and record again.',
  unsupported: "This browser can't talk to USB devices. Use Chrome on Android, or Chrome or Edge on a computer.",
  nonePicked: 'No brain or controller was picked.',
  busy: 'The brain is in use by another app. Close VEXcode or other VEX tabs, then try again.',
  openFailed: "Couldn't open the USB port. Unplug it, plug it back in, and try again.",
  noUserPort: "Couldn't find the brain's user port. Unplug the brain, plug it back in, and try again.",
};

/* ---------- COBS and the user port stream ---------- */

// Standard COBS, as the kernel's cobs_encode writes it. Returns null for a
// packet that can't be valid (a zero inside, or a block running past the end).
export function cobsDecode(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const code = src[i];
    if (code === 0) return null;
    if (i + code > src.length) return null;
    for (let j = 1; j < code; j++) {
      const b = src[i + j];
      if (b === 0) return null;
      out.push(b);
    }
    i += code;
    if (code !== 0xff && i < src.length) out.push(0);
  }
  return Uint8Array.from(out);
}

const isStreamId = (b) => b.length >= 4 && [0, 1, 2, 3].every((k) => b[k] > 0x20 && b[k] < 0x7f);

function joinBytes(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// Turns user port bytes into { stream, data } chunks. Starts undecided: the
// first good COBS packet locks it to COBS, and a stretch of text with newlines
// and no 0x00 at all locks it to plain text (a program that called
// serctl(SERCTL_DISABLE_COBS)). A packet cut off at the start of a connection
// fails to decode and is dropped, the way pros-cli logs and skips it.
export class UserStreamDecoder {
  constructor({ plainAfter = 256, maxPacket = 65536 } = {}) {
    this.mode = 'unknown';
    this.bad = 0;
    this.plainAfter = plainAfter;
    this.maxPacket = maxPacket;
    this.buf = new Uint8Array(0);
  }

  push(bytes) {
    const chunk = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (this.mode === 'plain') return chunk.length ? [{ stream: '', data: chunk.filter((b) => b !== 0) }] : [];
    this.buf = joinBytes(this.buf, chunk);
    const out = [];
    let zero;
    while ((zero = this.buf.indexOf(0)) >= 0) {
      const packet = this.buf.slice(0, zero);
      this.buf = this.buf.slice(zero + 1);
      if (!packet.length) continue;
      const msg = cobsDecode(packet);
      if (!msg || !isStreamId(msg)) { this.bad += 1; continue; }
      this.mode = 'cobs';
      out.push({ stream: String.fromCharCode(msg[0], msg[1], msg[2], msg[3]), data: msg.slice(4) });
    }
    if (this.mode === 'unknown' && this.buf.length >= this.plainAfter && this.buf.includes(10)) {
      this.mode = 'plain';
      out.push({ stream: '', data: this.buf });
      this.buf = new Uint8Array(0);
    } else if (this.buf.length > this.maxPacket) {
      this.bad += 1;
      this.buf = new Uint8Array(0);
    }
    return out;
  }
}

// Splits each stream into lines. A printf can arrive in pieces, so the tail is
// kept per stream. Like pros-cli's decode_bytes_to_str, a payload ends at its first 0x00.
export class TextLines {
  constructor() { this.parts = new Map(); }

  push(stream, data) {
    let s = this.parts.get(stream);
    if (!s) { s = { dec: new TextDecoder('utf-8'), tail: '' }; this.parts.set(stream, s); }
    const end = data.indexOf(0);
    const text = s.tail + s.dec.decode(end >= 0 ? data.slice(0, end) : data, { stream: true });
    const pieces = text.split('\n');
    s.tail = pieces.pop();
    return pieces.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  // Whatever is left once the connection ends.
  flush() {
    const out = [];
    for (const [stream, s] of this.parts) {
      const rest = s.tail + s.dec.decode();
      if (rest) out.push({ stream, line: rest.replace(/\r$/, '') });
      s.tail = '';
    }
    return out;
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// The laptops keep "SCOURGE,..." to the end of the line and drop anything before it.
export function scourgeLine(line) {
  const m = /SCOURGE,.*$/.exec(String(line).replace(ANSI, ''));
  return m ? m[0].trim() : null;
}

/* ---------- the tally (ResultsTally in Recording.swift) ---------- */

export class ResultsTally {
  constructor() {
    this.values = 0;
    this.tests = new Set();
    this.recordings = 0; // whole autopath recordings
    this.cutOff = 0;
    this.open = false;
    this.rows = 0;
    this.expected = 0;
    this.last = 'none'; // 'none' | 'full' | 'cutOff'
    this.seen = new Map(); // row number -> row text, so a repeat counts once and a changed repeat is caught
    this.conflict = false;
    this.version = 0;
    this.orphaned = false; // rows or an END arrived with no BEGIN (the radio attached late)
  }

  copy() {
    const t = Object.assign(new ResultsTally(), this);
    t.tests = new Set(this.tests);
    t.seen = new Map(this.seen);
    return t;
  }

  get hasAutopath() { return this.open || this.recordings + this.cutOff > 0; }
  get usable() { return this.recordings >= 1 || this.values > 0; }

  // One SCOURGE line split on commas. True when something a person would see changed.
  // Autopath lines need exactly five fields ending in the empty one the trailing comma makes,
  // so a line cut short is not counted.
  add(fields) {
    if (fields.length < 3) return false;
    switch (fields[1]) {
      case 'BEGIN': {
        if (fields[2] !== 'autopath') {
          const had = this.tests.has(fields[2]);
          this.tests.add(fields[2]);
          return !had;
        }
        const begin = wellFormed(fields) ? parseBegin(fields[3]) : null;
        if (!begin) return false;
        if (this.open) this.cutOff += 1; // the last one never ended
        this.open = true; this.rows = 0; this.last = 'none';
        this.seen = new Map(); this.conflict = false; this.orphaned = false;
        this.expected = begin.rows; this.version = begin.version;
        return true;
      }
      case 'END': {
        if (fields[2] !== 'autopath') return false;
        if (!wellFormed(fields) || !isInt(fields[3])) return false;
        const endRows = Number(fields[3]);
        const maxSeq = this.seen.size ? Math.max(...this.seen.keys()) : -1;
        if (this.open && !this.conflict && this.version === 1 && endRows === this.expected && this.rows === this.expected &&
            (this.expected === 0 || maxSeq === this.expected - 1)) {
          this.recordings += 1; this.last = 'full';
        } else if (this.open || !this.orphaned) {
          this.cutOff += 1; this.last = 'cutOff';
          this.orphaned = !this.open;
        } else {
          return false;
        }
        this.open = false;
        this.seen = new Map();
        return true;
      }
      case 'HELLO':
        return false;
      case 'AP': case 'AM': case 'AS': {
        if (!wellFormed(fields) || !isInt(fields[2]) || Number(fields[2]) < 0 || !validRow(fields[1], fields[3])) return false;
        if (!this.open) {
          if (this.orphaned) return false;
          this.orphaned = true; this.cutOff += 1; this.last = 'cutOff';
          return true;
        }
        const seq = Number(fields[2]);
        const row = `${fields[1]}|${fields[3]}`;
        if (this.seen.has(seq)) {
          if (this.seen.get(seq) !== row) this.conflict = true;
          return false;
        }
        this.seen.set(seq, row);
        this.rows = this.seen.size;
        return true;
      }
      default:
        this.values += 1;
        this.tests.add(fields[1]);
        return true;
    }
  }

  // The same tally once nothing more is coming: a recording still open was cut off.
  closed() {
    const t = this.copy();
    if (t.open) { t.open = false; t.cutOff += 1; t.last = 'cutOff'; }
    return t;
  }

  get summary() {
    const tester = `${this.values} values from ${this.tests.size} tests`;
    if (!this.hasAutopath) return `Recorded ${tester}`;
    const n = this.recordings + this.cutOff + (this.open ? 1 : 0);
    let auto = `${n} autopath recording${n === 1 ? '' : 's'}`;
    if (n === 1) auto += ` (${this.rows} rows${this.cutOff === 1 ? ', cut off)' : ')'}`;
    else if (this.cutOff > 0) auto += `, ${this.cutOff} cut off`;
    return `Recorded ${this.values > 0 ? `${tester} and ` : ''}${auto}`;
  }

  // The status line for an autopath recording; null for a tester file.
  get statusLine() {
    if (this.open) return `Recording: ${this.rows} of ${this.expected} rows`;
    if (this.last === 'full') return TEXT.full;
    if (this.last === 'cutOff') return TEXT.cutOff;
    return null;
  }

  // What the status says after a send; null for a tester file. onMap false means the relay
  // did not take the team code, so the recording reached the data repo but not the map.
  sentLine(onMap = null) {
    if (this.recordings >= 1) return onMap === false ? TEXT.sentNoMap : TEXT.sentMap;
    if (this.hasAutopath) return TEXT.sentCut;
    return null;
  }
}

const isInt = (s) => /^[+-]?\d+$/.test(s);
const wellFormed = (f) => f.length === 5 && f[4] === '';

// "1;teach;L;1200;Build 1": version, kind, side, rows, build label.
function parseBegin(payload) {
  const p = payload.split(';');
  if (p.length < 5) return null;
  let v = p[0].trim();
  if (v.startsWith('v=')) v = v.slice(2);
  const side = p[2].trim();
  if (!isInt(v) || !isInt(p[3]) || (side !== 'L' && side !== 'R')) return null;
  return { version: Number(v), rows: Number(p[3]) };
}

// AP: 9 whole numbers. AM: 8 parts, a type in the second. AS: 10 parts, a type in the third.
function validRow(tag, payload) {
  const p = payload.split(';');
  const nums = (items) => items.every(isInt);
  if (tag === 'AP') return p.length === 9 && nums(p);
  if (tag === 'AM') return p.length === 8 && p[1] !== '' && nums(p.slice(0, 1)) && nums(p.slice(2));
  if (tag === 'AS') return p.length === 10 && p[2] !== '' && nums(p.slice(0, 2)) && nums(p.slice(3));
  return false;
}

export function tallyLines(lines) {
  const t = new ResultsTally();
  for (const line of lines) t.add(line.split(','));
  return t.closed();
}

/* ---------- the results file ---------- */

export function buildCsv(lines) {
  return `${RESULTS_HEADER}\n${lines.map((l) => `${l}\n`).join('')}`;
}

// The data lines of a results file: everything after the header, minus blank lines.
export function dataLines(text) {
  return String(text).split('\n').slice(1).map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fileId = (d) => `results-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function makeFile(id, lines) {
  return { id, lines: lines.slice(), tally: tallyLines(lines) };
}

// Which file Send uses after a recording. A new one with a whole recording or tester data takes
// over; an empty one, a cut-off copy, or stray rows from a late start never replace a good earlier file.
export function sendable(previous, next) {
  if (!next) return previous || null;
  if (next.tally.usable) return next;
  return previous || next;
}

// A sent file stays locked until a new file with usable data replaces it, so a double tap can't file it twice.
export const canSendFile = (file, sentId) => !!file && file.id !== sentId;

/* ---------- sending ---------- */

export function buildSubmission({ lines, version, testerBuild, now = Date.now }) {
  const d = new Date(now());
  return {
    title: `Robot data ${localDate(d)}`,
    body: `Uploader web ${version}, tester build ${testerBuild || 'unknown'}, UTC ${d.toISOString()}\r\n\r\n${lines.join('\r\n')}`,
  };
}

async function timedFetch(fetchFn, url, init, timeoutMs) {
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: ctl ? ctl.signal : undefined });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// Posts the whole file in one request to results_url from uploader.json (the relay splits it into
// issues). The team code goes only in X-Team-Code, never in a message or a log. Never throws.
// Returns { ok, text, kind, issues, onMap }: text is the status line to show.
export async function sendResults({ file, version, testerBuild, code = '', fetchFn = globalThis.fetch, relay = '', now = Date.now, timeoutMs = SEND_TIMEOUT_MS }) {
  const fail = (text) => ({ ok: false, text, kind: 'error', issues: [], onMap: null });
  if (!file || !file.lines.length) return fail(TEXT.noResults);
  const content = buildSubmission({ lines: file.lines, version, testerBuild, now });
  if (content.body.length > MAX_BODY_CHARS) {
    return fail(`This file is too long to send in one go (${content.body.length} characters, the limit is ${MAX_BODY_CHARS}). It is saved in this browser. Ask the programmer.`);
  }

  let base = relayBase(relay ? `${relay}/results` : '');
  try {
    const m = await timedFetch(fetchFn, `${MANIFEST_URL}?t=${now()}`, { cache: 'no-store' }, 10000);
    if (m.status >= 200 && m.status < 300) {
      const found = relayBase((JSON.parse(m.text) || {}).results_url);
      if (found) base = found;
    }
  } catch { /* keep the saved address */ }
  if (!base) return fail('Could not reach the results service. They are saved in this browser. Check the internet connection, then click Send Results again.');

  const headers = { 'Content-Type': 'application/json', 'X-Scourge-Client': `${CLIENT_HEADER} ${version}` };
  if (code) headers['X-Team-Code'] = code;
  const failed = (why) => fail(`Could not send the results. ${/[.!?]$/.test(why) ? why : `${why}.`} They are saved in this browser. Check the connection, then click Send Results again.`);
  let res;
  try {
    res = await timedFetch(fetchFn, `${base}/results`, { method: 'POST', headers, body: JSON.stringify(content), cache: 'no-store' }, timeoutMs);
  } catch (e) {
    return failed(e && e.name === 'AbortError' ? 'The relay took too long to answer.' : "Couldn't reach the relay.");
  }
  let reply = null;
  try { reply = JSON.parse(res.text); } catch { /* not JSON */ }
  const isObj = reply !== null && typeof reply === 'object' && !Array.isArray(reply);
  if (res.status !== 201) {
    if (isObj && typeof reply.error === 'string' && reply.error) return failed(reply.error.slice(0, 200));
    if (res.status === 413) return failed('The results file is too big for the relay.');
    return failed(`The relay returned HTTP ${res.status}.`);
  }
  if (!isObj || reply.ok !== true || !Array.isArray(reply.issues) || !reply.issues.every(Number.isInteger)) {
    return failed('The relay did not accept the results.');
  }
  const onMap = typeof reply.on_map === 'boolean' ? reply.on_map : null;
  const line = file.tally.sentLine(onMap);
  if (line) return { ok: true, text: line, kind: file.tally.recordings >= 1 && onMap !== false ? 'success' : 'info', issues: reply.issues, onMap };
  const labels = reply.issues.map((n) => `#${n}`).join(', ');
  return { ok: true, text: `Results sent to the programmer (issue ${labels}).`, kind: 'success', issues: reply.issues, onMap };
}

/* ---------- picking the cable ---------- */

const PRODUCTS = [BRAIN_PRODUCT_ID, CONTROLLER_PRODUCT_ID];
const productName = (pid) => (pid === CONTROLLER_PRODUCT_ID ? 'controller' : 'brain');

// Same rule as transport.js: Chrome on Android lists only Bluetooth ports, so it goes through WebUSB.
function isAndroid() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData) return navigator.userAgentData.platform === 'Android';
  return /Android/i.test(navigator.userAgent || '');
}
const hasSerial = () => typeof navigator !== 'undefined' && !!navigator.serial && !isAndroid();
const hasUsb = () => typeof navigator !== 'undefined' && !!navigator.usb;

function endpoint(iface, direction) {
  const e = iface.alternates[0].endpoints.find((x) => x.direction === direction);
  if (!e) throw new Error(TEXT.noUserPort);
  return e;
}

// The polyfill takes the first CDC pair, which on a brain is the system port. The user
// port is the second pair, so point the polyfill's (private) fields at that one.
export function usbUserPort(device, Port = PolyfillPort) {
  const port = new Port(device);
  if (device.productId !== CONTROLLER_PRODUCT_ID) {
    const ifaces = device.configurations[0].interfaces;
    const comm = ifaces.filter((i) => i.alternates[0].interfaceClass === 2);
    const data = ifaces.filter((i) => i.alternates[0].interfaceClass === 10);
    if (comm.length < 2 || data.length < 2) throw new Error(TEXT.noUserPort);
    port.controlInterface_ = comm[1];
    port.transferInterface_ = data[1];
    port.inEndpoint_ = endpoint(data[1], 'in');
    port.outEndpoint_ = endpoint(data[1], 'out');
  }
  port.__usbDevice = device;
  return port;
}

export async function requestRecordPort() {
  if (hasSerial()) {
    let port;
    try {
      port = await navigator.serial.requestPort({ filters: PRODUCTS.map((p) => ({ usbVendorId: VEX_VENDOR_ID, usbProductId: p })) });
    } catch (e) {
      throw new Error(e && e.name === 'NotFoundError' ? TEXT.nonePicked : TEXT.openFailed);
    }
    const info = port.getInfo ? port.getInfo() : {};
    return { via: 'serial', product: productName(info.usbProductId), port };
  }
  if (hasUsb()) {
    let device;
    try {
      device = await navigator.usb.requestDevice({ filters: PRODUCTS.map((p) => ({ vendorId: VEX_VENDOR_ID, productId: p })) });
    } catch (e) {
      throw new Error(e && e.name === 'NotFoundError' ? TEXT.nonePicked : TEXT.openFailed);
    }
    return { via: 'usb', product: productName(device.productId), port: usbUserPort(device) };
  }
  throw new Error(TEXT.unsupported);
}

// A brain over Web Serial shows two ports with the same IDs, so a granted pair can't be told apart: null then.
export async function knownRecordPort() {
  try {
    if (hasSerial()) {
      const ports = (await navigator.serial.getPorts()).filter((p) => {
        const i = p.getInfo ? p.getInfo() : {};
        return i.usbVendorId === VEX_VENDOR_ID && PRODUCTS.includes(i.usbProductId);
      });
      if (ports.length !== 1) return null;
      const pid = ports[0].getInfo().usbProductId;
      return pid === CONTROLLER_PRODUCT_ID ? { via: 'serial', product: 'controller', port: ports[0] } : null;
    }
    if (hasUsb()) {
      const d = (await navigator.usb.getDevices()).find((x) => x.vendorId === VEX_VENDOR_ID && PRODUCTS.includes(x.productId));
      return d ? { via: 'usb', product: productName(d.productId), port: usbUserPort(d) } : null;
    }
  } catch { return null; }
  return null;
}

async function openPort(port) {
  try {
    await port.open({ baudRate: 115200 });
  } catch (e) {
    const text = String((e && e.message) || '');
    if (e && e.name === 'InvalidStateError' && /already open/i.test(text)) return;
    if ((e && (e.name === 'NetworkError' || e.name === 'SecurityError')) || /claim|busy|in use|access denied/i.test(text)) throw new Error(TEXT.busy);
    throw new Error(TEXT.openFailed);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls the user FIFO through a controller (V5Device.user_fifo_read: ext 0x27 with
// channel 1 and up to 0x40 bytes; the first reply byte is not data). Runs until stopped().
export async function pollUserFifo(dev, { onBytes, stopped, idleMs = 20 }) {
  let misses = 0;
  while (!stopped()) {
    let data;
    try {
      data = await dev.txrxExt(0x27, Uint8Array.of(1, 0x40), 0, { checkLength: false });
      misses = 0;
    } catch (e) {
      if (e instanceof V5Error && e.code === 'PORT_CLOSED') throw e;
      misses += 1;
      if (misses > 3) throw e;
      continue;
    }
    const bytes = data.slice(1);
    if (bytes.length) onBytes(bytes);
    else await sleep(idleMs);
  }
}

/* ---------- the recorder ---------- */

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function defaultStorage() {
  try { if (typeof localStorage !== 'undefined') return localStorage; } catch { /* blocked */ }
  return memoryStorage();
}

export class Recorder {
  constructor({ onLine = () => {}, onStatus = () => {}, onProgress = () => {}, storage = defaultStorage(), now = Date.now,
    timing = {} } = {}) {
    this.onLine = onLine;
    this.onStatus = onStatus;
    this.onProgress = onProgress;
    this.storage = storage;
    this.now = now;
    this.timing = { quietMs: 3000, radioWindowMs: 30000, retryMs: 1000, rowGapMs: 150, flushMs: 200, saveMs: 1000, ...timing };
    this.state = 'idle'; // 'idle' | 'recording' | 'stopping'
    this.file = null; // the file Send Results uses: { id, lines, tally }
    this.sentId = null;
    this.sentWithoutMapId = null;
    this.sending = false;
    this.live = null;
    this.timers = new Set();
    this.earlyStop = false; // Stop tapped while the page was still finding the port
  }

  get tally() { return this.live ? this.live.tally : (this.file ? this.file.tally : new ResultsTally()); }
  get canSend() { return canSendFile(this.file, this.sentId) && this.state === 'idle' && !this.sending; }
  get csv() { return this.file ? buildCsv(this.file.lines) : ''; }

  status(text, kind) { this.onStatus({ text, kind }); }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  /* storage: the sendable file, the send lock, and a recording in progress (in case the page closes) */

  save() {
    const row = {
      file: this.file ? { id: this.file.id, lines: this.file.lines } : null,
      sentId: this.sentId,
      sentWithoutMapId: this.sentWithoutMapId,
      live: this.live && this.live.lines.length ? { id: this.live.id, lines: this.live.lines } : null,
    };
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(row)); } catch { /* full or blocked: it stays in memory */ }
  }

  load() {
    let row = null;
    try { row = JSON.parse(this.storage.getItem(STORAGE_KEY) || 'null'); } catch { row = null; }
    if (!row || typeof row !== 'object') return this.file;
    const read = (f) => (f && typeof f.id === 'string' && Array.isArray(f.lines) && f.lines.length
      ? makeFile(f.id, f.lines.filter((l) => typeof l === 'string' && l.startsWith('SCOURGE,'))) : null);
    this.file = read(row.file);
    this.sentId = typeof row.sentId === 'string' ? row.sentId : null;
    this.sentWithoutMapId = typeof row.sentWithoutMapId === 'string' ? row.sentWithoutMapId : null;
    // The page closed during a recording: what arrived counts as a finished file.
    const unfinished = read(row.live);
    if (unfinished) { this.file = sendable(this.file, unfinished); this.save(); }
    if (this.file) this.onProgress(this.file.tally);
    return this.file;
  }

  /* recording */

  // Records from a link (requestRecordPort or knownRecordPort) until stop(), a drop, or a whole
  // autopath recording. Resolves with { kind: 'stopped' | 'error', file, error }.
  async start(link) {
    if (this.state !== 'idle') return null;
    this.state = 'recording';
    // A Stop tapped before start() still counts: it ends the recording as soon as the port opens.
    this.stopRequested = this.earlyStop;
    this.earlyStop = false;
    this.live = { id: fileId(new Date(this.now())), lines: [], tally: new ResultsTally() };
    this.baseText = TEXT.neutral;
    this.lineText = null;
    this.waiting = false;
    this.heard = false;
    this.lastReport = -Infinity;
    this.flushPending = false;
    this.status(TEXT.neutral, 'working');
    this.onProgress(this.live.tally);

    let error = null; // a message, or '' when the reason is unknown
    try {
      if (!link || !link.port) throw new Error(TEXT.nonePicked);
      await openPort(link.port);
      this.port = link.port;
      if (this.stopRequested) return this.finish(null, true);
      if (link.product === 'controller') await this.readController(link.port);
      else await this.readStream(link.port, link.via === 'serial');
    } catch (e) {
      if (!this.stopRequested) error = (e && e.message) || '';
    }
    return this.finish(error, false);
  }

  stop() {
    if (this.state === 'idle') { this.earlyStop = true; return; }
    if (this.state !== 'recording') return;
    this.state = 'stopping';
    this.stopRequested = true;
    this.status(TEXT.stopping, 'working');
    if (this.cancelRead) this.cancelRead();
  }

  // The page calls this when a recording it was setting up never reached start().
  clearEarlyStop() { this.earlyStop = false; }

  async readStream(port, hintIfQuiet) {
    const reader = port.readable.getReader();
    this.cancelRead = () => { reader.cancel().catch(() => {}); };
    // 'pRa' makes the PROS kernel answer "I'm alive!" on serr, so the stream starts with a whole
    // packet. Silence on a computer usually means the System port was picked.
    if (port.writable) {
      try {
        const w = port.writable.getWriter();
        await w.write(Uint8Array.from([0x70, 0x52, 0x61]));
        w.releaseLock();
      } catch { /* listening still works */ }
    }
    if (hintIfQuiet) {
      this.later(() => { if (!this.heard && this.state === 'recording') this.status(TEXT.quiet, 'working'); }, this.timing.quietMs);
    }
    const decoder = new UserStreamDecoder();
    const text = new TextLines();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) this.feed(decoder, text, value);
      }
    } finally {
      for (const { stream, line } of text.flush()) this.takeLine(line, stream);
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    if (!this.stopRequested) throw new Error(TEXT.dropped);
  }

  async readController(port) {
    const conn = new SerialConnection(port);
    this.cancelRead = () => {};
    const decoder = new UserStreamDecoder();
    const text = new TextLines();
    const started = this.now();
    try {
      const dev = new V5Device(conn);
      for (;;) {
        try {
          await withDownloadChannel(dev, async () => {
            if (this.waiting) { this.waiting = false; this.status(this.baseText, 'working'); }
            await pollUserFifo(dev, { onBytes: (b) => this.feed(decoder, text, b), stopped: () => this.stopRequested });
          });
          return;
        } catch (e) {
          // The controller's radio may not be linked yet, so that is tried again for a while.
          const radio = e instanceof V5Error && (e.code === 'CONTROLLER_NOT_LINKED' || e.code === 'CONTROLLER_CHANNEL');
          if (!radio || this.stopRequested) throw e;
          if (this.now() - started >= this.timing.radioWindowMs) throw new Error(TEXT.radioDown);
          if (!this.waiting) { this.waiting = true; this.status(TEXT.waiting, 'working'); this.onLine(`[recording] ${TEXT.waiting}`, ''); }
          await sleep(this.timing.retryMs);
          if (this.stopRequested) return;
        }
      }
    } finally {
      for (const { stream, line } of text.flush()) this.takeLine(line, stream);
      await conn.close();
    }
  }

  feed(decoder, text, bytes) {
    if (!this.heard) {
      this.heard = true;
      if (this.state === 'recording' && !this.lineText) this.status(this.baseText, 'working');
    }
    for (const { stream, data } of decoder.push(bytes)) {
      // pros terminal shows only stdout and stderr; kdbg and jinx are other tools' streams.
      if (stream !== 'sout' && stream !== 'serr' && stream !== '') continue;
      for (const line of text.push(stream, data)) this.takeLine(line, stream);
    }
  }

  takeLine(line, stream) {
    this.onLine(line, stream);
    if (!this.live) return;
    const csv = scourgeLine(line);
    if (!csv) return;
    const fields = csv.split(',');
    this.live.lines.push(csv);
    const changed = this.live.tally.add(fields);
    if (!this.saveTimer) this.saveTimer = this.later(() => { this.saveTimer = null; if (this.live) this.save(); }, this.timing.saveMs);
    // Rows arrive many a second: only every 20th, or one after a pause, reaches the screen.
    const isRow = fields.length >= 2 && ROW_TAGS.has(fields[1]);
    const skip = isRow && this.live.tally.rows % 20 !== 0 && this.now() - this.lastReport < this.timing.rowGapMs;
    if (skip && !this.flushPending) {
      this.flushPending = true;
      this.later(() => { this.flushPending = false; this.report(); }, this.timing.flushMs);
    }
    if (changed && !skip) this.report();
  }

  // Counts and the status line while recording (recordingProgress in AppModel.swift).
  report() {
    if (!this.live || this.state === 'idle') return;
    this.lastReport = this.now();
    const t = this.live.tally;
    this.onProgress(t.copy());
    if (this.state !== 'recording') return;
    const base = !t.hasAutopath && (t.values > 0 || t.tests.size > 0) ? TEXT.tester : TEXT.neutral;
    const baseChanged = base !== this.baseText;
    this.baseText = base;
    const line = t.statusLine;
    if (line === this.lineText && !(line === null && baseChanged)) return;
    const before = this.lineText;
    this.lineText = line;
    if (t.open && line) {
      this.status(line, 'working');
    } else if (line) {
      const full = t.last === 'full';
      this.status(line, full ? 'success' : 'error');
      // A whole recording ends it, so Send Results works straight away.
      if (full) this.stop();
    } else if (before !== null || baseChanged) {
      this.status(this.baseText, 'working');
    }
  }

  async finish(error, stoppedEarly) {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.saveTimer = null;
    this.cancelRead = null;
    if (this.port) { await closeBrain(this.port); this.port = null; }
    const live = this.live;
    this.live = null;
    this.state = 'idle';
    if (stoppedEarly) {
      this.save();
      this.status(TEXT.stoppedEarly, 'info');
      return { kind: 'stopped', file: this.file, error: null };
    }
    const fresh = live && live.lines.length ? makeFile(live.id, live.lines) : null;
    this.file = sendable(this.file, fresh);
    const keptEarlier = !!this.file && (!fresh || this.file.id !== fresh.id);
    const shown = keptEarlier ? this.file.tally : (fresh ? fresh.tally : new ResultsTally());
    this.save();
    this.onProgress(shown);
    const note = keptEarlier ? ` Send Results will use the earlier file, ${this.file.id}.` : '';
    if (error !== null) {
      this.status(`${error ? `Recording stopped: ${error}` : TEXT.unexpected}${note}`, 'error');
      return { kind: 'error', file: this.file, error };
    }
    const t = fresh ? fresh.tally : null;
    if (!t) this.status(TEXT.nothing + note, 'info');
    else if (t.statusLine) this.status(t.statusLine + note, t.last === 'full' ? 'success' : 'error');
    else if (!t.usable) this.status(TEXT.cutOff + note, 'error');
    else this.status(TEXT.saved, 'success');
    return { kind: 'stopped', file: this.file, error: null };
  }

  /* sending */

  async send({ version, testerBuild, code = '', fetchFn, relay = '', now } = {}) {
    if (this.sending) return null;
    if (this.state !== 'idle') { this.status(TEXT.stopFirst, 'error'); return null; }
    if (!this.file || !this.file.lines.length) { this.status(TEXT.noResults, 'error'); return null; }
    if (!canSendFile(this.file, this.sentId)) { this.status(TEXT.alreadySent, 'info'); return null; }
    this.sending = true;
    this.status(TEXT.sending, 'working');
    const file = this.file;
    let result;
    try {
      result = await sendResults({ file, version, testerBuild, code, fetchFn, relay, now: now || this.now });
    } finally {
      this.sending = false;
    }
    if (result.ok) {
      this.sentId = file.id;
      this.sentWithoutMapId = file.tally.recordings >= 1 && result.onMap === false ? file.id : null;
      this.save();
    }
    this.status(result.text, result.kind);
    return result;
  }

  // Entering the team code after a send the map did not take lets that file go again.
  teamCodeSaved(code) {
    if (this.sentWithoutMapId && this.sentWithoutMapId === this.sentId && String(code || '').trim()) {
      this.sentId = null;
      this.sentWithoutMapId = null;
      this.save();
    }
  }
}

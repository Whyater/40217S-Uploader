// The Route Map download: where the relay is, the request, and what to show
// when it fails. No DOM and no globals, so Node can test it. The team code is
// only ever sent as a request header. It is never logged, put in a URL, or
// copied into a message.

export const MANIFEST_URL = 'https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/uploader.json';
export const CODE_MAX = 128;
const TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 20000; // the relay waits on GitHub, and a drawing can be a long upload on a phone
const CLIENT_HEADER = 'web-uploader';

// Same shape the laptop app accepts for results_url.
const URL_RE = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// results_url points at <relay>/results. The map lives beside it at <relay>/map.
export function relayBase(resultsUrl) {
  const u = String(resultsUrl == null ? '' : resultsUrl);
  if (!URL_RE.test(u)) return '';
  return u.replace(/\/results\/?$/, '').replace(/\/+$/, '');
}

export function mapUrl(base, tag) {
  return `${base}/map${tag ? `?build=${encodeURIComponent(tag)}` : ''}`;
}

// The code goes into a header, which only takes plain characters.
export function checkCode(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { ok: false, value, message: 'Enter the team code.' };
  if (value.length > CODE_MAX || !/^[\x20-\x7e]+$/.test(value)) {
    return { ok: false, value, message: "That code has characters it can't have. Check it and try again." };
  }
  return { ok: true, value, message: '' };
}

// Keep only what the page uses, whatever the relay (or a damaged cache) sent.
export function cleanResponse(body) {
  const b = isPlainObject(body) ? body : {};
  const stamp = b.recorded_updated;
  return {
    sim: isPlainObject(b.sim) ? b.sim : null,
    recorded: isPlainObject(b.recorded) ? b.recorded : null,
    recorded_updated: typeof stamp === 'string' || typeof stamp === 'number' ? stamp : null,
    sim_is_latest: b.sim_is_latest === true,
  };
}

// One request with a time limit that covers reading the body too.
async function request(fetchFn, url, init, timeoutMs, readErrors = false) {
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: ctl ? ctl.signal : undefined });
    const text = !readErrors && (res.status === 401 || !res.ok) ? '' : await res.text();
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

// Download the map and keep it. Never throws for network trouble.
//   store: loadCloud / saveCloud / clearCloud (mapstore.js)
//   tag:   the build downloaded on this device, or null
// Returns { status, reason, response, fetched }:
//   need-code      nothing stored yet
//   fresh          just downloaded
//   offline        download failed; response is the last good one
//   offline-empty  download failed and there is nothing stored
//   bad-code       the relay refused the code; the stored code and data were cleared
// reason is 'network' or 'server' when the download failed.
export async function syncCloud({ store, fetchFn, tag = null, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  const rec = await store.loadCloud();
  if (!rec || !rec.code) return { status: 'need-code', reason: null, response: null, fetched: null };

  const cached = rec.response ? cleanResponse(rec.response) : null;
  const failed = (reason) => (cached
    ? { status: 'offline', reason, response: cached, fetched: rec.fetched || null }
    : { status: 'offline-empty', reason, response: null, fetched: null });

  // The relay address comes from the same manifest the laptop app reads. If it
  // can't be fetched, the address from the last good download still works.
  let relay = rec.relay || '';
  try {
    const m = await request(fetchFn, `${MANIFEST_URL}?t=${now()}`, { cache: 'no-store' }, timeoutMs);
    if (m.ok) {
      const base = relayBase((JSON.parse(m.text) || {}).results_url);
      if (base) relay = base;
    }
  } catch { /* keep the stored address */ }
  if (!relay) return failed('network');

  let res;
  try {
    res = await request(fetchFn, mapUrl(relay, tag), { headers: { 'X-Team-Code': rec.code }, cache: 'no-store' }, timeoutMs);
  } catch {
    return failed('network');
  }
  if (res.status === 401) {
    try { await store.clearCloud(); } catch { /* the answer is still no */ }
    return { status: 'bad-code', reason: null, response: null, fetched: null };
  }
  if (!res.ok) return failed('server');

  let body;
  try { body = JSON.parse(res.text); } catch { return failed('server'); }
  if (!isPlainObject(body) || body.ok !== true) return failed('server');

  const response = cleanResponse(body);
  const fetched = now();
  // If the phone can't save it, the map still shows this download for now.
  try { await store.saveCloud({ code: rec.code, relay, tag: tag || null, fetched, response }); } catch { /* not saved */ }
  return { status: 'fresh', reason: null, response, fetched };
}

/* ---------- proposed auto plans ---------- */

const PLAN_SENT = 'Sent as a proposed plan. No robot code changed.';
const PLAN_NEW_CODE = 'The team code changed. Enter the new one, then send again.';
const PLAN_OFFLINE = "Couldn't reach the internet. Your drawing is still here, send it when you're online.";

// Only our own origin and our own frame count. Returns { id, plan } or null.
export function acceptPlanSend(event, frameWindow, origin) {
  if (!event || !frameWindow || event.origin !== origin || event.source !== frameWindow) return null;
  const d = event.data;
  if (!isPlainObject(d) || d.type !== 'scourge-plan-send' || !isPlainObject(d.plan)) return null;
  if (typeof d.id !== 'string' && !Number.isFinite(d.id)) return null;
  return { id: d.id, plan: d.plan };
}

// Send a drawn plan to the relay. Never throws for network trouble.
//   relay: the address saved with the last download, used if the manifest can't be read
// Returns { ok, message, unauthorized }. message is the text the page shows.
// On unauthorized the caller clears the saved code, the same as a 401 on the map.
export async function sendPlan({ plan, code, fetchFn, relay = '', now = Date.now, timeoutMs = SEND_TIMEOUT_MS }) {
  const answer = (ok, message, unauthorized = false) => ({ ok, message, unauthorized });
  const failed = (detail) => answer(false, `The plan didn't send (${detail}). Your drawing is still here.`);
  if (!code) return failed('enter the team code first');

  let body;
  try { body = JSON.stringify(plan); } catch { return failed("the drawing couldn't be read"); }

  let base = relay || '';
  let reached = false;
  try {
    const m = await request(fetchFn, `${MANIFEST_URL}?t=${now()}`, { cache: 'no-store' }, timeoutMs);
    reached = true;
    if (m.ok) {
      const found = relayBase((JSON.parse(m.text) || {}).results_url);
      if (found) base = found;
    }
  } catch { /* keep the saved address */ }
  if (!base) return reached ? failed('no relay address') : answer(false, PLAN_OFFLINE);

  let res;
  try {
    res = await request(fetchFn, `${base}/plans`, {
      method: 'POST',
      headers: { 'X-Team-Code': code, 'X-Scourge-Client': CLIENT_HEADER, 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
    }, timeoutMs, true);
  } catch {
    return answer(false, PLAN_OFFLINE);
  }
  if (res.status === 401) return answer(false, PLAN_NEW_CODE, true);

  let reply = null;
  try { reply = JSON.parse(res.text); } catch { /* a proxy page, or an empty answer */ }
  if (!res.ok) {
    const error = isPlainObject(reply) && typeof reply.error === 'string' ? reply.error.slice(0, 200) : '';
    return failed(error || `the relay answered ${res.status}`);
  }
  if (!isPlainObject(reply) || reply.ok !== true) return failed('the relay gave an unexpected answer');
  return answer(true, PLAN_SENT);
}

// Tell the page how a send went: its API if that can be reached, otherwise a message.
export function replyToPlanPage(frameWindow, origin, { id, ok, message }) {
  if (!frameWindow) return;
  try {
    const api = frameWindow.ScourgeMap;
    if (api && typeof api.planResult === 'function') { api.planResult({ id, ok, message }); return; }
  } catch { /* try the message below */ }
  try { frameWindow.postMessage({ type: 'scourge-plan-result', id, ok, message }, origin); } catch { /* the frame is gone */ }
}

/* ---------- words ---------- */

export function whenText(ms, locale) {
  if (!Number.isFinite(ms)) return 'an earlier visit';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

// "build-70-abc1234" -> "Build 70", the same short form the Upload tab uses.
export function buildLabel(tag) {
  const m = /^build-(\d+)(?=-|$)/.exec(tag || '');
  return m ? `Build ${m[1]}` : String(tag || '');
}

// What the tab says about a result: a one-line summary and any notices.
//   { detail, notices: [{ kind, text }] }
// 'cached' is the saved download shown while a new one is on its way.
export function describe(result, tag, locale) {
  const label = buildLabel(tag) || 'Latest build';
  const when = whenText(result.fetched, locale);
  switch (result.status) {
    case 'cached':
      return { detail: `${label}, saved ${when}`, notices: [] };
    case 'fresh':
      return { detail: `${label}, updated ${when}`, notices: [] };
    case 'offline': {
      const text = result.reason === 'server'
        ? `Couldn't reach the map service. Showing data from ${when}`
        : `Offline, showing data from ${when}`;
      return { detail: label, notices: [{ kind: 'warn', text }] };
    }
    case 'offline-empty': {
      const text = result.reason === 'server'
        ? "Couldn't reach the map service, and nothing is saved on this device yet."
        : 'Offline, and nothing is saved on this device yet.';
      return { detail: label, notices: [{ kind: 'warn', text }] };
    }
    case 'bad-code':
      return { detail: '', notices: [{ kind: 'bad', text: "That code didn't work. Check it and try again." }] };
    default:
      return { detail: '', notices: [] };
  }
}

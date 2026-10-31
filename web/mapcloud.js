// The Route Map download: where the relay is, the request, and what to show
// when it fails. No DOM and no globals, so Node can test it. The team code is
// only ever sent as a request header. It is never logged, put in a URL, or
// copied into a message.

export const MANIFEST_URL = 'https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/uploader.json';
export const CODE_MAX = 128;
const TIMEOUT_MS = 10000;

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
async function request(fetchFn, url, init, timeoutMs) {
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: ctl ? ctl.signal : undefined });
    const text = res.status === 401 || !res.ok ? '' : await res.text();
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

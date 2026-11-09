// Sharing the match auton with alliance partners: the rules both the partner page and the
// Map tab's share panel use. No DOM and no storage, so Node can test it. Passwords only ever
// travel in a request header, never in a URL.
import { MANIFEST_URL, relayBase } from './mapcloud.js';

export const PARTNER_URL = 'https://whyater.github.io/40217S-Uploader/partner.html';
export const CODE_MIN = 4;
export const CODE_MAX = 64;
export const NAME_MAX = 40;
// The match autonomous from either starting tile. The relay already sends only these; the
// page checks again so a mistake on one side can't show anything else.
export const MATCH_ROUTE_IDS = ['awp-L', 'awp-R'];
const TIMEOUT_MS = 10000;
const RELEASE_TAG = /^build-\d{1,7}-[0-9a-f]{7,40}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ---------- names and passwords ---------- */

// The relay compares passwords trimmed and in lower case, so the page shows them that way too.
export function normalCode(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

// "Archive" -> "archive", "Iron Lions" -> "ironlions": the suggested password for a new team.
export function defaultCode(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^\x21-\x7e]/g, '').slice(0, CODE_MAX);
}

export function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

export function checkName(raw) {
  const value = cleanName(raw);
  if (!value) return { ok: false, value, message: 'Enter the team name.' };
  if ([...value].length > NAME_MAX) return { ok: false, value, message: `Keep the name to ${NAME_MAX} characters.` };
  return { ok: true, value, message: '' };
}

// For both sides: what a partner types, and what the owner sets.
export function checkCode(raw, { forPartner = false } = {}) {
  const value = normalCode(raw);
  if (!value) return { ok: false, value, message: forPartner ? 'Enter the password 40217S gave your team.' : 'Enter a password.' };
  if (value.length > CODE_MAX || !/^[\x20-\x7e]+$/.test(value)) {
    return { ok: false, value, message: 'Use plain letters, numbers and symbols only.' };
  }
  if (value.length < CODE_MIN) {
    return { ok: false, value, message: forPartner ? "That password didn't work. Ask the 40217S team to confirm it." : `Use at least ${CODE_MIN} characters.` };
  }
  return { ok: true, value, message: '' };
}

// A team name, a team number, or one short word can be guessed by anyone at the event.
// The owner may still choose one; the panel only says so.
export function isGuessable(code, name) {
  const c = normalCode(code);
  if (!c) return false;
  return c === defaultCode(name) || c === normalCode(name) || /^\d{1,5}[a-z]{0,2}$/.test(c) || (/^[a-z]+$/.test(c) && c.length < 9);
}

/* ---------- what the owner copies ---------- */

export function shareMessage(code, link = PARTNER_URL) {
  return `40217S Scourge match auton\n${link}\nPassword: ${code}`;
}

// "build-70-abc1234" -> "Build 70". "latest" -> "Newest build".
export function buildText(build) {
  if (build === 'latest') return 'Newest build';
  const m = /^build-(\d+)(?=-|$)/.exec(build || '');
  return m ? `Build ${m[1]}` : String(build || '');
}

export const isReleaseTag = (tag) => typeof tag === 'string' && RELEASE_TAG.test(tag);

export function dateText(iso, locale) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(ms));
}

export function timeText(iso, locale) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/* ---------- where the relay is ---------- */

// For trying the page against a relay on this computer. Only a page served from this computer
// may point at one, and only at this computer, so a link can never send a password elsewhere.
export function localRelay(loc) {
  if (!loc || !/^(localhost|127\.0\.0\.1)$/.test(loc.hostname || '')) return '';
  let wanted = '';
  try { wanted = new URLSearchParams(loc.search || '').get('relay') || ''; } catch { return ''; }
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(wanted) ? wanted : '';
}

async function request(fetchFn, url, init, timeoutMs) {
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// The relay address from the same manifest the uploaders read, or the saved one if that can't be read.
export async function findRelay({ fetchFn, saved = '', now = Date.now, timeoutMs = TIMEOUT_MS }) {
  try {
    const m = await request(fetchFn, `${MANIFEST_URL}?t=${now()}`, {}, timeoutMs);
    if (m.ok) {
      const base = relayBase((JSON.parse(m.text) || {}).results_url);
      if (base) return base;
    }
  } catch { /* keep the saved address */ }
  // The saved address comes from this device's storage, so it gets the same https check as a fresh one.
  return relayBase(saved);
}

/* ---------- the partner's view ---------- */

function cleanRoute(r) {
  if (!isPlainObject(r) || !MATCH_ROUTE_IDS.includes(r.id) || !Array.isArray(r.samples)) return null;
  const samples = r.samples.filter((s) => isPlainObject(s) && isNum(s.t) && isNum(s.x) && isNum(s.y))
    .map((s) => ({ t: s.t, x: s.x, y: s.y, h: isNum(s.h) ? s.h : 0 }));
  if (samples.length < 2) return null;
  const events = (Array.isArray(r.events) ? r.events : []).filter((e) => isPlainObject(e) && isNum(e.t));
  return { id: r.id, name: 'AWP', side: r.id.slice(-1), total_ms: isNum(r.total_ms) ? r.total_ms : null, samples, events };
}

// Keep only what the page shows, whatever arrived.
export function cleanPartnerData(body) {
  const b = isPlainObject(body) ? body : {};
  const seen = new Set();
  const routes = (Array.isArray(b.routes) ? b.routes : []).map(cleanRoute).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
  return {
    team: typeof b.team === 'string' ? b.team.slice(0, NAME_MAX) : '',
    tag: isReleaseTag(b.tag) ? b.tag : null,
    build: Number.isInteger(b.build) && b.build >= 0 ? b.build : null,
    generated: typeof b.generated === 'string' && Number.isFinite(Date.parse(b.generated)) ? b.generated : null,
    routes,
  };
}

// What the visualizer's load() takes: the prediction and nothing else.
export function partnerInput(data) {
  return {
    simulated: { schema: 1, tag: data.tag || '', build: data.build, generated: data.generated || '', routes: data.routes },
    mapData: null,
    csvTexts: [],
  };
}

// Ask the relay for the route. Never throws for network trouble.
// status: ok | wrong (401) | busy (429) | server | network
export async function fetchPartnerMap({ base, code, fetchFn, timeoutMs = TIMEOUT_MS }) {
  if (!base) return { status: 'network', data: null };
  let res;
  try {
    res = await request(fetchFn, `${base}/partner/map`, { headers: { 'X-Partner-Code': code } }, timeoutMs);
  } catch {
    return { status: 'network', data: null };
  }
  if (res.status === 401) return { status: 'wrong', data: null };
  if (res.status === 429) return { status: 'busy', data: null };
  let body = null;
  try { body = JSON.parse(res.text); } catch { /* a proxy page or an empty answer */ }
  if (!res.ok || !isPlainObject(body) || body.ok !== true) return { status: 'server', data: null };
  return { status: 'ok', data: cleanPartnerData(body) };
}

// What the page says about an answer. hadAccess: this device got in with the saved password before.
// cachedAt: when the copy still on screen was fetched, or null. cachedEmpty: that copy had no route.
// Returns { screen, kind, text }:
//   screen: lock | route | none   (none: signed in, but nothing is shared yet)
export function describePartner(result, { hadAccess = false, cachedAt = null, cachedEmpty = false, locale } = {}) {
  // When the relay can't answer, the saved copy stays: its route, or its "nothing yet".
  const kept = !cachedAt ? 'lock' : cachedEmpty ? 'none' : 'route';
  const at = cachedAt ? timeText(cachedAt, locale) : '';
  // Some locales end the time with "p.m.", which already closes the sentence.
  const saved = at ? ` Showing the copy from ${at}${at.endsWith('.') ? '' : '.'}` : '';
  switch (result.status) {
    case 'ok':
      return result.data.routes.length
        ? { screen: 'route', kind: '', text: '' }
        : { screen: 'none', kind: '', text: '' };
    case 'wrong':
      return hadAccess
        ? { screen: 'lock', kind: 'bad', text: '40217S has stopped sharing this route with this password. Ask them for a new one.' }
        : { screen: 'lock', kind: 'bad', text: "That password didn't work. Ask the 40217S team to confirm it." };
    case 'busy':
      return { screen: kept, kind: 'warn', text: `Too many tries. Wait a minute, then try again.${saved}` };
    case 'server':
      return { screen: kept, kind: 'warn', text: `Couldn't load the route. Try again in a minute.${saved}` };
    default:
      return { screen: kept, kind: 'warn', text: `Couldn't load the route. Check your connection and try again.${saved}` };
  }
}

/* ---------- the owner's list ---------- */

export function cleanTeams(list) {
  return (Array.isArray(list) ? list : []).filter((t) => isPlainObject(t) && typeof t.name === 'string' && typeof t.code === 'string')
    .map((t) => ({ name: t.name, code: t.code, build: typeof t.build === 'string' ? t.build : 'latest', added: typeof t.added === 'string' ? t.added : '' }));
}

// One call to /partners with the team code. Never throws for network trouble.
//   method GET (list), POST (add or update, body { name, code, build }), DELETE (name)
// Returns { ok, status, teams, message, unauthorized }.
export async function partnersCall({ base, teamCode, method = 'GET', body = null, name = '', fetchFn, timeoutMs = TIMEOUT_MS }) {
  const fail = (message, extra = {}) => ({ ok: false, status: 0, teams: null, message, unauthorized: false, ...extra });
  if (!teamCode) return fail('Enter the team code first.');
  if (!base) return fail("Couldn't reach the route service. Check the connection and try again.");
  const headers = { 'X-Team-Code': teamCode };
  if (body) headers['Content-Type'] = 'application/json';
  const url = `${base}/partners${method === 'DELETE' ? `?name=${encodeURIComponent(name)}` : ''}`;
  let res;
  try {
    res = await request(fetchFn, url, { method, headers, body: body ? JSON.stringify(body) : undefined }, timeoutMs);
  } catch {
    return fail("Couldn't reach the route service. Check the connection and try again.");
  }
  if (res.status === 401) return fail('The team code changed. Enter the new one, then try again.', { status: 401, unauthorized: true });
  let reply = null;
  try { reply = JSON.parse(res.text); } catch { /* not JSON */ }
  if (res.status === 429) return fail('Too many changes in a minute. Wait a moment, then try again.', { status: 429 });
  if (!res.ok || !isPlainObject(reply) || reply.ok !== true) {
    const error = isPlainObject(reply) && typeof reply.error === 'string' ? reply.error.slice(0, 160) : '';
    return fail(error ? sentence(error) : `The route service answered ${res.status}.`, { status: res.status });
  }
  return { ok: true, status: res.status, teams: cleanTeams(reply.teams), message: '', unauthorized: false };
}

// The relay's errors are short lower-case phrases; the panel shows them as sentences.
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.');

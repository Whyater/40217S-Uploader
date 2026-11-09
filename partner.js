// The alliance partner page: a password, then our match auton prediction in the route map.
// It loads none of the uploader (no serial, no releases, no team code). The password and the
// last route it opened are kept on this device, so if the venue connection drops while the page
// is open, a Refresh keeps showing that route. There is no service worker here, so the page
// itself can't open with no connection. Sign Out removes both.
import { acceptHeight } from './mapdata.js';
import { checkCode, describePartner, fetchPartnerMap, findRelay, localRelay, partnerInput, timeText } from './partnerdata.js';

const KEY = 'scourge-partner';
const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'), bar: $('bar'), barDetail: $('bar-detail'), signOut: $('sign-out'),
  lock: $('lock'), form: $('lock-form'), code: $('code'), go: $('go'), goLabel: $('go-label'), hint: $('lock-hint'),
  info: $('info'), infoTitle: $('info-title'), infoDetail: $('info-detail'), refresh: $('refresh'), msgs: $('msgs'),
  none: $('none'), noneRefresh: $('none-refresh'), noneMsgs: $('none-msgs'),
  card: $('card'), frame: $('frame'),
};
const S = { code: '', relay: '', data: null, fetched: null, busy: false, frameStarted: false, frameReady: false, shown: false };
const fetchFn = (u, init) => fetch(u, init);

/* ---------- this device's copy ---------- */

function loadSaved() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (r && typeof r.code === 'string' && checkCode(r.code).ok) {
      S.code = r.code;
      S.relay = typeof r.relay === 'string' ? r.relay : '';
      S.data = r.data && Array.isArray(r.data.routes) ? r.data : null;
      S.fetched = Number.isFinite(r.fetched) ? r.fetched : null;
    }
  } catch { /* nothing saved, or storage is blocked */ }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ code: S.code, relay: S.relay, data: S.data, fetched: S.fetched })); } catch { /* not kept, still shown */ }
}
function forget() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to remove */ }
  S.code = ''; S.data = null; S.fetched = null;
}

/* ---------- screens ---------- */

const ICON = { good: 'i-check', bad: 'i-warn', warn: 'i-warn' };
function showMessages(target, items) {
  target.textContent = '';
  for (const { kind, text } of items) {
    const li = document.createElement('li');
    li.className = 'line';
    li.dataset.kind = kind;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + ICON[kind]);
    svg.appendChild(use);
    const span = document.createElement('span');
    span.textContent = text;
    li.append(svg, span);
    target.appendChild(li);
  }
}

function sidesText(routes) {
  const ids = routes.map((r) => r.id);
  if (ids.includes('awp-L') && ids.includes('awp-R')) return 'Left and right starts';
  return ids.includes('awp-R') ? 'Right start only' : 'Left start only';
}

function setBusy(on) {
  S.busy = on;
  el.go.disabled = on;
  el.go.dataset.working = on ? 'true' : 'false';
  el.goLabel.textContent = on ? 'Opening…' : 'View Route';
  el.refresh.disabled = on;
  el.refresh.textContent = on ? 'Refreshing…' : 'Refresh';
  el.noneRefresh.disabled = on;
}

// screen: lock | route | none. notice: { kind, text } or null.
function show(screen, notice = null) {
  el.page.dataset.screen = screen;
  const inside = screen !== 'lock';
  el.bar.hidden = !inside;
  el.lock.hidden = inside;
  el.info.hidden = screen !== 'route';
  el.none.hidden = screen !== 'none';
  el.card.hidden = screen !== 'route' || !S.shown;
  const items = notice && notice.text ? [notice] : [];
  el.hint.hidden = !(screen === 'lock' && items.length);
  el.hint.textContent = screen === 'lock' && items.length ? notice.text : '';
  el.hint.dataset.kind = notice ? notice.kind : '';
  // A refused password marks the field until the next keystroke. A dropped connection is not the field's fault.
  if (screen === 'lock' && notice && notice.kind === 'bad') el.code.setAttribute('aria-invalid', 'true');
  else el.code.removeAttribute('aria-invalid');
  showMessages(el.msgs, screen === 'route' ? items : []);
  showMessages(el.noneMsgs, screen === 'none' ? items : []);
  if (inside && S.data) {
    // The card below already says "Match autonomous", so the bar only says who it is shared with.
    el.barDetail.textContent = S.data.team ? `Shared with ${S.data.team}` : 'Match autonomous';
    // Plain words first for a team that has never seen our builds; the build number is last, for asking us about it.
    el.infoTitle.textContent = 'Match autonomous';
    el.infoDetail.textContent = [
      S.data.generated ? `Updated ${timeText(S.data.generated)}` : '',
      S.data.routes.length ? sidesText(S.data.routes) : '',
      S.data.build !== null ? `Build ${S.data.build}` : '',
    ].filter(Boolean).join(' · ');
  }
  if (screen === 'route') startFrame();
}

/* ---------- the map ---------- */

function startFrame() {
  if (S.frameStarted) { push(); return; }
  S.frameStarted = true;
  el.frame.src = 'map.html?embed=1&partner=1';
}

function push() {
  if (!S.frameReady) return;
  const api = el.frame.contentWindow && el.frame.contentWindow.ScourgeMap;
  // An older copy of the map without partner mode would offer tools a partner has no use for, so it gets nothing.
  if (!api || api.mode !== 'partner' || typeof api.load !== 'function') {
    show('route', { kind: 'warn', text: "The map didn't load properly. Reload the page to try again." });
    return;
  }
  api.load(S.data ? partnerInput(S.data) : { simulated: null });
  if (S.data && !S.shown) { S.shown = true; el.card.hidden = el.page.dataset.screen !== 'route'; }
}

el.frame.addEventListener('load', () => { S.frameReady = true; push(); });

// The map reports its height so the phone scrolls one page, not a box in a page.
let appliedHeight = 0;
window.addEventListener('message', (e) => {
  const h = acceptHeight(e, el.frame.contentWindow, location.origin);
  if (h === null || Math.abs(h - appliedHeight) < 2) return;
  appliedHeight = h;
  el.frame.style.height = h + 'px';
});

/* ---------- asking the relay ---------- */

async function relay() {
  const local = localRelay(location);
  if (local) return local;
  const base = await findRelay({ fetchFn, saved: S.relay });
  if (base) S.relay = base;
  return base;
}

// hadAccess: the password is the saved one that worked before, so a refusal means access was removed.
async function open(code, { hadAccess = false } = {}) {
  if (S.busy) return;
  setBusy(true);
  let result;
  try {
    result = await fetchPartnerMap({ base: await relay(), code, fetchFn });
  } finally {
    setBusy(false);
  }
  const keep = hadAccess && S.data ? S.fetched : null;
  const said = describePartner(result, { hadAccess, cachedAt: keep, cachedEmpty: !!(S.data && !S.data.routes.length) });
  if (result.status === 'ok') {
    S.code = code; S.data = result.data; S.fetched = Date.now();
    save();
  } else if (result.status === 'wrong') {
    forget();
    if (S.frameReady) push(); // nothing of the old route stays in the page
    S.shown = false;
  }
  const screen = said.screen;
  show(screen, said.text ? { kind: said.kind, text: said.text } : null);
  if (screen === 'lock') { el.code.focus(); el.code.select(); }
}

el.code.addEventListener('input', () => el.code.removeAttribute('aria-invalid'));
el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const check = checkCode(el.code.value, { forPartner: true });
  if (!check.ok) { show('lock', { kind: 'bad', text: check.message }); el.code.focus(); return; }
  open(check.value);
});
el.refresh.addEventListener('click', () => { if (S.code) open(S.code, { hadAccess: true }); });
el.noneRefresh.addEventListener('click', () => { if (S.code) open(S.code, { hadAccess: true }); });
el.signOut.addEventListener('click', () => {
  forget();
  if (S.frameReady) push();
  S.shown = false;
  el.code.value = '';
  show('lock');
  el.code.focus();
});

/* ---------- start ---------- */

loadSaved();
if (S.code && S.data) {
  // The saved copy shows at once; the relay is asked for a newer one behind it.
  show(S.data.routes.length ? 'route' : 'none');
  open(S.code, { hadAccess: true });
} else if (S.code) {
  el.code.value = S.code;
  show('lock');
  open(S.code, { hadAccess: true });
} else {
  show('lock');
}

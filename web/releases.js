// Release data for the web uploader: the builds stored on this device, which
// one is picked, what is published, and downloads that are verified before
// they replace anything.

import { MANIFEST_URL, relayBase } from './mapcloud.js';

export const MODES = [
  { id: 'competition', label: 'Competition', slot: 1, name: 'Scourge', hot: 'hot.package.bin' },
  { id: 'auton', label: 'Auton Test', slot: 2, name: 'Scourge Auton Test', hot: 'auton-test-hot.package.bin' },
  { id: 'drive', label: 'Drive Test', slot: 3, name: 'Scourge Drive Test', hot: 'drive-test-hot.package.bin' },
  { id: 'cascade', label: 'Cascade Only', slot: 4, name: 'Scourge Cascade', hot: 'cascade-hot.package.bin' },
];

// Older releases shipped a real Auto Pathing program in slot 4.
export const LEGACY_SLOT4 = { id: 'autopath', label: 'Auto Pathing', slot: 4, name: 'Scourge Auto Pathing', hot: 'autopath-hot.package.bin' };

const REQUIRED = ['hot.package.bin', 'cold.package.bin', 'project.pros'];

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,19}$/;

export function validateName(s) {
  const value = String(s == null ? '' : s).trim();
  if (value.length === 0) return { ok: false, value, message: 'Enter a program name.' };
  if (value.length > 20) return { ok: false, value, message: 'Use 20 characters or fewer.' };
  if (!NAME_RE.test(value)) {
    return { ok: false, value, message: 'Start with a letter or number. Use only letters, numbers, spaces, dots, dashes, and underscores.' };
  }
  return { ok: true, value, message: '' };
}

/* ---------- slot 4 and the slot list ---------- */

function listedFiles(build) {
  if (!build) return [];
  const sha = build.release && build.release.sha256;
  if (sha && typeof sha === 'object' && Object.keys(sha).length) return Object.keys(sha);
  return Object.keys(build.files || {});
}

// Build 437 put Cascade Only in slot 4 but still shipped it as autopath-hot.package.bin.
const CASCADE_IN_AUTOPATH_FROM = 437;

// Cascade Only if the release lists it, else the autopath file (Cascade Only
// from Build 437 on, Auto Pathing before), else the build has no slot 4 (the
// Cascade Only entry, marked absent).
export function slot4Mode(build) {
  const names = listedFiles(build);
  if (names.includes(MODES[3].hot)) return MODES[3];
  if (names.includes(LEGACY_SLOT4.hot)) {
    const n = buildNumber(build && build.release && build.release.tag);
    return n != null && n >= CASCADE_IN_AUTOPATH_FROM ? { ...MODES[3], hot: LEGACY_SLOT4.hot } : LEGACY_SLOT4;
  }
  return MODES[3];
}

export function modeById(build, modeId) {
  if (modeId === LEGACY_SLOT4.id) return LEGACY_SLOT4;
  if (modeId === MODES[3].id) {
    const m = slot4Mode(build);
    return m.id === modeId ? m : MODES[3];
  }
  return MODES.find((m) => m.id === modeId) || null;
}

export function modeAvailable(build, modeId) {
  if (!build || !build.files) return false;
  const mode = modeById(build, modeId);
  if (!mode) return false;
  return !!build.files[mode.hot] && !!build.files['cold.package.bin'] && !!build.files['project.pros'];
}

// The four slots a build would fill, in slot order. present: false means the
// build has no program for that slot.
export function slotModes(build) {
  const modes = [MODES[0], MODES[1], MODES[2], slot4Mode(build)];
  return modes.map((m) => ({ ...m, present: !!build && modeAvailable(build, m.id) }));
}

/* ---------- build names and catalog (pure) ---------- */

export function buildNumber(tag) {
  const m = /^build-(\d+)(?=-|$)/.exec(String(tag || ''));
  return m ? Number(m[1]) : null;
}

export function shortTag(tag) {
  const n = buildNumber(tag);
  return n == null ? String(tag || '') : `Build ${n}`;
}

const byNumberDesc = (a, b) => (buildNumber(b.tag) ?? -1) - (buildNumber(a.tag) ?? -1);

export function validateKeepName(s) {
  const raw = String(s == null ? '' : s);
  if (/[\r\n]/.test(raw)) return { ok: false, value: raw.trim(), message: 'Use a single line.' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, value, message: 'Enter a name.' };
  if (value.length > 40) return { ok: false, value, message: 'Use 40 characters or fewer.' };
  return { ok: true, value, message: '' };
}

// "Skills backup (Build 437)" for a kept build, "Build 437" otherwise.
export function buildTitle(tag, keptName) {
  const base = shortTag(tag);
  return keptName ? `${keptName} (${base})` : base;
}

// The 3 highest-numbered entries of full-builds.json except the newest build.
const FULL_SHOWN = 3;
// Cleanup keeps this many of the newest full builds.
const FULL_KEPT = 3;

/**
 * Groups for the build picker, in order: Newest, Full Builds, Kept, Also on This Device.
 * fullBuilds: [{tag, note}] or null when unknown. kept: {tag: name} or null.
 * A build shows once, in the first group that claims it.
 */
export function buildCatalog({ newestTag, fullBuilds, stored = [], kept = null }) {
  const keptMap = kept || {};
  const storedSet = new Set(stored);
  const fullKnown = Array.isArray(fullBuilds);
  const fullByTag = new Map((fullKnown ? fullBuilds : []).map((f) => [f.tag, f]));
  const shown = new Set();
  const make = (tag, label) => ({
    tag, label: label || '', stored: storedSet.has(tag), kept: Object.prototype.hasOwnProperty.call(keptMap, tag),
    title: buildTitle(tag, keptMap[tag]),
  });
  const groups = [];
  const add = (id, title, items) => { if (items.length) groups.push({ id, title, items }); items.forEach((i) => shown.add(i.tag)); };

  if (newestTag) {
    add('newest', 'Newest', [make(newestTag, fullKnown && !fullByTag.has(newestTag) ? 'test build' : '')]);
  }
  const fulls = (fullKnown ? [...fullBuilds] : []).filter((f) => f.tag !== newestTag).sort(byNumberDesc).slice(0, FULL_SHOWN);
  add('full', 'Full Builds', fulls.map((f) => make(f.tag, f.note || 'full build')));
  const keptTags = Object.keys(keptMap).filter((t) => !shown.has(t)).sort((a, b) => byNumberDesc({ tag: a }, { tag: b }));
  add('kept', 'Kept', keptTags.map((t) => make(t, '')));
  const others = [...storedSet].filter((t) => !shown.has(t)).sort((a, b) => byNumberDesc({ tag: a }, { tag: b }));
  add('device', 'Also on This Device', others.map((t) => make(t, '')));
  return groups;
}

// Every published build newest first, for the Older Build list.
export function olderList({ published, fullBuilds, stored = [], kept = null }) {
  const noteOf = new Map((Array.isArray(fullBuilds) ? fullBuilds : []).map((f) => [f.tag, f.note || 'full build']));
  const storedSet = new Set(stored);
  const keptMap = kept || {};
  return (published || []).map((p) => ({
    tag: p.tag, date: p.date || '', title: buildTitle(p.tag, keptMap[p.tag]),
    note: noteOf.get(p.tag) || '', stored: storedSet.has(p.tag),
  }));
}

/**
 * Tags to delete after a good download. Keeps the newest, the 3 newest full
 * builds, every kept build and the picked build. Deletes nothing while the
 * newest build, the full-builds list or the kept list is unknown.
 */
export function cleanupPlan({ stored, newestTag, fullBuilds, kept, picked }) {
  if (!newestTag || !Array.isArray(fullBuilds) || !kept || typeof kept !== 'object') return [];
  const keep = new Set([newestTag, ...Object.keys(kept)]);
  if (picked) keep.add(picked);
  [...fullBuilds].sort(byNumberDesc).slice(0, FULL_KEPT).forEach((f) => keep.add(f.tag));
  return stored.filter((t) => !keep.has(t));
}

/* ---------- multi-slot upload (pure sequencing) ---------- */

export function slotList(slots) {
  const s = slots.map(String);
  const word = s.length === 1 ? 'slot' : 'slots';
  if (s.length <= 1) return `${word} ${s.join('')}`;
  if (s.length === 2) return `${word} ${s[0]} and ${s[1]}`;
  return `${word} ${s.slice(0, -1).join(', ')}, and ${s[s.length - 1]}`;
}

export const progressText = (label, i, n, mode) =>
  `Uploading ${label}, ${i} of ${n}: ${mode.name} (slot ${mode.slot})\u2026 Keep the cable plugged in.`;

export const skippedText = (mode) =>
  `Slot ${mode.slot} skipped: this build has no ${mode.label} version, so slot ${mode.slot} still has its old program.`;

export function idleUploadText(build, label) {
  const slots = slotModes(build).filter((m) => m.present).map((m) => m.slot);
  return `Ready to upload ${label} to ${slotList(slots)}.`;
}

// PROS deletes every program that used the old library. A slot erased and then
// uploaded again later in the same run is fine; one that was not is lost.
export function lostText(lost) {
  const many = lost.length > 1;
  return `The new code replaced the PROS library, so the brain deleted ${many ? `the programs in slots ${lost.join(' and ')}` : `the program in slot ${lost[0]}`}. Upload ${many ? 'those modes' : 'that mode'} again if you need ${many ? 'them' : 'it'}.`;
}

export function erasedSlots(files) {
  return [...new Set((files || []).map((f) => Number((/^slot_(\d+)\.bin$/.exec(f) || [])[1])))].filter((n) => n);
}

/**
 * Upload every program the build has, in slot order, stopping at the first
 * failure. uploadOne(mode, { erased(files) }) does one slot.
 * Returns { done, failed, notUploaded, skipped, lost }.
 */
export async function runSlotUploads(build, uploadOne, { onStart } = {}) {
  const plan = slotModes(build);
  const todo = plan.filter((m) => m.present);
  const skipped = plan.filter((m) => !m.present);
  const done = [];
  let failed = null;
  const alive = new Set();
  const everErased = new Set();
  let current = null;
  const ctx = {
    erased(files) {
      for (const n of erasedSlots(files)) { everErased.add(n); alive.delete(n); }
    },
  };
  for (let i = 0; i < todo.length; i++) {
    const mode = todo[i];
    current = mode;
    if (onStart) onStart({ i: i + 1, n: todo.length, mode });
    try {
      await uploadOne(mode, ctx);
      done.push(mode.slot);
      alive.add(mode.slot);
    } catch (e) {
      failed = { slot: mode.slot, label: mode.label, message: (e && e.message) || 'The upload failed.', error: e };
      break;
    }
  }
  const notUploaded = todo.filter((m) => !done.includes(m.slot) && !(failed && failed.slot === m.slot)).map((m) => m.slot);
  const redo = new Set([...notUploaded, ...(failed ? [failed.slot] : [])]);
  const lost = [...everErased].filter((n) => !alive.has(n) && !redo.has(n)).sort((a, b) => a - b);
  return { done, failed, notUploaded, skipped, lost, current };
}

export function resultText(label, res) {
  const parts = [];
  if (res.failed) {
    parts.push(res.done.length ? `${label}: ${slotList(res.done)} finished.` : `${label}: no slots finished.`);
    parts.push(`Slot ${res.failed.slot} (${res.failed.label}) failed: ${res.failed.message}`);
    if (res.notUploaded.length) parts.push(`${slotList(res.notUploaded).replace(/^s/, 'S')} not uploaded.`);
    parts.push('Upload again to finish.');
  } else {
    parts.push(`Uploaded ${label} to ${slotList(res.done)}. Run ${res.done.length > 1 ? 'them' : 'it'} from the brain screen.`);
  }
  for (const m of res.skipped) parts.push(skippedText(m));
  if (res.lost.length) parts.push(lostText(res.lost));
  return parts.join(' ');
}

/* ---------- storage ---------- */

// One cache per build (named by tag) holds its files, and release.json is
// written last: a build with no release.json, or a missing listed file, is not
// a build. A download is verified in memory, stored, read back, and only then
// picked, so a crash at any earlier point leaves the previous build untouched.
const BUILD_PREFIX = 'scourge-bt-';
const META_CACHE = 'scourge-meta';
const CACHE_A = 'scourge-build-a';
const CACHE_B = 'scourge-build-b';
const POINTER_CACHE = 'scourge-build-pointer';
const POINTER_KEY = 'active';
const LEGACY_CACHE = 'scourge-build-v1';
const BASE = './build/';
const OWNER_REPO = 'Whyater/40217S-Uploader';
const FULL_BUILDS_URL = `https://raw.githubusercontent.com/${OWNER_REPO}/main/full-builds.json`;
const RELEASES_URL = `https://api.github.com/repos/${OWNER_REPO}/releases?per_page=100`;
const BUNDLE_INDEX = BASE + 'builds.json';
const FULL_TAG = /^build-\d{1,9}-[0-9a-f]{7}$/;
const RELAY_DOWN = "Older builds need the team's relay, which didn't answer. Full builds still work.";
const CAPTIVE_MESSAGE = "Couldn't read the release info. If you're on public Wi-Fi, open a web page first to sign in, then try again.";
const OFFLINE_DOWNLOAD = "Couldn't reach the download. Check your connection and try again.";

const cacheNameFor = (tag) => BUILD_PREFIX + encodeURIComponent(tag);

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

// undefined means nothing is stored. With strict, a storage error throws instead, so a list that
// couldn't be read is never mistaken for an empty one.
async function metaGet(key, strict = false) {
  try {
    if (!(await caches.has(META_CACHE))) return undefined;
    const res = await (await caches.open(META_CACHE)).match(key);
    return res ? await res.text() : undefined;
  } catch (e) {
    if (strict) throw e;
    return undefined;
  }
}

async function metaPut(key, text) {
  const cache = await caches.open(META_CACHE);
  await cache.put(key, new Response(text));
}

async function metaJson(key) {
  const t = await metaGet(key);
  if (t === undefined) return undefined;
  try { return JSON.parse(t); } catch (e) { return undefined; }
}

// A cache holds a usable build only if release.json and every file it lists are present.
async function readBuild(cacheName) {
  try {
    if (!(await caches.has(cacheName))) return null;
    const cache = await caches.open(cacheName);
    const metaRes = await cache.match('release.json');
    if (!metaRes) return null;
    const release = await metaRes.json();
    const names = Object.keys((release && release.sha256) || {});
    const files = {};
    for (const name of names) {
      const res = await cache.match(name);
      if (!res) return null;
      files[name] = new Uint8Array(await res.arrayBuffer());
    }
    for (const need of REQUIRED) if (!files[need]) return null;
    return { release, files };
  } catch (e) {
    return null;
  }
}

async function readTag(cacheName) {
  try {
    if (!(await caches.has(cacheName))) return null;
    const res = await (await caches.open(cacheName)).match('release.json');
    const tag = res ? ((await res.json()) || {}).tag : null;
    return typeof tag === 'string' && tag ? tag : null;
  } catch (e) {
    return null;
  }
}

// Tags of builds in the per-build caches (a tag counts only if its cache has a release.json).
async function storedInLibrary() {
  let names = [];
  try { names = await caches.keys(); } catch (e) { return []; }
  const tags = [];
  for (const n of names) {
    if (!n.startsWith(BUILD_PREFIX)) continue;
    let tag;
    try { tag = decodeURIComponent(n.slice(BUILD_PREFIX.length)); } catch (e) { continue; }
    if (await readTag(n)) tags.push(tag);
  }
  return tags;
}

async function readPointer() {
  try {
    if (!(await caches.has(POINTER_CACHE))) return null;
    const cache = await caches.open(POINTER_CACHE);
    const res = await cache.match(POINTER_KEY);
    const name = res ? (await res.text()).trim() : '';
    return name === CACHE_A || name === CACHE_B ? name : null;
  } catch (e) {
    return null;
  }
}

// The single-build layout used before per-build caches.
async function legacyOrder() {
  const active = await readPointer();
  return active ? [active, active === CACHE_A ? CACHE_B : CACHE_A, LEGACY_CACHE] : [LEGACY_CACHE];
}

async function legacyBuild() {
  for (const name of await legacyOrder()) {
    const build = await readBuild(name);
    if (build) return build;
  }
  return null;
}

// Moves the old single build into the library so nothing is lost, then drops the old caches.
async function migrateLegacy() {
  try {
    const b = await legacyBuild();
    if (b && typeof b.release.tag === 'string' && b.release.tag) {
      if (!(await readBuild(cacheNameFor(b.release.tag)))) {
        await writeBuild(b.release.tag, b.files, JSON.stringify(b.release));
      }
      if (!(await metaGet('picked'))) await metaPut('picked', b.release.tag);
    } else if (b) {
      return; // no tag to file it under; leave it readable where it is
    }
    for (const n of [CACHE_A, CACHE_B, POINTER_CACHE, LEGACY_CACHE]) await caches.delete(n);
  } catch (e) { /* the old copy stays readable */ }
}

async function writeBuild(tag, files, metaText) {
  const target = cacheNameFor(tag);
  await caches.delete(target);
  try {
    const temp = await caches.open(target);
    for (const name of Object.keys(files)) await temp.put(name, new Response(files[name]));
    // release.json last: it is what makes the cache count as a build.
    await temp.put('release.json', new Response(metaText, { headers: { 'content-type': 'application/json' } }));
    if (!(await readBuild(target))) throw new Error('incomplete');
  } catch (e) {
    await caches.delete(target).catch(() => {});
    throw new Error("Couldn't save the download. The phone may be out of storage.");
  }
}

export async function listStored() {
  const tags = await storedInLibrary();
  const legacy = await legacyBuild();
  const lt = legacy && legacy.release.tag;
  if (typeof lt === 'string' && lt && !tags.includes(lt)) tags.push(lt);
  return tags;
}

export async function loadBuildByTag(tag) {
  const b = await readBuild(cacheNameFor(tag));
  if (b) return b;
  const legacy = await legacyBuild();
  return legacy && legacy.release.tag === tag ? legacy : null;
}

export async function getPicked() {
  const t = await metaGet('picked');
  return t ? t.trim() : null;
}

export async function setPicked(tag) {
  await metaPut('picked', tag);
}

// The picked build, else the highest-numbered stored one, else the old single build.
async function activeTag() {
  const picked = await getPicked();
  if (picked && (await readTag(cacheNameFor(picked)))) return picked;
  const tags = (await storedInLibrary()).map((t) => ({ tag: t })).sort(byNumberDesc);
  return tags.length ? tags[0].tag : null;
}

// Just the tag of the live build, without reading its (large) files. The
// Route Map tab asks for it on every open.
export async function storedTag() {
  const t = await activeTag();
  if (t) return t;
  for (const name of await legacyOrder()) {
    const tag = await readTag(name);
    if (tag) return tag;
  }
  return null;
}

export async function loadBuild() {
  const t = await activeTag();
  if (t) {
    const b = await readBuild(cacheNameFor(t));
    if (b) return b;
  }
  return legacyBuild();
}

/* ---------- kept builds ---------- */

// null means the kept list could not be read, which blocks cleanup.
export async function getKept() {
  try {
    const text = await metaGet('kept', true);
    if (text === undefined) return {};
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

export const KEPT_RESET_TEXT = "The kept list couldn't be read, so it was started over. The old copy is saved as kept.bak.";
export const KEPT_UNREADABLE_TEXT = "Couldn't read the kept builds, so nothing was changed.";

// An unreadable kept list is only written over once a copy of it is saved as
// kept.bak, like the Mac's kept.json.bak.
export async function setKept(tag, name) {
  let kept = await getKept();
  if (!kept) {
    const old = await metaGet('kept');
    try {
      await metaPut('kept.bak', old === undefined ? '' : old);
      if ((await metaGet('kept.bak')) !== (old === undefined ? '' : old)) throw new Error('not saved');
    } catch (e) {
      throw new Error(KEPT_UNREADABLE_TEXT);
    }
    kept = {};
  }
  kept[tag] = name;
  await metaPut('kept', JSON.stringify(kept));
  return kept;
}

export async function removeKept(tag) {
  const kept = await getKept();
  if (!kept) throw new Error("Couldn't read the kept builds.");
  delete kept[tag];
  await metaPut('kept', JSON.stringify(kept));
  return kept;
}

/* ---------- published lists ---------- */

// Plain-language failure for GitHub requests.
function githubError(res, what) {
  if (res && (res.status === 429 || (res.status === 403 && res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining') === '0'))) {
    return new Error('GitHub is limiting requests right now. Wait a few minutes and try again.');
  }
  return new Error(`Couldn't load ${what} from GitHub (error ${res ? res.status : 'unknown'}). Try again.`);
}

// Same rules as the Mac: version 1, real build tags only, each tag once (the
// first wins), highest number first. An empty result counts as unreadable: the
// team never means to list no full builds, and taking it would let cleanup
// delete every one.
function parseFullBuilds(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || j.version !== 1 || !Array.isArray(j.builds)) throw new Error('bad shape');
  const seen = new Set();
  const builds = [];
  for (const b of j.builds) {
    if (!b || typeof b.tag !== 'string' || !FULL_TAG.test(b.tag) || seen.has(b.tag)) continue;
    seen.add(b.tag);
    builds.push({ tag: b.tag, note: typeof b.note === 'string' ? b.note.trim() : '' });
  }
  if (!builds.length) throw new Error('no builds');
  return builds.sort(byNumberDesc);
}

// { builds, stale } or { builds: null } when never fetched and offline.
export async function loadFullBuilds() {
  try {
    const res = await fetch(FULL_BUILDS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const builds = parseFullBuilds(text);
    try { await metaPut('full-builds', text); } catch (e) { /* offline copy is optional */ }
    return { builds, stale: false };
  } catch (e) {
    const cached = await metaGet('full-builds');
    if (cached) {
      try { return { builds: parseFullBuilds(cached), stale: true }; } catch (e2) { /* fall through */ }
    }
    return { builds: null, stale: false };
  }
}

export async function cachedFullBuilds() {
  const cached = await metaGet('full-builds');
  if (!cached) return null;
  try { return parseFullBuilds(cached); } catch (e) { return null; }
}

// Every published build, newest first, with asset ids. Throws a plain message.
export async function loadPublished() {
  let res;
  try {
    res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (e) {
    throw new Error("Couldn't reach GitHub. Check your connection and try again.");
  }
  if (!res.ok) throw githubError(res, 'the build list');
  let rows;
  try { rows = await res.json(); } catch (e) { throw new Error(CAPTIVE_MESSAGE); }
  if (!Array.isArray(rows)) throw new Error(CAPTIVE_MESSAGE);
  return rows
    // Only robot builds: the Mac uploader's own releases share this repo.
    .filter((r) => r && !r.draft && typeof r.tag_name === 'string' && /^build-\d{1,9}-[0-9a-f]{7}$/.test(r.tag_name))
    .map((r) => ({
      tag: r.tag_name,
      date: r.published_at || r.created_at || '',
      assets: Object.fromEntries((r.assets || []).filter((a) => a && a.name).map((a) => [a.name, a.id])),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/* ---------- checking and downloading ---------- */

// Offline or unreadable answers never throw: the result has offline: true, and
// `error` holds a plain message when the cause was something other than no
// connection (for example a captive portal returning a web page).
export async function checkLatest() {
  const have = ((await loadBuild()) || {}).release || null;
  let text;
  try {
    const res = await fetch(BASE + 'release.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    return { release: have, isNew: false, offline: true };
  }
  let release;
  try {
    release = JSON.parse(text);
  } catch (e) {
    return { release: have, isNew: false, offline: true, error: CAPTIVE_MESSAGE };
  }
  const stored = await listStored();
  return { release, isNew: !stored.includes(release.tag), offline: false };
}

// Verifies and stores one build. getMeta() returns release.json text,
// getFile(name) returns bytes; both throw plain errors.
async function downloadBuild({ expectTag, getMeta, getFile }, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const metaText = await getMeta();
  let release;
  try {
    release = JSON.parse(metaText);
  } catch (e) {
    throw new Error(CAPTIVE_MESSAGE);
  }
  if (!release || typeof release !== 'object') throw new Error(CAPTIVE_MESSAGE);
  const hashes = release.sha256 || {};
  const names = Object.keys(hashes);
  for (const need of REQUIRED) {
    if (!names.includes(need)) throw new Error('Download was damaged (' + need + ' is missing).');
  }
  if (typeof release.tag !== 'string' || !release.tag || (expectTag && release.tag !== expectTag)) {
    throw new Error('Download was damaged (release.json is for a different build).');
  }

  const files = {};
  let done = 0;
  for (const name of names) {
    const bytes = await getFile(name);
    const actual = await sha256(bytes);
    if (actual !== String(hashes[name]).toLowerCase()) {
      throw new Error('Download was damaged (' + name + ' failed its SHA-256 check).');
    }
    files[name] = bytes;
    done += 1;
    report({ file: name, done, total: names.length, fraction: done / names.length });
  }

  // Everything verified. Store it, check it reads back complete, then pick it
  // as the final write.
  await migrateLegacy();
  await writeBuild(release.tag, files, metaText);
  try {
    await setPicked(release.tag);
  } catch (e) {
    await caches.delete(cacheNameFor(release.tag)).catch(() => {});
    throw new Error("Couldn't save the download. The phone may be out of storage.");
  }

  // Ask the browser not to clear the builds when space runs low. Don't wait
  // for the answer: some browsers show a prompt and never settle until it's
  // answered, which would leave the download looking stuck.
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { /* ignore */ }
  return { release, files };
}

// The newest build, bundled with this site.
export function downloadLatest(onProgress) {
  return downloadBuild({
    getMeta: async () => {
      try {
        const res = await fetch(BASE + 'release.json', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
      } catch (e) {
        throw new Error(OFFLINE_DOWNLOAD);
      }
    },
    getFile: async (name) => {
      try {
        const res = await fetch(BASE + name, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        throw new Error("Couldn't finish the download (" + name + '). Check your connection and try again.');
      }
    },
  }, onProgress);
}

// The builds this site carries besides the newest, from build/builds.json
// (written by scripts/publish-web.sh). Empty when the site has none or the
// index can't be read.
export async function bundledTags() {
  try {
    const res = await fetch(BUNDLE_INDEX, { cache: 'no-store' });
    if (!res.ok) return [];
    const j = await res.json();
    if (!j || j.version !== 1 || !Array.isArray(j.builds)) return [];
    return j.builds.filter((t) => typeof t === 'string' && FULL_TAG.test(t));
  } catch (e) {
    return [];
  }
}

// Bytes from a fetch, or a plain error. A 404 means the file is not there.
async function fetchBytes(url, name, offlineText) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error(offlineText);
  }
  if (res.status === 404) throw new Error('Download was damaged (' + name + ' is missing from the release).');
  if (!res.ok) throw new Error(offlineText);
  return new Uint8Array(await res.arrayBuffer());
}

// One of the full builds bundled with this site, from build/<tag>/.
function downloadBundled(tag, onProgress) {
  const base = `${BASE}${encodeURIComponent(tag)}/`;
  const get = (name) => fetchBytes(base + name, name, "Couldn't finish the download (" + name + '). Check your connection and try again.');
  return downloadBuild({
    expectTag: tag,
    getMeta: async () => new TextDecoder().decode(await get('release.json')),
    getFile: get,
  }, onProgress);
}

// The relay's address, from the manifest the laptop app reads. Throws a plain message.
async function findRelay() {
  let res;
  try {
    res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
  } catch (e) {
    throw new Error(OFFLINE_DOWNLOAD);
  }
  let base = '';
  try { if (res.ok) base = relayBase((JSON.parse(await res.text()) || {}).results_url); } catch (e) { base = ''; }
  if (!base) throw new Error(RELAY_DOWN);
  return base;
}

// Any other published build, through the relay's /asset route: GitHub's
// release downloads send no CORS headers, so a page can't read them directly.
async function downloadViaRelay(tag, onProgress) {
  const relay = await findRelay();
  const url = (name) => `${relay}/asset?tag=${encodeURIComponent(tag)}&name=${encodeURIComponent(name)}`;
  return downloadBuild({
    expectTag: tag,
    // A relay without the /asset route answers without CORS, which reads as no answer.
    getMeta: async () => new TextDecoder().decode(await fetchBytes(url('release.json'), 'release.json', RELAY_DOWN)),
    getFile: (name) => fetchBytes(url(name), name, "Couldn't finish the download (" + name + '). Check your connection and try again.'),
  }, onProgress);
}

/**
 * Downloads, verifies and picks the build `tag`: the newest from build/, a
 * bundled full build from build/<tag>/, anything else through the relay.
 * onSource('newest' | 'bundled' | 'relay') says which, before it starts.
 */
export async function downloadByTag(tag, { newestTag = null, onProgress, onSource } = {}) {
  const say = typeof onSource === 'function' ? onSource : () => {};
  if (tag === newestTag) { say('newest'); return downloadLatest(onProgress); }
  if ((await bundledTags()).includes(tag)) { say('bundled'); return downloadBundled(tag, onProgress); }
  say('relay');
  return downloadViaRelay(tag, onProgress);
}

// Run only after a good download. Never deletes while a list is unknown.
export async function cleanupStored({ newestTag }) {
  try {
    const [stored, fullBuilds, kept, picked] = [await listStored(), await cachedFullBuilds(), await getKept(), await getPicked()];
    const doomed = cleanupPlan({ stored, newestTag, fullBuilds, kept, picked });
    for (const t of doomed) await caches.delete(cacheNameFor(t));
    return doomed;
  } catch (e) {
    return [];
  }
}

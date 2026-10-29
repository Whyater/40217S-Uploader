// Release data for the web uploader: which build is stored on this device,
// whether a newer one is published, and a download that is verified before it
// replaces anything.

export const MODES = [
  { id: 'competition', label: 'Competition', slot: 1, name: 'Scourge', hot: 'hot.package.bin' },
  { id: 'auton', label: 'Auton Test', slot: 2, name: 'Scourge Auton Test', hot: 'auton-test-hot.package.bin' },
  { id: 'drive', label: 'Drive Test', slot: 3, name: 'Scourge Drive Test', hot: 'drive-test-hot.package.bin' },
];

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

// Two build caches plus a pointer. A download goes into the inactive cache and
// is verified there; flipping the pointer is the single write that makes it
// live, so a crash at any earlier point leaves the previous build untouched.
const CACHE_A = 'scourge-build-a';
const CACHE_B = 'scourge-build-b';
const POINTER_CACHE = 'scourge-build-pointer';
const POINTER_KEY = 'active';
const LEGACY_CACHE = 'scourge-build-v1';
const BASE = './build/';
const REQUIRED = ['hot.package.bin', 'cold.package.bin', 'project.pros'];
const CAPTIVE_MESSAGE = "Couldn't read the release info. If you're on public Wi-Fi, open a web page first to sign in, then try again.";

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
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

async function writePointer(name) {
  const cache = await caches.open(POINTER_CACHE);
  await cache.put(POINTER_KEY, new Response(name));
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

function otherCache(name) {
  return name === CACHE_A ? CACHE_B : CACHE_A;
}

export async function loadBuild() {
  const active = await readPointer();
  // With a pointer: the active cache, then the other one. Without one (or if
  // both fail): the cache from before the two-cache layout.
  const order = active ? [active, otherCache(active), LEGACY_CACHE] : [LEGACY_CACHE];
  for (const name of order) {
    const build = await readBuild(name);
    if (build) return build;
  }
  return null;
}

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
  return { release, isNew: !have || have.tag !== release.tag, offline: false };
}

export async function downloadLatest(onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  let metaRes;
  try {
    metaRes = await fetch(BASE + 'release.json', { cache: 'no-store' });
    if (!metaRes.ok) throw new Error('HTTP ' + metaRes.status);
  } catch (e) {
    throw new Error("Couldn't reach the download. Check your connection and try again.");
  }
  const metaText = await metaRes.text();
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

  const files = {};
  let done = 0;
  for (const name of names) {
    let res;
    try {
      res = await fetch(BASE + name, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) {
      throw new Error("Couldn't finish the download (" + name + '). Check your connection and try again.');
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = await sha256(bytes);
    if (actual !== String(hashes[name]).toLowerCase()) {
      throw new Error('Download was damaged (' + name + ' failed its SHA-256 check).');
    }
    files[name] = bytes;
    done += 1;
    report({ file: name, done, total: names.length, fraction: done / names.length });
  }

  // Everything verified. Write into the inactive cache, check it reads back
  // complete, then flip the pointer as the single final write.
  const current = await readPointer();
  const target = current ? otherCache(current) : CACHE_A;
  await caches.delete(target);
  try {
    const temp = await caches.open(target);
    for (const name of names) await temp.put(name, new Response(files[name]));
    await temp.put('release.json', new Response(metaText, { headers: { 'content-type': 'application/json' } }));
    if (!(await readBuild(target))) throw new Error('incomplete');
    await writePointer(target);
  } catch (e) {
    await caches.delete(target).catch(() => {});
    throw new Error("Couldn't save the download. The phone may be out of storage.");
  }
  // The new build is live; the old copies are only clutter now.
  try {
    if (current) await caches.delete(current);
    await caches.delete(LEGACY_CACHE);
  } catch (e) { /* ignore */ }

  // Ask the browser not to clear the build when space runs low. Don't wait
  // for the answer: some browsers show a prompt and never settle until it's
  // answered, which would leave the download looking stuck.
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { /* ignore */ }
  return { release, files };
}

export function modeAvailable(build, modeId) {
  if (!build || !build.files) return false;
  const mode = MODES.find((m) => m.id === modeId);
  if (!mode) return false;
  return !!build.files[mode.hot] && !!build.files['cold.package.bin'] && !!build.files['project.pros'];
}

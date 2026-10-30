import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MODES, validateName, checkLatest, downloadLatest, loadBuild, modeAvailable } from '../releases.js';

// Minimal in-memory Cache Storage.
function makeCaches() {
  const stores = new Map();
  const keyOf = (k) => String(k);
  const make = (map) => ({
    async put(k, res) { map.set(keyOf(k), new Uint8Array(await res.arrayBuffer())); },
    async match(k) { const v = map.get(keyOf(k)); return v ? new Response(v) : undefined; },
    async delete(k) { return map.delete(keyOf(k)); },
    async keys() { return [...map.keys()]; },
  });
  return {
    stores,
    async open(name) { if (!stores.has(name)) stores.set(name, new Map()); return make(stores.get(name)); },
    async has(name) { return stores.has(name); },
    async delete(name) { return stores.delete(name); },
  };
}

const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const enc = (s) => new TextEncoder().encode(s);

function makeRelease(tag, files) {
  const sha256 = {};
  for (const [n, b] of Object.entries(files)) sha256[n] = sha(b);
  return { tag, title: tag, notes: '', built_at: '2026-10-28T00:00:00Z', sha256 };
}

// Serves ./build/<name> from a map. `tamper` swaps a file's bytes after the hash was computed.
function stubFetch(release, files, { offline = false } = {}) {
  globalThis.fetch = async (url) => {
    if (offline) throw new TypeError('Failed to fetch');
    const name = String(url).replace('./build/', '');
    if (name === 'release.json') return new Response(JSON.stringify(release));
    if (files[name]) return new Response(files[name]);
    return new Response('nope', { status: 404 });
  };
}

const baseFiles = (tag) => ({
  'hot.package.bin': enc('hot-' + tag),
  'cold.package.bin': enc('cold-' + tag),
  'project.pros': enc('pros-' + tag),
});

async function activeTag() {
  const b = await loadBuild();
  return b && b.release.tag;
}

// Writes a complete build straight into a named cache.
async function seed(name, tag) {
  const files = baseFiles(tag);
  const cache = await globalThis.caches.open(name);
  for (const [n, b] of Object.entries(files)) await cache.put(n, new Response(b));
  await cache.put('release.json', new Response(JSON.stringify(makeRelease(tag, files))));
}

beforeEach(() => { globalThis.caches = makeCaches(); });

test('validateName accepts a normal name and trims', () => {
  assert.deepEqual(validateName('  Scourge  '), { ok: true, value: 'Scourge', message: '' });
});

test('validateName edge cases', () => {
  assert.equal(validateName('').ok, false);
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName('a'.repeat(20)).ok, true);
  assert.equal(validateName('a'.repeat(21)).ok, false);
  assert.equal(validateName(' Hello').value, 'Hello');
  assert.equal(validateName('_Hello').ok, false);
  assert.equal(validateName('-x').ok, false);
  assert.equal(validateName('Auton 2.1_a-b').ok, true);
  assert.equal(validateName('bad/name').ok, false);
  assert.equal(validateName(null).ok, false);
});

test('modeAvailable depends on the mode hot file', () => {
  const build = { release: {}, files: { 'hot.package.bin': new Uint8Array(1), 'cold.package.bin': new Uint8Array(1), 'project.pros': new Uint8Array(1) } };
  assert.equal(modeAvailable(build, 'competition'), true);
  assert.equal(modeAvailable(build, 'auton'), false);
  assert.equal(modeAvailable(build, 'nope'), false);
  assert.equal(modeAvailable(null, 'competition'), false);
  build.files['drive-test-hot.package.bin'] = new Uint8Array(1);
  assert.equal(modeAvailable(build, 'drive'), true);
  assert.equal(modeAvailable(build, 'autopath'), false);
  build.files['autopath-hot.package.bin'] = new Uint8Array(1);
  assert.equal(modeAvailable(build, 'autopath'), true);
  assert.equal(MODES.length, 4);
  assert.deepEqual(MODES.map((m) => m.slot), [1, 2, 3, 4]);
  assert.deepEqual(MODES.map((m) => m.name), ['Scourge', 'Scourge Auton Test', 'Scourge Drive Test', 'Scourge Auto Pathing']);
});

test('checkLatest offline returns offline without throwing', async () => {
  stubFetch(null, {}, { offline: true });
  const r = await checkLatest();
  assert.equal(r.offline, true);
  assert.equal(r.isNew, false);
  assert.equal(r.release, null);
});

test('download stores a build, then checkLatest sees no update', async () => {
  const files = baseFiles('v1');
  const rel = makeRelease('v1', files);
  stubFetch(rel, files);
  const seen = [];
  await downloadLatest((p) => seen.push(p.done));
  assert.deepEqual(seen, [1, 2, 3]);
  const b = await loadBuild();
  assert.equal(b.release.tag, 'v1');
  assert.deepEqual(b.files['hot.package.bin'], files['hot.package.bin']);
  assert.equal((await checkLatest()).isNew, false);
  const rel2 = makeRelease('v2', baseFiles('v2'));
  stubFetch(rel2, baseFiles('v2'));
  const r = await checkLatest();
  assert.equal(r.isNew, true);
  assert.equal(r.release.tag, 'v2');
  assert.equal(r.offline, false);
});

test('first check with no stored build is new', async () => {
  const files = baseFiles('v1');
  stubFetch(makeRelease('v1', files), files);
  assert.equal((await checkLatest()).isNew, true);
  assert.equal(await loadBuild(), null);
});

test('hash mismatch leaves the old build untouched', async () => {
  const f1 = baseFiles('v1');
  stubFetch(makeRelease('v1', f1), f1);
  await downloadLatest();

  const f2 = baseFiles('v2');
  const rel2 = makeRelease('v2', f2);
  const served = { ...f2, 'cold.package.bin': enc('corrupted') };
  stubFetch(rel2, served);
  await assert.rejects(downloadLatest(), /Download was damaged \(cold\.package\.bin failed its SHA-256 check\)\./);

  const b = await loadBuild();
  assert.equal(b.release.tag, 'v1');
  assert.deepEqual(b.files['cold.package.bin'], f1['cold.package.bin']);
  assert.equal(await activeTag(), 'v1');
});

test('network failure mid-download leaves the old build untouched', async () => {
  const f1 = baseFiles('v1');
  stubFetch(makeRelease('v1', f1), f1);
  await downloadLatest();
  const f2 = baseFiles('v2');
  const served = { ...f2 };
  delete served['project.pros'];
  stubFetch(makeRelease('v2', f2), served);
  await assert.rejects(downloadLatest());
  assert.equal((await loadBuild()).release.tag, 'v1');
});

test('a newer download replaces the old build and drops stale files', async () => {
  const f1 = { ...baseFiles('v1'), 'auton-test-hot.package.bin': enc('a1') };
  stubFetch(makeRelease('v1', f1), f1);
  await downloadLatest();
  assert.equal(modeAvailable(await loadBuild(), 'auton'), true);
  const f2 = baseFiles('v2');
  stubFetch(makeRelease('v2', f2), f2);
  await downloadLatest();
  const b = await loadBuild();
  assert.equal(b.release.tag, 'v2');
  assert.equal(modeAvailable(b, 'auton'), false);
  assert.equal(modeAvailable(b, 'competition'), true);
});

test('interrupted swap before the pointer flip keeps the old build', async () => {
  const f1 = baseFiles('v1');
  stubFetch(makeRelease('v1', f1), f1);
  await downloadLatest();
  const f2 = baseFiles('v2');
  stubFetch(makeRelease('v2', f2), f2);
  // Simulate the tab dying after the temp cache is written, at the pointer write.
  const real = globalThis.caches.open.bind(globalThis.caches);
  globalThis.caches.open = async (name) => {
    const c = await real(name);
    if (name !== 'scourge-build-pointer') return c;
    return { ...c, put: async () => { throw new Error('tab died'); } };
  };
  await assert.rejects(downloadLatest(), /Couldn't save the download/);
  globalThis.caches.open = real;
  const b = await loadBuild();
  assert.equal(b.release.tag, 'v1');
  assert.deepEqual(b.files['hot.package.bin'], f1['hot.package.bin']);
});

test('a half-written inactive cache is ignored', async () => {
  const f1 = baseFiles('v1');
  stubFetch(makeRelease('v1', f1), f1);
  await downloadLatest();
  const inactive = (await globalThis.caches.has('scourge-build-a')) ? 'scourge-build-b' : 'scourge-build-a';
  const c = await globalThis.caches.open(inactive);
  await c.put('release.json', new Response(JSON.stringify(makeRelease('v2', baseFiles('v2')))));
  assert.equal(await activeTag(), 'v1');
});

test('pointer flip makes the new build load and removes the old cache', async () => {
  const f1 = baseFiles('v1');
  stubFetch(makeRelease('v1', f1), f1);
  await downloadLatest();
  const first = globalThis.caches.stores.has('scourge-build-a') ? 'scourge-build-a' : 'scourge-build-b';
  const f2 = baseFiles('v2');
  stubFetch(makeRelease('v2', f2), f2);
  await downloadLatest();
  assert.equal(await activeTag(), 'v2');
  assert.equal(globalThis.caches.stores.has(first), false);
  const f3 = baseFiles('v3');
  stubFetch(makeRelease('v3', f3), f3);
  await downloadLatest();
  assert.equal(await activeTag(), 'v3');
});

test('legacy cache is read when there is no pointer, then replaced by a download', async () => {
  await seed('scourge-build-v1', 'old');
  assert.equal(await activeTag(), 'old');
  const f2 = baseFiles('v2');
  stubFetch(makeRelease('v2', f2), f2);
  await downloadLatest();
  assert.equal(await activeTag(), 'v2');
  assert.equal(globalThis.caches.stores.has('scourge-build-v1'), false);
});

test('an incomplete active cache falls back to the other valid one', async () => {
  await seed('scourge-build-b', 'good');
  const a = await globalThis.caches.open('scourge-build-a');
  await a.put('release.json', new Response(JSON.stringify(makeRelease('bad', baseFiles('bad')))));
  const p = await globalThis.caches.open('scourge-build-pointer');
  await p.put('active', new Response('scourge-build-a'));
  assert.equal(await activeTag(), 'good');
});

test('a build missing a listed file is not valid', async () => {
  await seed('scourge-build-v1', 'old');
  const c = await globalThis.caches.open('scourge-build-v1');
  await c.delete('cold.package.bin');
  assert.equal(await loadBuild(), null);
});

test('captive portal HTML gives a plain message', async () => {
  globalThis.fetch = async () => new Response('<html>Sign in to Wi-Fi</html>');
  await assert.rejects(downloadLatest(), /^Error: Couldn't read the release info\. If you're on public Wi-Fi/);
  const r = await checkLatest();
  assert.equal(r.offline, true);
  assert.equal(r.isNew, false);
  assert.match(r.error, /public Wi-Fi/);
});

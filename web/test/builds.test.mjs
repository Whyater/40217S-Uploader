import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MODES, slot4Mode, slotModes, modeAvailable, buildCatalog, olderList, cleanupPlan, validateKeepName, buildTitle,
  slotList, progressText, skippedText, idleUploadText, resultText, runSlotUploads,
  downloadByTag, downloadLatest, cleanupStored, KEPT_UNREADABLE_TEXT, loadBuild, listStored, getPicked, setPicked,
  setKept, getKept, removeKept, loadFullBuilds, loadPublished, loadBuildByTag,
} from '../releases.js';

const enc = (s) => new TextEncoder().encode(s);
const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const f = (name) => ({ name });

function makeBuild(tag, extra = []) {
  const files = { 'hot.package.bin': enc('h' + tag), 'cold.package.bin': enc('c' + tag), 'project.pros': enc('p' + tag) };
  for (const n of extra) files[n] = enc(n + tag);
  const sha256 = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)]));
  return { release: { tag, title: tag, notes: '', built_at: '2026-11-01T00:00:00Z', sha256 }, files };
}

function makeCaches() {
  const stores = new Map();
  const make = (map) => ({
    async put(k, res) { map.set(String(k), new Uint8Array(await res.arrayBuffer())); },
    async match(k) { const v = map.get(String(k)); return v ? new Response(v) : undefined; },
  });
  return {
    stores,
    async open(n) { if (!stores.has(n)) stores.set(n, new Map()); return make(stores.get(n)); },
    async has(n) { return stores.has(n); },
    async delete(n) { return stores.delete(n); },
    async keys() { return [...stores.keys()]; },
  };
}

beforeEach(() => { globalThis.caches = makeCaches(); });

/* ----- slot 4 rename ----- */

test('slot 4 resolves to Cascade Only, else Auto Pathing, else absent', () => {
  const cascade = makeBuild('build-440-aaaaaaa', ['cascade-hot.package.bin']);
  assert.equal(slot4Mode(cascade).label, 'Cascade Only');
  assert.equal(slot4Mode(cascade).name, 'Scourge Cascade');
  const old = makeBuild('build-400-aaaaaaa', ['autopath-hot.package.bin']);
  assert.equal(slot4Mode(old).label, 'Auto Pathing');
  assert.equal(slot4Mode(old).name, 'Scourge Auto Pathing');
  assert.equal(slot4Mode(old).hot, 'autopath-hot.package.bin');
  const none = makeBuild('build-300-aaaaaaa');
  assert.equal(slotModes(none)[3].present, false);
  assert.equal(slotModes(none)[3].label, 'Cascade Only');
});

test('from Build 437 an autopath file is the Cascade Only program', () => {
  const b437 = makeBuild('build-437-a4bd37d', ['autopath-hot.package.bin']);
  const m = slot4Mode(b437);
  assert.deepEqual([m.id, m.label, m.name, m.hot], ['cascade', 'Cascade Only', 'Scourge Cascade', 'autopath-hot.package.bin']);
  assert.deepEqual(slotModes(b437)[3].present, true);
  assert.equal(modeAvailable(b437, 'cascade'), true);
  const b436 = makeBuild('build-436-aaaaaaa', ['autopath-hot.package.bin']);
  assert.equal(slot4Mode(b436).id, 'autopath');
  assert.equal(slot4Mode(makeBuild('build-1000-aaaaaaa', ['autopath-hot.package.bin'])).id, 'cascade');
  // A cascade file still wins, and its own file is used.
  assert.equal(slot4Mode(makeBuild('build-437-a4bd37d', ['autopath-hot.package.bin', 'cascade-hot.package.bin'])).hot, 'cascade-hot.package.bin');
});

test('cascade wins when a release lists both slot 4 files', () => {
  const both = makeBuild('build-441-aaaaaaa', ['autopath-hot.package.bin', 'cascade-hot.package.bin']);
  assert.equal(slot4Mode(both).id, 'cascade');
});

test('resolution follows release.json sha256, not stray files', () => {
  const b = makeBuild('build-442-aaaaaaa');
  b.files['cascade-hot.package.bin'] = enc('stray');
  assert.equal(slot4Mode(b).id, 'cascade'); // still the default entry
  assert.equal(slotModes(b)[3].present, true); // file present
  const listedAuto = makeBuild('build-399-aaaaaaa', ['autopath-hot.package.bin']);
  listedAuto.files['cascade-hot.package.bin'] = enc('stray');
  assert.equal(slot4Mode(listedAuto).id, 'autopath');
  assert.equal(modeAvailable(listedAuto, 'cascade'), true);
});

test('slot list names match the Mac app', () => {
  const b = makeBuild('build-443-aaaaaaa', ['auton-test-hot.package.bin', 'cascade-hot.package.bin']);
  assert.deepEqual(slotModes(b).map((m) => [m.slot, m.label, m.name, m.present]), [
    [1, 'Competition', 'Scourge', true],
    [2, 'Auton Test', 'Scourge Auton Test', true],
    [3, 'Drive Test', 'Scourge Drive Test', false],
    [4, 'Cascade Only', 'Scourge Cascade', true],
  ]);
  assert.equal(MODES.length, 4);
});

/* ----- catalog ----- */

const full = [
  { tag: 'build-300-aaaaaaa', note: 'Old' },
  { tag: 'build-420-bbbbbbb', note: 'Skills' },
  { tag: 'build-410-ccccccc', note: '' },
  { tag: 'build-430-ddddddd', note: 'Comp' },
  { tag: 'build-435-eeeeeee', note: '' },
];

const titles = (groups) => groups.map((g) => [g.title, g.items.map((i) => i.tag)]);

test('catalog groups in order and caps full builds at 3 excluding the newest', () => {
  const g = buildCatalog({ newestTag: 'build-437-1111111', fullBuilds: full, stored: ['build-437-1111111'], kept: {} });
  assert.deepEqual(titles(g), [
    ['Newest', ['build-437-1111111']],
    ['Full Builds', ['build-435-eeeeeee', 'build-430-ddddddd', 'build-420-bbbbbbb']],
  ]);
  assert.equal(g[0].items[0].label, 'test build');
  assert.equal(g[1].items[0].label, 'full build');
  assert.equal(g[1].items[1].label, 'Comp');
});

test('newest that is a full build has no test label and is not repeated', () => {
  const g = buildCatalog({ newestTag: 'build-435-eeeeeee', fullBuilds: full, stored: [], kept: {} });
  assert.equal(g[0].items[0].label, '');
  assert.deepEqual(g[1].items.map((i) => i.tag), ['build-430-ddddddd', 'build-420-bbbbbbb', 'build-410-ccccccc']);
});

test('unknown full-builds list gives no test label and no Full Builds group', () => {
  const g = buildCatalog({ newestTag: 'build-437-1111111', fullBuilds: null, stored: [], kept: {} });
  assert.deepEqual(titles(g), [['Newest', ['build-437-1111111']]]);
  assert.equal(g[0].items[0].label, '');
});

test('kept and device groups, names, stored flags', () => {
  const g = buildCatalog({
    newestTag: 'build-437-1111111', fullBuilds: full,
    stored: ['build-437-1111111', 'build-420-bbbbbbb', 'build-390-2222222', 'build-380-3333333'],
    kept: { 'build-390-2222222': 'Skills backup', 'build-435-eeeeeee': 'Comp day' },
  });
  assert.deepEqual(titles(g), [
    ['Newest', ['build-437-1111111']],
    ['Full Builds', ['build-435-eeeeeee', 'build-430-ddddddd', 'build-420-bbbbbbb']],
    ['Kept', ['build-390-2222222']],
    ['Also on This Device', ['build-380-3333333']],
  ]);
  assert.equal(g[1].items[0].title, 'Comp day (Build 435)'); // kept name shows in its own group too
  assert.equal(g[1].items[0].stored, false);
  assert.equal(g[1].items[2].stored, true);
  assert.equal(g[2].items[0].title, 'Skills backup (Build 390)');
});

test('empty groups are dropped', () => {
  assert.deepEqual(buildCatalog({ newestTag: null, fullBuilds: null, stored: [], kept: null }), []);
});

test('older list is newest first with notes and device flags', () => {
  const rows = olderList({
    published: [{ tag: 'build-437-1111111', date: '2026-11-17' }, { tag: 'build-430-ddddddd', date: '2026-11-10' }, { tag: 'build-300-aaaaaaa', date: '2026-10-01' }],
    fullBuilds: full, stored: ['build-430-ddddddd'], kept: { 'build-300-aaaaaaa': 'Day one' },
  });
  assert.deepEqual(rows.map((r) => [r.tag, r.note, r.stored, r.title]), [
    ['build-437-1111111', '', false, 'Build 437'],
    ['build-430-ddddddd', 'Comp', true, 'Build 430'],
    ['build-300-aaaaaaa', 'Old', false, 'Day one (Build 300)'],
  ]);
});

test('keep name rules', () => {
  assert.equal(validateKeepName('Skills backup').ok, true);
  assert.equal(validateKeepName('  Skills  ').value, 'Skills');
  assert.equal(validateKeepName('').ok, false);
  assert.equal(validateKeepName('   ').ok, false);
  assert.equal(validateKeepName('a'.repeat(40)).ok, true);
  assert.equal(validateKeepName('a'.repeat(41)).ok, false);
  assert.equal(validateKeepName('two\nlines').ok, false);
  assert.equal(buildTitle('build-437-1111111', 'Skills backup'), 'Skills backup (Build 437)');
  assert.equal(buildTitle('build-437-1111111', ''), 'Build 437');
});

/* ----- cleanup rules ----- */

const stored = ['build-437-1111111', 'build-435-eeeeeee', 'build-430-ddddddd', 'build-420-bbbbbbb', 'build-410-ccccccc', 'build-390-2222222', 'build-300-aaaaaaa'];

test('cleanup keeps newest, 3 newest full, kept and picked', () => {
  const doomed = cleanupPlan({
    stored, newestTag: 'build-437-1111111', fullBuilds: full,
    kept: { 'build-390-2222222': 'x' }, picked: 'build-410-ccccccc',
  });
  // full keeps 435, 430, 420; newest 437; kept 390; picked 410. Only 300 goes.
  assert.deepEqual(doomed, ['build-300-aaaaaaa']);
});

test('cleanup deletes nothing while any list is unknown', () => {
  const base = { stored, newestTag: 'build-437-1111111', fullBuilds: full, kept: {}, picked: null };
  assert.ok(cleanupPlan(base).length > 0);
  assert.deepEqual(cleanupPlan({ ...base, fullBuilds: null }), []);
  assert.deepEqual(cleanupPlan({ ...base, kept: null }), []);
  assert.deepEqual(cleanupPlan({ ...base, newestTag: null }), []);
});

/* ----- storage and downloads ----- */

const RELAY = 'https://relay.example';
const MANIFEST = 'https://raw.githubusercontent.com/Whyater/40217S-Uploader/main/uploader.json';

// builds: [{release, files}] published newest first. newest is served at ./build/, the
// tags in bundled at ./build/<tag>/ (listed in ./build/builds.json), and every build
// through the relay's /asset route. calls records each URL asked for.
function serveRelease(builds, { rate = false, bundled = [], newest = null, relay = true, fullBody = null } = {}) {
  const calls = [];
  const byTag = (t) => builds.find((x) => x.release.tag === t);
  const fileOf = (b, name) => {
    if (!b) return new Response('no', { status: 404 });
    if (name === 'release.json') return new Response(JSON.stringify(b.release));
    return b.files[name] ? new Response(b.files[name]) : new Response('no', { status: 404 });
  };
  globalThis.fetch = async (url) => {
    url = String(url);
    calls.push(url);
    if (url.includes('/releases?per_page=100')) {
      if (rate) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      return new Response(JSON.stringify(builds.map((b, i) => ({
        tag_name: b.release.tag, published_at: `2026-11-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
        assets: [...Object.keys(b.files), 'release.json'].map((n) => ({ name: n, id: `${b.release.tag}~${n}` })),
      }))));
    }
    if (url.includes('full-builds.json')) return new Response(fullBody != null ? fullBody : JSON.stringify({ version: 1, builds: full }));
    if (url.startsWith(MANIFEST)) return new Response(JSON.stringify({ version: '2.9.0', results_url: `${RELAY}/results` }));
    if (url.startsWith(`${RELAY}/asset?`)) {
      if (!relay) throw new TypeError('Failed to fetch');
      const q = new URL(url).searchParams;
      return fileOf(byTag(q.get('tag')), q.get('name'));
    }
    if (url === './build/builds.json') return new Response(JSON.stringify({ version: 1, newest, builds: bundled }));
    const m = /^\.\/build\/(build-[^/]+)\/(.+)$/.exec(url);
    if (m) return bundled.includes(m[1]) ? fileOf(byTag(m[1]), m[2]) : new Response('no', { status: 404 });
    if (url.startsWith('./build/') && newest) return fileOf(byTag(newest), url.slice('./build/'.length));
    return new Response('no', { status: 404 });
  };
  return calls;
}

test('the newest comes from build/, a bundled full build from build/<tag>/, anything else from the relay', async () => {
  const newest = makeBuild('build-437-1111111');
  const fullB = makeBuild('build-435-eeeeeee', ['cascade-hot.package.bin']);
  const older = makeBuild('build-300-aaaaaaa', ['autopath-hot.package.bin']);
  const opts = { newest: 'build-437-1111111', bundled: ['build-435-eeeeeee'] };
  const src = [];
  const onSource = (s) => src.push(s);

  let calls = serveRelease([newest, fullB, older], opts);
  await downloadByTag('build-437-1111111', { newestTag: 'build-437-1111111', onSource });
  assert.ok(calls.includes('./build/hot.package.bin'));
  assert.ok(!calls.some((u) => u.startsWith('http')), 'the newest never leaves this site');

  calls = serveRelease([newest, fullB, older], opts);
  const seen = [];
  await downloadByTag('build-435-eeeeeee', { newestTag: 'build-437-1111111', onSource, onProgress: (p) => seen.push(p.done) });
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.ok(calls.includes('./build/build-435-eeeeeee/release.json'));
  assert.ok(calls.includes('./build/build-435-eeeeeee/cascade-hot.package.bin'));
  assert.ok(!calls.some((u) => u.startsWith('http')), 'a bundled build never leaves this site');
  assert.equal(await getPicked(), 'build-435-eeeeeee');
  assert.deepEqual((await loadBuild()).files['cascade-hot.package.bin'], fullB.files['cascade-hot.package.bin']);

  calls = serveRelease([newest, fullB, older], opts);
  await downloadByTag('build-300-aaaaaaa', { newestTag: 'build-437-1111111', onSource });
  const relayCalls = calls.filter((u) => u.startsWith(`${RELAY}/asset?`));
  assert.deepEqual(relayCalls.map((u) => new URL(u).searchParams.get('name')).sort(),
    ['autopath-hot.package.bin', 'cold.package.bin', 'hot.package.bin', 'project.pros', 'release.json']);
  assert.ok(relayCalls.every((u) => new URL(u).searchParams.get('tag') === 'build-300-aaaaaaa'));
  assert.ok(!calls.some((u) => /api\.github\.com|releases\/assets|releases\/download/.test(u)), 'never asks GitHub for the files');
  assert.equal(await getPicked(), 'build-300-aaaaaaa');

  assert.deepEqual(src, ['newest', 'bundled', 'relay']);
  assert.deepEqual((await listStored()).sort(), ['build-300-aaaaaaa', 'build-435-eeeeeee', 'build-437-1111111']);
});

test('a relay that does not answer gives the plain message and changes nothing', async () => {
  const good = makeBuild('build-430-ddddddd');
  serveRelease([good], { bundled: ['build-430-ddddddd'] });
  await downloadByTag('build-430-ddddddd');
  serveRelease([makeBuild('build-300-aaaaaaa')], { relay: false });
  await assert.rejects(downloadByTag('build-300-aaaaaaa'),
    { message: "Older builds need the team's relay, which didn't answer. Full builds still work." });
  assert.equal(await getPicked(), 'build-430-ddddddd');
  assert.deepEqual(await listStored(), ['build-430-ddddddd']);
});

test('a build not bundled on this site goes to the relay even if it is a full build', async () => {
  const b = makeBuild('build-420-bbbbbbb');
  const calls = serveRelease([b], { bundled: [] });
  await downloadByTag('build-420-bbbbbbb', { newestTag: 'build-437-1111111' });
  assert.ok(calls.some((u) => u.startsWith(`${RELAY}/asset?tag=build-420-bbbbbbb&name=release.json`)));
});

test('a corrupted file is rejected and the picked build is unchanged', async () => {
  const good = makeBuild('build-430-ddddddd');
  serveRelease([good]);
  await downloadByTag('build-430-ddddddd');
  const bad = makeBuild('build-420-bbbbbbb');
  const served = { release: bad.release, files: { ...bad.files, 'cold.package.bin': enc('corrupt') } };
  serveRelease([served]);
  await assert.rejects(downloadByTag('build-420-bbbbbbb'), /cold\.package\.bin failed its SHA-256 check/);
  assert.equal((await loadBuild()).release.tag, 'build-430-ddddddd');
  assert.deepEqual(await listStored(), ['build-430-ddddddd']);
});

test('release.json for another tag is refused', async () => {
  const b = makeBuild('build-430-ddddddd');
  serveRelease([b]);
  const real = globalThis.fetch;
  // Asked for build-999, the relay answers with build-430's release.json.
  globalThis.fetch = async (url) => (String(url).includes('tag=build-999-0000000&name=release.json')
    ? new Response(JSON.stringify(b.release)) : real(url));
  await assert.rejects(downloadByTag('build-999-0000000'), /different build/);
  assert.deepEqual(await listStored(), []);
});

test('a missing file on the relay says which', async () => {
  const b = makeBuild('build-430-ddddddd');
  const thin = { release: b.release, files: { ...b.files } };
  delete thin.files['project.pros'];
  serveRelease([thin]);
  await assert.rejects(downloadByTag('build-430-ddddddd'), /project\.pros is missing from the release/);
});

test('rate limit gives a plain message', async () => {
  serveRelease([], { rate: true });
  await assert.rejects(loadPublished(), /limiting requests/);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(loadPublished(), /Couldn't reach GitHub/);
});

test('full-builds list is kept for offline use', async () => {
  serveRelease([]);
  const first = await loadFullBuilds();
  assert.equal(first.builds.length, 5);
  assert.equal(first.stale, false);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const off = await loadFullBuilds();
  assert.equal(off.builds.length, 5);
  assert.equal(off.stale, true);
  globalThis.caches = makeCaches();
  assert.equal((await loadFullBuilds()).builds, null);
});

test('full-builds lists the app cannot trust are refused and the saved copy stays', async () => {
  serveRelease([]);
  await loadFullBuilds();
  for (const body of [
    JSON.stringify({ version: 1, builds: [] }),
    JSON.stringify({ builds: full }),
    JSON.stringify({ version: 2, builds: full }),
    JSON.stringify({ version: 1, builds: [{ tag: 'latest' }, { tag: 'build-1-ABCDEFG' }, { tag: 'v2' }, { note: 'x' }] }),
    JSON.stringify({ version: 1 }),
    '<html>sign in</html>',
  ]) {
    serveRelease([], { fullBody: body });
    const r = await loadFullBuilds();
    assert.equal(r.stale, true, body);
    assert.equal(r.builds.length, 5, body);
  }
  // Offline afterwards, the good copy is what is left.
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await loadFullBuilds()).builds.length, 5);
});

test('full-builds entries: bad tags skipped, each tag once (first wins), highest first', async () => {
  serveRelease([], { fullBody: JSON.stringify({ version: 1, builds: [
    { tag: 'build-300-aaaaaaa', note: ' first ' }, { tag: 'build-12-abcdef' }, { tag: 'build-420-bbbbbbb' },
    { tag: 'build-300-aaaaaaa', note: 'second' }, { tag: 'build-1234567890-aaaaaaa' },
  ] }) });
  const r = await loadFullBuilds();
  assert.deepEqual(r.builds, [{ tag: 'build-420-bbbbbbb', note: '' }, { tag: 'build-300-aaaaaaa', note: 'first' }]);
});

test('an unreadable kept list is backed up before it is written over', async () => {
  const c = await caches.open('scourge-meta');
  await c.put('kept', new Response('{"build-1-aaaaaaa": "One"'));
  assert.equal(await getKept(), null);
  await setKept('build-2-bbbbbbb', 'Two');
  assert.equal(await (await c.match('kept.bak')).text(), '{"build-1-aaaaaaa": "One"');
  assert.deepEqual(await getKept(), { 'build-2-bbbbbbb': 'Two' });
});

test('an unreadable kept list that cannot be backed up is not written over', async () => {
  const c = await caches.open('scourge-meta');
  await c.put('kept', new Response('???'));
  const real = caches.open.bind(caches);
  caches.open = async (n) => {
    const x = await real(n);
    return { ...x, put: async (k, v) => { if (String(k) === 'kept.bak') throw new Error('full'); return x.put(k, v); } };
  };
  await assert.rejects(setKept('build-2-bbbbbbb', 'Two'), { message: KEPT_UNREADABLE_TEXT });
  caches.open = real;
  assert.equal(await (await c.match('kept')).text(), '???');
});

test('kept names persist and can be removed', async () => {
  assert.deepEqual(await getKept(), {});
  await setKept('build-1-aaaaaaa', 'One');
  await setKept('build-2-bbbbbbb', 'Two');
  assert.deepEqual(await getKept(), { 'build-1-aaaaaaa': 'One', 'build-2-bbbbbbb': 'Two' });
  await setKept('build-1-aaaaaaa', 'Renamed');
  await removeKept('build-2-bbbbbbb');
  assert.deepEqual(await getKept(), { 'build-1-aaaaaaa': 'Renamed' });
  const c = await caches.open('scourge-meta');
  await c.put('kept', new Response('not json'));
  assert.equal(await getKept(), null);
});

async function storeAll(tags) {
  const builds = tags.map((t) => makeBuild(t));
  serveRelease(builds);
  for (const t of [...tags].reverse()) await downloadByTag(t);
}

test('cleanupStored removes only unprotected builds after lists are known', async () => {
  await storeAll(['build-437-1111111', 'build-435-eeeeeee', 'build-300-aaaaaaa', 'build-310-bbbbbbb']);
  await setPicked('build-435-eeeeeee');
  await setKept('build-310-bbbbbbb', 'Mine');
  // Lists unknown: no full-builds copy was fetched yet.
  assert.deepEqual(await cleanupStored({ newestTag: 'build-437-1111111' }), []);
  await loadFullBuilds();
  const gone = await cleanupStored({ newestTag: 'build-437-1111111' });
  assert.deepEqual(gone, ['build-300-aaaaaaa']);
  assert.deepEqual((await listStored()).sort(), ['build-310-bbbbbbb', 'build-435-eeeeeee', 'build-437-1111111']);
  assert.ok(await loadBuildByTag('build-310-bbbbbbb'));
});

test('cleanupStored with an unreadable kept list deletes nothing', async () => {
  await storeAll(['build-437-1111111', 'build-300-aaaaaaa']);
  await loadFullBuilds();
  const c = await caches.open('scourge-meta');
  await c.put('kept', new Response('???'));
  assert.deepEqual(await cleanupStored({ newestTag: 'build-437-1111111' }), []);
  assert.equal((await listStored()).length, 2);
});

test('downloadLatest keeps the bundled build alongside others', async () => {
  const b = makeBuild('build-440-9999999');
  globalThis.fetch = async (url) => {
    const name = String(url).replace('./build/', '');
    if (name === 'release.json') return new Response(JSON.stringify(b.release));
    return b.files[name] ? new Response(b.files[name]) : new Response('no', { status: 404 });
  };
  await downloadLatest();
  assert.equal(await getPicked(), 'build-440-9999999');
});

/* ----- multi-slot sequencing ----- */

const four = makeBuild('build-443-aaaaaaa', ['auton-test-hot.package.bin', 'drive-test-hot.package.bin', 'cascade-hot.package.bin']);
const three = makeBuild('build-444-aaaaaaa', ['auton-test-hot.package.bin', 'drive-test-hot.package.bin']);

test('slot list wording', () => {
  assert.equal(slotList([1]), 'slot 1');
  assert.equal(slotList([1, 2]), 'slots 1 and 2');
  assert.equal(slotList([1, 2, 3, 4]), 'slots 1, 2, 3, and 4');
  assert.equal(idleUploadText(four, 'Build 443'), 'Ready to upload Build 443 to slots 1, 2, 3, and 4.');
  assert.equal(idleUploadText(three, 'Build 444'), 'Ready to upload Build 444 to slots 1, 2, and 3.');
});

test('uploads every program in slot order and reports success', async () => {
  const order = [];
  const starts = [];
  const res = await runSlotUploads(four, async (m) => { order.push(m.slot); }, { onStart: (s) => starts.push(progressText('Build 443', s.i, s.n, s.mode)) });
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.equal(starts[0], 'Uploading Build 443, 1 of 4: Scourge (slot 1)… Keep the cable plugged in.');
  assert.equal(starts[3], 'Uploading Build 443, 4 of 4: Scourge Cascade (slot 4)… Keep the cable plugged in.');
  assert.equal(resultText('Build 443', res), 'Uploaded Build 443 to slots 1, 2, 3, and 4. Run them from the brain screen.');
});

test('a mode the build lacks is skipped with the old-program note', async () => {
  const order = [];
  const res = await runSlotUploads(three, async (m) => { order.push(m.slot); });
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(resultText('Build 444', res),
    'Uploaded Build 444 to slots 1, 2, and 3. Run them from the brain screen. Slot 4 skipped: this build has no Cascade Only version, so slot 4 still has its old program.');
  assert.equal(skippedText({ slot: 4, label: 'Auto Pathing' }), 'Slot 4 skipped: this build has no Auto Pathing version, so slot 4 still has its old program.');
});

test('stops at the first failure and says what finished, failed, and did not run', async () => {
  const order = [];
  const res = await runSlotUploads(four, async (m) => {
    order.push(m.slot);
    if (m.slot === 2) throw new Error('Brain stopped answering.');
  });
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(res.done, [1]);
  assert.equal(res.failed.slot, 2);
  assert.deepEqual(res.notUploaded, [3, 4]);
  assert.equal(resultText('Build 443', res),
    'Build 443: slot 1 finished. Slot 2 (Auton Test) failed: Brain stopped answering. Slots 3 and 4 not uploaded. Upload again to finish.');
});

test('first-slot failure says nothing finished', async () => {
  const res = await runSlotUploads(three, async () => { throw new Error('No brain.'); });
  assert.match(resultText('Build 444', res), /^Build 444: no slots finished\. Slot 1 \(Competition\) failed: No brain\. Slots 2 and 3 not uploaded\. Upload again to finish\.\s*Slot 4 skipped/);
});

test('a slot erased by the library swap and uploaded again later is not reported lost', async () => {
  // Slot 1 is erased while uploading slot 1 itself, slot 2 and 3 erased while uploading 1: all re-uploaded after.
  const res = await runSlotUploads(four, async (m, ctx) => {
    if (m.slot === 1) ctx.erased(['slot_2.bin', 'slot_3.bin', 'slot_6.bin']);
  });
  assert.deepEqual(res.lost, [6]);
  assert.match(resultText('Build 443', res), /deleted the program in slot 6\./);
});

test('slots uploaded before an erase are reported lost', async () => {
  const res = await runSlotUploads(four, async (m, ctx) => {
    if (m.slot === 3) ctx.erased(['slot_1.bin', 'slot_2.bin']);
  });
  assert.deepEqual(res.lost, [1, 2]);
  assert.match(resultText('Build 443', res), /deleted the programs in slots 1 and 2\./);
});

test('after a failure, erased slots that were never uploaded are covered by upload again', async () => {
  const res = await runSlotUploads(four, async (m, ctx) => {
    if (m.slot === 1) ctx.erased(['slot_3.bin']);
    if (m.slot === 2) throw new Error('Cable pulled.');
  });
  assert.deepEqual(res.lost, []);
  assert.equal(res.failed.slot, 2);
});

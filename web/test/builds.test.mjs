import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MODES, slot4Mode, slotModes, modeAvailable, buildCatalog, olderList, cleanupPlan, validateKeepName, buildTitle,
  slotList, progressText, skippedText, idleUploadText, resultText, runSlotUploads,
  downloadPublished, downloadLatest, cleanupStored, loadBuild, listStored, getPicked, setPicked,
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

function serveRelease(builds, { rate = false } = {}) {
  // builds: [{tag, files, release}] published newest first; ids are 'tag/name'.
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('/releases?per_page=100')) {
      if (rate) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      return new Response(JSON.stringify(builds.map((b, i) => ({
        tag_name: b.release.tag, published_at: `2026-11-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
        assets: [...Object.keys(b.files), 'release.json'].map((n) => ({ name: n, id: `${b.release.tag}~${n}` })),
      }))));
    }
    const m = /releases\/assets\/(.+)$/.exec(url);
    if (m) {
      assert.equal(opts.headers.Accept, 'application/octet-stream');
      const [tag, name] = m[1].split('~');
      const b = builds.find((x) => x.release.tag === tag);
      if (name === 'release.json') return new Response(JSON.stringify(b.release));
      return b.files[name] ? new Response(b.files[name]) : new Response('no', { status: 404 });
    }
    if (url.includes('full-builds.json')) return new Response(JSON.stringify({ version: 1, builds: full }));
    return new Response('no', { status: 404 });
  };
}

test('published build downloads, verifies, and becomes the picked build', async () => {
  const b = makeBuild('build-430-ddddddd', ['cascade-hot.package.bin']);
  serveRelease([b]);
  const list = await loadPublished();
  assert.equal(list[0].tag, 'build-430-ddddddd');
  assert.ok(list[0].assets['release.json']);
  const seen = [];
  await downloadPublished(list[0], (p) => seen.push(p.done));
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(await getPicked(), 'build-430-ddddddd');
  assert.deepEqual((await loadBuild()).files['cascade-hot.package.bin'], b.files['cascade-hot.package.bin']);
});

test('a corrupted published file is rejected and the picked build is unchanged', async () => {
  const good = makeBuild('build-430-ddddddd');
  serveRelease([good]);
  await downloadPublished((await loadPublished())[0]);
  const bad = makeBuild('build-420-bbbbbbb');
  const served = { release: bad.release, files: { ...bad.files, 'cold.package.bin': enc('corrupt') } };
  serveRelease([served]);
  await assert.rejects(downloadPublished((await loadPublished())[0]), /cold\.package\.bin failed its SHA-256 check/);
  assert.equal((await loadBuild()).release.tag, 'build-430-ddddddd');
  assert.deepEqual(await listStored(), ['build-430-ddddddd']);
});

test('release.json for another tag is refused', async () => {
  const b = makeBuild('build-430-ddddddd');
  serveRelease([b]);
  const entry = { ...(await loadPublished())[0], tag: 'build-999-0000000' };
  await assert.rejects(downloadPublished(entry), /different build/);
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
  const list = await loadPublished();
  for (const t of [...tags].reverse()) await downloadPublished(list.find((p) => p.tag === t));
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayBase, mapUrl, checkCode, cleanResponse, syncCloud, describe, buildLabel, whenText, MANIFEST_URL } from '../mapcloud.js';

const RELAY = 'https://relay.example.workers.dev';
const MANIFEST = { version: '2.4.0', results_url: `${RELAY}/results` };
const SIM = { schema: 1, tag: 'build-70-abc1234', build: 70, routes: [{ id: 'awp-L', samples: [], events: [] }] };
const REC = { generated: '2026-10-30T23:00:00Z', routes: [], sessions: [] };
const GOOD = { ok: true, sim: SIM, recorded: REC, recorded_updated: '2026-10-30T23:01:00Z', sim_is_latest: false };

// In-memory store with the same three calls as mapstore.js.
function memStore(initial = null) {
  let row = initial;
  const calls = { save: 0, clear: 0 };
  return {
    calls,
    get row() { return row; },
    async loadCloud() { return row ? { ...row } : null; },
    async saveCloud(r) { calls.save += 1; row = { ...r }; },
    async clearCloud() { calls.clear += 1; row = null; },
  };
}

// A fetch that answers the manifest and /map, and records every call.
function fakeFetch({ map = () => new Response(JSON.stringify(GOOD)), manifest = () => new Response(JSON.stringify(MANIFEST)) } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(MANIFEST_URL)) return manifest();
    return map(url, init);
  };
  fn.calls = calls;
  return fn;
}
const mapCalls = (f) => f.calls.filter((c) => !c.url.startsWith(MANIFEST_URL));

test('relayBase replaces the /results path and refuses odd addresses', () => {
  assert.equal(relayBase(`${RELAY}/results`), RELAY);
  assert.equal(relayBase(`${RELAY}/results/`), RELAY);
  assert.equal(relayBase(RELAY), RELAY);
  assert.equal(relayBase('http://relay.example/results'), '');
  assert.equal(relayBase('https://relay.example/results?x=1'), '');
  assert.equal(relayBase('javascript:alert(1)'), '');
  assert.equal(relayBase(undefined), '');
});

test('mapUrl names the build, or asks for the latest when none is downloaded', () => {
  assert.equal(mapUrl(RELAY, 'build-70-abc1234'), `${RELAY}/map?build=build-70-abc1234`);
  assert.equal(mapUrl(RELAY, 'a b&c'), `${RELAY}/map?build=a%20b%26c`);
  assert.equal(mapUrl(RELAY, null), `${RELAY}/map`);
});

test('checkCode trims, and only lets through what a header can carry', () => {
  assert.deepEqual(checkCode('  scourge1  '), { ok: true, value: 'scourge1', message: '' });
  assert.equal(checkCode('').ok, false);
  assert.equal(checkCode('   ').ok, false);
  assert.equal(checkCode('café').ok, false);
  assert.equal(checkCode('a'.repeat(129)).ok, false);
});

test('with no stored code nothing is fetched', async () => {
  const f = fakeFetch();
  const r = await syncCloud({ store: memStore(), fetchFn: f });
  assert.equal(r.status, 'need-code');
  assert.equal(f.calls.length, 0);
});

test('a good download is cached with the code, and the code only travels in a header', async () => {
  const store = memStore({ code: 'sekret-code' });
  const f = fakeFetch();
  const r = await syncCloud({ store, fetchFn: f, tag: 'build-70-abc1234', now: () => 5000 });
  assert.equal(r.status, 'fresh');
  assert.equal(r.fetched, 5000);
  assert.equal(r.response.sim.tag, 'build-70-abc1234');
  assert.equal(r.response.recorded.generated, REC.generated);
  const [call] = mapCalls(f);
  assert.equal(call.url, `${RELAY}/map?build=build-70-abc1234`);
  assert.equal(call.init.headers['X-Team-Code'], 'sekret-code');
  for (const c of f.calls) assert.equal(c.url.includes('sekret-code'), false, 'never in a URL');
  assert.equal(store.row.code, 'sekret-code');
  assert.equal(store.row.relay, RELAY);
  assert.equal(store.row.fetched, 5000);
  assert.equal(store.row.response.sim.tag, 'build-70-abc1234');
});

test('no build downloaded asks for the latest', async () => {
  const f = fakeFetch();
  await syncCloud({ store: memStore({ code: 'c' }), fetchFn: f, tag: null });
  assert.equal(mapCalls(f)[0].url, `${RELAY}/map`);
});

test('a 401 clears the code and the saved data', async () => {
  const store = memStore({ code: 'old', relay: RELAY, fetched: 1, response: cleanResponse(GOOD) });
  const f = fakeFetch({ map: () => new Response('{"ok":false,"error":"wrong team code"}', { status: 401 }) });
  const r = await syncCloud({ store, fetchFn: f });
  assert.equal(r.status, 'bad-code');
  assert.equal(r.response, null);
  assert.equal(store.row, null);
  assert.equal(store.calls.clear, 1);
  assert.match(describe(r).notices[0].text, /code didn't work/);
});

test('offline with a saved download shows it, and keeps the code', async () => {
  const saved = cleanResponse(GOOD);
  const store = memStore({ code: 'c', relay: RELAY, fetched: 1000, response: saved });
  const f = async () => { throw new TypeError('Failed to fetch'); };
  const r = await syncCloud({ store, fetchFn: f });
  assert.equal(r.status, 'offline');
  assert.equal(r.reason, 'network');
  assert.equal(r.fetched, 1000);
  assert.equal(r.response.sim.tag, 'build-70-abc1234');
  assert.equal(store.row.code, 'c');
  assert.equal(store.calls.save, 0, 'a failed download does not overwrite the saved one');
  const d = describe(r, 'build-70-abc1234', 'en-US');
  assert.equal(d.notices[0].text, `Offline, showing data from ${whenText(1000, 'en-US')}`);
});

test('offline with nothing saved gives the empty state', async () => {
  const store = memStore({ code: 'c' });
  const r = await syncCloud({ store, fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(r.status, 'offline-empty');
  assert.equal(r.response, null);
  assert.equal(store.row.code, 'c', 'the code stays so the next try works');
});

test('the saved relay address is used when the manifest cannot be reached', async () => {
  const store = memStore({ code: 'c', relay: RELAY });
  const f = fakeFetch({ manifest: () => { throw new TypeError('Failed to fetch'); } });
  const r = await syncCloud({ store, fetchFn: f });
  assert.equal(r.status, 'fresh');
  assert.equal(mapCalls(f)[0].url.startsWith(RELAY), true);
});

test('no manifest and no saved address counts as offline', async () => {
  const f = async () => { throw new TypeError('Failed to fetch'); };
  const r = await syncCloud({ store: memStore({ code: 'c' }), fetchFn: f });
  assert.equal(r.status, 'offline-empty');
});

test('server trouble keeps the saved data and says so', async () => {
  const store = memStore({ code: 'c', relay: RELAY, fetched: 7, response: cleanResponse(GOOD) });
  for (const map of [() => new Response('boom', { status: 500 }), () => new Response('<html>Sign in</html>'), () => new Response('{"ok":false}')]) {
    const r = await syncCloud({ store, fetchFn: fakeFetch({ map }) });
    assert.equal(r.status, 'offline');
    assert.equal(r.reason, 'server');
    assert.equal(r.fetched, 7);
  }
  assert.match(describe({ status: 'offline', reason: 'server', fetched: 7 }).notices[0].text, /^Couldn't reach the map service\. Showing data from /);
});

test('a hanging request is cut off instead of blocking the map', async () => {
  const f = (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const r = await syncCloud({ store: memStore({ code: 'c', relay: RELAY }), fetchFn: f, timeoutMs: 10 });
  assert.equal(r.status, 'offline-empty');
});

test('a store that cannot save does not lose the fresh download', async () => {
  const store = memStore({ code: 'c' });
  store.saveCloud = async () => { throw new Error('quota'); };
  const r = await syncCloud({ store, fetchFn: fakeFetch() });
  assert.equal(r.status, 'fresh');
  assert.equal(r.response.sim.tag, 'build-70-abc1234');
});

test('cleanResponse keeps only what the page uses', () => {
  const r = cleanResponse({ ok: true, sim: [], recorded: 'x', extra: 1, sim_is_latest: 'yes' });
  assert.deepEqual(r, { sim: null, recorded: null, recorded_updated: null, sim_is_latest: false });
  assert.deepEqual(cleanResponse(null), r);
});

test('words: build label, fresh and saved lines', () => {
  assert.equal(buildLabel('build-70-abc1234'), 'Build 70');
  assert.equal(buildLabel(null), '');
  assert.match(describe({ status: 'fresh', fetched: 1000 }, 'build-70-abc1234').detail, /^Build 70, updated /);
  assert.match(describe({ status: 'cached', fetched: 1000 }, null).detail, /^Latest build, saved /);
  assert.deepEqual(describe({ status: 'need-code' }).notices, []);
  assert.match(describe({ status: 'offline-empty', reason: 'network' }).notices[0].text, /^Offline, and nothing is saved/);
});

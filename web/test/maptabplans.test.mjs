// Runs the real maptab.js against a stand-in page, to check the wiring around
// sendPlan: which messages count, what a 401 clears, and that the panel comes back.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const RELAY = 'https://relay.example.workers.dev';
const ORIGIN = 'https://whyater.github.io';
const PLAN = { schema: 1, kind: 'proposed-auto-plan', name: 'Left 2 goal', side: 'L', note: '', build: null, lines: [{ points: [[0, 0], [3, 4]] }] };

function element() {
  return {
    hidden: false, disabled: false, textContent: '', value: '', dataset: {}, style: {}, files: [], tabIndex: 0,
    addEventListener() {}, setAttribute() {}, appendChild() {}, append() {}, focus() {}, click() {},
    querySelectorAll: () => [],
  };
}

const elements = new Map();
const handlers = [];
const frame = { replies: [], posted: [] };
let store;
let plansAnswer;
let plansCalls = [];

before(async () => {
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: element,
    createElementNS: element,
  };
  globalThis.window = {
    addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); },
    scrollTo() {},
  };
  globalThis.location = { origin: ORIGIN };
  globalThis.localStorage = { getItem: () => 'map', setItem() {} };
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://raw.githubusercontent.com/')) {
      return new Response(JSON.stringify({ results_url: `${RELAY}/results` }));
    }
    if (String(url).endsWith('/plans')) {
      plansCalls.push(String(url));
      return plansAnswer();
    }
    return new Response(JSON.stringify({ ok: true, sim: null, recorded: null, recorded_updated: null, sim_is_latest: true }));
  };
  // No indexedDB here, so mapstore.js keeps everything in memory. The test shares that instance with maptab.js.
  store = await import('../mapstore.js');
  elements.set('map-frame', { ...element(), contentWindow: {
    ScourgeMap: { load() {}, planResult: (r) => frame.replies.push(r) },
    postMessage: (m) => frame.posted.push(m),
  } });
  await import('../maptab.js');
});

afterEach(() => {
  frame.replies.length = 0;
  frame.posted.length = 0;
  plansCalls = [];
});

function dispatch(event) {
  for (const fn of handlers) fn(event);
}

const frameWindow = () => elements.get('map-frame').contentWindow;
const planMessage = (id) => ({ source: frameWindow(), origin: ORIGIN, data: { type: 'scourge-plan-send', id, plan: PLAN } });
const flush = () => new Promise((resolve) => { setTimeout(resolve, 20); });

async function replyFor(event) {
  dispatch(event);
  for (let i = 0; i < 100 && frame.replies.length === 0; i += 1) await flush();
  return frame.replies[0];
}

test('a send from another window or origin is ignored', async () => {
  await store.saveCloud({ code: 'sekret-code', relay: RELAY });
  plansAnswer = () => new Response('{"ok":true,"issue":1}', { status: 201 });
  dispatch({ ...planMessage('x'), source: {} });
  dispatch({ ...planMessage('y'), origin: 'https://evil.example' });
  await flush();
  assert.equal(plansCalls.length, 0);
  assert.equal(frame.replies.length, 0);
  assert.equal((await store.loadCloud()).code, 'sekret-code');
});

test('a good send answers the page by its id and keeps the code', async () => {
  await store.saveCloud({ code: 'sekret-code', relay: RELAY });
  plansAnswer = () => new Response('{"ok":true,"issue":1}', { status: 201 });
  const reply = await replyFor(planMessage('good'));
  assert.deepEqual(reply, { id: 'good', ok: true, message: 'Sent as a proposed plan. No robot code changed.' });
  assert.equal((await store.loadCloud()).code, 'sekret-code');
});

test('a failed send keeps the code', async () => {
  await store.saveCloud({ code: 'sekret-code', relay: RELAY });
  plansAnswer = () => new Response('{"ok":false,"error":"GitHub answered 500"}', { status: 502 });
  const reply = await replyFor(planMessage('fail'));
  assert.equal(reply.ok, false);
  assert.equal((await store.loadCloud()).code, 'sekret-code');
});

test('a 401 clears the saved code and data, brings the code panel back, and says why', async () => {
  await store.saveCloud({ code: 'old-code', relay: RELAY, response: { sim: null }, fetched: 1 });
  elements.get('map-code-panel').hidden = true;
  plansAnswer = () => new Response('{"ok":false,"error":"wrong team code"}', { status: 401 });
  const text = 'The team code changed. Enter the new one, then send again.';
  const reply = await replyFor(planMessage('stale'));
  assert.deepEqual(reply, { id: 'stale', ok: false, message: text });
  assert.equal(await store.loadCloud(), null);
  assert.equal(elements.get('map-code-panel').hidden, false);
  assert.equal(elements.get('map-cloud').hidden, true);
  assert.equal(elements.get('map-code-hint').textContent, text);
  assert.equal(elements.get('map-code-hint').hidden, false);
});

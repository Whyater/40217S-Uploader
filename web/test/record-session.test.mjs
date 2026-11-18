import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, TEXT, pollUserFifo, usbUserPort, tallyLines, CONTROLLER_PRODUCT_ID } from '../record.js';
import { V5Error } from '../protocol/index.js';

const bytes = (s) => new TextEncoder().encode(s);

// A COBS packet the way the kernel frames a write (no zero bytes in these strings).
function packet(id, text) {
  const src = [...bytes(id + text)];
  const out = [];
  for (let i = 0; i < src.length; i += 254) {
    const block = src.slice(i, i + 254);
    out.push(block.length === 254 ? 0xff : block.length + 1, ...block);
  }
  return Uint8Array.from([...out, 0]);
}

// A port shaped like an opened Web Serial port. push() sends bytes, end() pulls the cable.
function fakePort() {
  let ctrl;
  const written = [];
  const port = {
    opened: false,
    closed: false,
    written,
    async open() { this.opened = true; },
    async close() { this.closed = true; },
    readable: new ReadableStream({ start(c) { ctrl = c; } }),
    writable: new WritableStream({ write(chunk) { written.push(...chunk); } }),
    push(b) { ctrl.enqueue(b); },
    end() { ctrl.close(); },
  };
  return port;
}

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

function recorder(storage = memStorage()) {
  const statuses = [];
  const lines = [];
  const progress = [];
  const r = new Recorder({
    storage,
    onStatus: (s) => statuses.push(s),
    onLine: (text, stream) => lines.push([stream, text]),
    onProgress: (t) => progress.push(t),
    timing: { quietMs: 30, saveMs: 5, flushMs: 5 },
  });
  return { r, statuses, lines, progress, storage };
}

const tick = () => new Promise((res) => setTimeout(res, 10));

function autopath(rows) {
  const out = [`SCOURGE,BEGIN,autopath,1;teach;L;${rows};Build 1,`];
  for (let i = 0; i < rows; i++) out.push(`SCOURGE,AP,${i},${i * 50};100;200;9000;0;10;20;0;0,`);
  out.push(`SCOURGE,END,autopath,${rows},`);
  return out;
}

test('a whole recording over the user port ends by itself and can be sent', async () => {
  const { r, statuses, lines, progress } = recorder();
  const port = fakePort();
  const done = r.start({ via: 'serial', product: 'brain', port });
  await tick();
  assert.deepEqual(port.written, [0x70, 0x52, 0x61], "asks the kernel for 'I'm alive!' once");
  port.push(packet('serr', "I'm alive!\n"));
  const wire = Uint8Array.from(autopath(45).flatMap((l) => [...packet('sout', `noise ${l}\r\n`)]));
  for (let i = 0; i < wire.length; i += 64) port.push(wire.slice(i, i + 64));
  const result = await done;
  assert.equal(result.kind, 'stopped');
  assert.equal(r.state, 'idle');
  assert.equal(r.file.lines.length, 47);
  assert.equal(r.file.lines[0], 'SCOURGE,BEGIN,autopath,1;teach;L;45;Build 1,');
  assert.equal(r.file.tally.last, 'full');
  assert.equal(statuses[0].text, TEXT.neutral);
  assert.ok(statuses.some((s) => s.text === 'Recording: 0 of 45 rows'));
  assert.equal(statuses.at(-1).text, TEXT.full);
  assert.equal(statuses.at(-1).kind, 'success');
  assert.ok(progress.length < 15, `row updates are thinned (${progress.length})`);
  assert.deepEqual(lines[0], ['serr', "I'm alive!"]);
  assert.ok(port.closed);
  assert.ok(r.canSend);
  assert.ok(r.csv.startsWith('kind,test,key,value,unit\nSCOURGE,BEGIN,autopath'));
});

test('Stop in the middle is cut off, and a cut-off retake keeps the earlier good file', async () => {
  const { r, statuses } = recorder();
  let port = fakePort();
  let done = r.start({ via: 'usb', product: 'brain', port });
  for (const l of autopath(4)) port.push(packet('sout', `${l}\n`));
  await done;
  const goodId = r.file.id;
  r.now = () => Date.now() + 5000; // a later file name

  port = fakePort();
  done = r.start({ via: 'usb', product: 'brain', port });
  for (const l of autopath(10).slice(0, 5)) port.push(packet('sout', `${l}\n`));
  await tick();
  r.stop();
  const result = await done;
  assert.equal(result.kind, 'stopped');
  assert.equal(r.file.id, goodId);
  assert.ok(statuses.some((s) => s.text === TEXT.stopping));
  assert.equal(statuses.at(-1).text, `${TEXT.cutOff} Send Results will use the earlier file, ${goodId}.`);
  assert.equal(statuses.at(-1).kind, 'error');
});

test('tester results say saved, a pulled cable is an error that keeps the data', async () => {
  const { r, statuses } = recorder();
  const port = fakePort();
  const done = r.start({ via: 'usb', product: 'brain', port });
  port.push(packet('sout', 'SCOURGE,BEGIN,drive,0,\nSCOURGE,drive,left,1.0,m\n'));
  await tick();
  assert.ok(statuses.some((s) => s.text === TEXT.tester));
  port.end();
  const result = await done;
  assert.equal(result.kind, 'error');
  assert.equal(statuses.at(-1).text, `Recording stopped: ${TEXT.dropped}`);
  assert.equal(r.file.tally.values, 1);
});

test('a stop with nothing recorded says so and leaves the sent lock alone', async () => {
  const { r, statuses } = recorder();
  r.file = { id: 'results-old', lines: autopath(2), tally: tallyLines(autopath(2)) };
  r.sentId = 'results-old';
  const port = fakePort();
  const done = r.start({ via: 'usb', product: 'brain', port });
  await tick();
  r.stop();
  await done;
  assert.equal(statuses.at(-1).text, `${TEXT.nothing} Send Results will use the earlier file, results-old.`);
  assert.equal(r.canSend, false);
});

test('a quiet port on a computer gets the pick-the-User-port hint', async () => {
  const { r, statuses } = recorder();
  const port = fakePort();
  const done = r.start({ via: 'serial', product: 'brain', port });
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(statuses.at(-1).text, TEXT.quiet);
  r.stop();
  await done;
});

test('results survive a reload, and a recording cut by a closed page is kept', async () => {
  const storage = memStorage();
  const { r } = recorder(storage);
  const port = fakePort();
  const done = r.start({ via: 'usb', product: 'brain', port });
  for (const l of autopath(3)) port.push(packet('sout', `${l}\n`));
  await done;
  const again = recorder(storage).r;
  again.load();
  assert.deepEqual(again.file.lines, r.file.lines);
  assert.equal(again.file.tally.last, 'full');

  // Mid-recording save, then the page goes away before Stop.
  const p2 = fakePort();
  const third = recorder(storage).r;
  third.load();
  third.start({ via: 'usb', product: 'brain', port: p2 });
  p2.push(packet('sout', 'SCOURGE,drive,left,1.0,m\n'));
  await new Promise((res) => setTimeout(res, 30));
  const after = recorder(storage).r;
  after.load();
  assert.deepEqual(after.file.lines, ['SCOURGE,drive,left,1.0,m'], 'tester data takes over from the earlier file');
  third.stop();
});

test('Send Results: guards, the lock after a send, and the team code unlock', async () => {
  const { r, statuses } = recorder();
  await r.send({ version: '1' });
  assert.equal(statuses.at(-1).text, TEXT.noResults);

  const port = fakePort();
  const done = r.start({ via: 'usb', product: 'brain', port });
  await r.send({ version: '1' });
  assert.equal(statuses.at(-1).text, TEXT.stopFirst);
  for (const l of autopath(2)) port.push(packet('sout', `${l}\n`));
  await done;

  let posts = 0;
  const fetchFn = async (url, init) => {
    if (init.method !== 'POST') return new Response(JSON.stringify({ results_url: 'https://relay.example/results' }));
    posts += 1;
    return new Response('{"ok":true,"issues":[3],"on_map":false}', { status: 201 });
  };
  await r.send({ version: '1', fetchFn });
  assert.ok(statuses.some((s) => s.text === TEXT.sending));
  assert.equal(statuses.at(-1).text, TEXT.sentNoMap);
  await r.send({ version: '1', fetchFn });
  assert.equal(statuses.at(-1).text, TEXT.alreadySent);
  assert.equal(posts, 1);
  r.teamCodeSaved('   ');
  assert.equal(r.canSend, false);
  r.teamCodeSaved('the-code');
  assert.equal(r.canSend, true);
});

test('controller: the user FIFO is polled, the first reply byte dropped', async () => {
  const replies = [Uint8Array.of(1, ...packet('sout', 'SCOURGE,drive,left,1.0,m\n')), Uint8Array.of(1)];
  const asked = [];
  let stop = false;
  const got = [];
  const dev = {
    async txrxExt(cmd, payload, rx, opts) {
      asked.push([cmd, [...payload], opts.checkLength]);
      const r = replies.shift();
      if (!r) { stop = true; return Uint8Array.of(1); }
      return r;
    },
  };
  await pollUserFifo(dev, { onBytes: (b) => got.push(...b), stopped: () => stop, idleMs: 1 });
  assert.deepEqual(asked[0], [0x27, [1, 0x40], false]);
  assert.deepEqual(got, [...packet('sout', 'SCOURGE,drive,left,1.0,m\n')]);
});

test('controller: a closed port ends polling, a few bad replies are retried', async () => {
  let n = 0;
  const flaky = { async txrxExt() { n += 1; if (n < 3) throw new V5Error('BAD_RESPONSE', 'x'); return Uint8Array.of(1); } };
  let calls = 0;
  await pollUserFifo(flaky, { onBytes() {}, stopped: () => ++calls > 4, idleMs: 1 });
  assert.ok(n >= 3);
  const closed = { async txrxExt() { throw new V5Error('PORT_CLOSED', 'gone'); } };
  await assert.rejects(pollUserFifo(closed, { onBytes() {}, stopped: () => false }), (e) => e.code === 'PORT_CLOSED');
});

test('WebUSB: a brain uses its second CDC pair, a controller its only one', () => {
  const ep = (n, d) => ({ endpointNumber: n, direction: d });
  const iface = (num, cls, eps = []) => ({ interfaceNumber: num, alternates: [{ interfaceClass: cls, endpoints: eps }] });
  const brain = {
    productId: 0x0501,
    configurations: [{ interfaces: [iface(0, 2), iface(1, 10, [ep(1, 'in'), ep(1, 'out')]), iface(2, 2), iface(3, 10, [ep(2, 'in'), ep(3, 'out')])] }],
  };
  class StubPort { constructor(d) { this.device_ = d; this.controlInterface_ = d.configurations[0].interfaces[0]; } }
  const p = usbUserPort(brain, StubPort);
  assert.equal(p.controlInterface_.interfaceNumber, 2);
  assert.equal(p.transferInterface_.interfaceNumber, 3);
  assert.equal(p.inEndpoint_.endpointNumber, 2);
  assert.equal(p.outEndpoint_.endpointNumber, 3);
  const one = { productId: 0x0501, configurations: [{ interfaces: [iface(0, 2), iface(1, 10, [ep(1, 'in'), ep(1, 'out')])] }] };
  assert.throws(() => usbUserPort(one, StubPort), { message: TEXT.noUserPort });
  const ctrl = { productId: CONTROLLER_PRODUCT_ID, configurations: one.configurations };
  assert.equal(usbUserPort(ctrl, StubPort).controlInterface_.interfaceNumber, 0);
});

// End-to-end tests against a scripted fake brain (test/protocol/helpers.js).
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { test } from 'node:test';

import { V5Error } from '../../protocol/errors.js';
import { coldHashName } from '../../protocol/program.js';
import { queryBrain, uploadProgram } from '../../protocol/upload.js';
import { fakeBrain } from './helpers.js';

const fast = { readTimeoutMs: 100 };

function bytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

const order = (brain) => brain.packets.map((p) => p.cmd);

test('monolith upload: command order, chunking, file contents (default gzip)', async () => {
  const brain = fakeBrain({ maxPacket: 512 });
  const bin = bytes(5000);
  const progress = [];
  const r = await uploadProgram(brain.port, {
    bin, slot: 2, name: 'Scourge@Comp', runAfter: 'screen', ideVersion: '4.2.2', ...fast,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(r.name, 'Scourge_Comp');

  const seq = order(brain);
  const nWrites = Math.ceil(brain.files['1/slot_2.bin'].length / 256);
  assert.deepEqual(seq, [
    'A4', 'A4', '22', '18',
    'A4', '11', '13', '12',
    'A4', '11', ...Array(nWrites).fill('13'), '12',
  ]);

  const binFile = brain.files['1/slot_2.bin'];
  assert.equal(binFile.type, 'bin');
  assert.equal(binFile.addr, 0x03800000);
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(binFile.data)), bin, 'brain received the gzipped program');
  binFile.writes.forEach((w, i) => {
    assert.equal(w.addr, 0x03800000 + i * 256, 'consecutive addresses');
    assert.equal(w.size % 4, 0, 'padded to 4 bytes');
    if (i < binFile.writes.length - 1) assert.equal(w.size, 256, 'half of max_packet_size');
  });
  assert.equal(brain.packets.at(-1).option, 3, 'run screen');

  const ini = Buffer.from(brain.files['1/slot_2.ini'].data).toString('ascii');
  assert.match(ini, /^\[project\]\nversion = 4\.2\.2\nide = PROS\n\n\[program\]\nversion = 0\.0\.0\nname = Scourge_Comp\nslot = 1\nicon = USER902x\.bmp\ndescription = Made with PROS\ndate = \d{4}-\d\d-\d\dT[\d:.]+\n\n$/);
  assert.equal(progress[0].stage, 'connect');
  assert.equal(progress.at(-1).stage, 'done');
  assert.equal(brain.port.readable.locked, false, 'reader lock released');
  assert.equal(brain.port.writable.locked, false, 'writer lock released');
});

test('hot/cold upload: library to vid 24, link set on the hot file, hot at 0x07800000', async () => {
  const brain = fakeBrain({ maxPacket: 1024 });
  const hot = bytes(3000, 2);
  const cold = bytes(9000, 3);
  const r = await uploadProgram(brain.port, {
    bin: hot, coldBin: cold, coldTemplates: ['LemLib', 'kernel'], slot: 1, name: '40217S', ...fast,
  });
  const name = coldHashName(['LemLib', 'kernel'], '1.1.5-0');
  assert.equal(r.linkedName, name);
  const lib = brain.files[`24/${name}`];
  assert.ok(lib, 'library uploaded');
  assert.equal(lib.addr, 0x03800000);
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(lib.data)), cold);
  const hotFile = brain.files['1/slot_1.bin'];
  assert.equal(hotFile.addr, 0x07800000);
  assert.deepEqual(hotFile.link, { vid: 24, name });
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(hotFile.data)), hot);
  assert.equal(brain.files['1/slot_1.ini'].addr, 0x07800000, 'pros-cli sends the ini to the hot address too');
  // 0x19 lookup NACKs (not on brain) 4 times, then directory scans, then the library upload.
  assert.deepEqual(order(brain).slice(0, 9), ['A4', '22', 'A4', '19', '19', '19', '19', '16', '16']);
  assert.equal(brain.packets.at(-1).option, 0, 'runAfter defaults to none');
});

test('a single NACK is retried and the upload still succeeds', async () => {
  const brain = fakeBrain({ nack: { 0x13: [0xce] } });
  await uploadProgram(brain.port, { bin: bytes(700), slot: 1, name: 'x', ...fast });
  const writes = brain.packets.filter((p) => p.cmd === '13');
  assert.deepEqual(new Uint8Array(writes[0].payload), new Uint8Array(writes[1].payload), 'same chunk resent');
});

test('a persistent NACK fails with a readable error after 4 tries', async () => {
  const brain = fakeBrain({ nack: { 0x13: [0xd2, 0xd2, 0xd2, 0xd2] } });
  await assert.rejects(
    uploadProgram(brain.port, { bin: bytes(700), slot: 1, name: 'x', ...fast }),
    (e) => {
      assert.ok(e instanceof V5Error);
      assert.equal(e.code, 'NACK');
      assert.equal(e.message, 'The brain refused the request (Program CRC error).');
      assert.equal(e.detail.nack, 0xd2);
      return true;
    },
  );
  assert.equal(brain.packets.filter((p) => p.cmd === '13').length, 4);
  assert.equal(brain.port.readable.locked, false);
});

test('no answer at all (wrong port): NO_RESPONSE with the cable/port hint', async () => {
  const brain = fakeBrain({ silent: true });
  const t0 = Date.now();
  await assert.rejects(queryBrain(brain.port, fast), (e) => {
    assert.equal(e.code, 'NO_RESPONSE');
    assert.match(e.message, /didn't answer/);
    assert.match(e.message, /not the controller/);
    return true;
  });
  assert.equal(brain.packets.length, 4, '0xA4 tried 4 times like pros-cli');
  assert.ok(Date.now() - t0 < 3000);
});

test('brain goes quiet mid-upload: NO_RESPONSE, not a hang', async () => {
  const brain = fakeBrain({ silentAfter: 7 });
  await assert.rejects(
    uploadProgram(brain.port, { bin: bytes(3000), slot: 1, name: 'x', ...fast }),
    (e) => e.code === 'NO_RESPONSE',
  );
});

test('queryBrain returns version and status', async () => {
  const brain = fakeBrain();
  const info = await queryBrain(brain.port, fast);
  assert.equal(info.systemVersion, '1.1.5-0.13');
  assert.equal(info.productName, 'BRAIN');
  assert.equal(info.wireless, false);
  assert.equal(info.status.cpu0Version, '1.1.5-0');
});

test('controller not linked to a brain', async () => {
  const brain = fakeBrain({ product: 0x11, flags: 0 });
  await assert.rejects(queryBrain(brain.port, fast), (e) => e.code === 'CONTROLLER_NOT_LINKED');
  const brain2 = fakeBrain({ product: 0x11, flags: 0 });
  await assert.rejects(uploadProgram(brain2.port, { bin: bytes(10), slot: 1, name: 'x', ...fast }),
    (e) => e.code === 'CONTROLLER_NOT_LINKED');
});

test('something answers but is not a V5', async () => {
  const brain = fakeBrain({ product: 0x42 });
  await assert.rejects(queryBrain(brain.port, fast), (e) => e.code === 'NOT_V5');
});

test('bad input is rejected before touching the port', async () => {
  const brain = fakeBrain();
  await assert.rejects(uploadProgram(brain.port, { bin: bytes(10), slot: 9, name: 'x' }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(uploadProgram(brain.port, { bin: bytes(10), slot: 1, name: 'é' }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(uploadProgram(brain.port, { bin: bytes(10), coldBin: bytes(10), slot: 1, name: 'x' }),
    (e) => e.code === 'BAD_INPUT');
  await assert.rejects(uploadProgram(brain.port, { bin: bytes(10), slot: 1, name: 'x', description: '100%' }),
    (e) => e.code === 'BAD_INPUT');
  assert.equal(brain.packets.length, 0);
});

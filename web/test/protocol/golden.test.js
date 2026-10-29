// Golden tests: the JS must produce the same bytes as pros-cli 3.5.6.
// Fixtures come from test/protocol/gen_fixtures.py (run against the real pros-cli source).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SerialConnection } from '../../protocol/connection.js';
import { VEX_CRC16, VEX_CRC32 } from '../../protocol/crc.js';
import { V5Device } from '../../protocol/device.js';
import { FT_COMPLETE } from '../../protocol/framing.js';
import { md5 } from '../../protocol/md5.js';
import { coldHashName, generateIni, prosGzip, versionMatches } from '../../protocol/program.js';
import { uploadProgram } from '../../protocol/upload.js';
import { hex, replayPort, unhex } from './helpers.js';

const G = JSON.parse(readFileSync(new URL('./fixtures/pros_golden.json', import.meta.url), 'utf8'));
// Python's FIXED_NOW is a naive local datetime; build the same local wall time in JS.
const FIXED_NOW = new Date(2026, 9, 28, 17, 34, 56, 789);
const fast = { readTimeoutMs: 300 };

function lcg(n, seed) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

test('CRC16 and CRC32 match pros-cli', () => {
  for (const c of G.crc) {
    const d = unhex(c.data);
    assert.equal(VEX_CRC16.compute(d), c.crc16, `crc16 of ${c.data.slice(0, 20)}`);
    assert.equal(VEX_CRC32.compute(d), c.crc32, `crc32 of ${c.data.slice(0, 20)}`);
  }
});

test('md5 matches node:crypto', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const d = lcg(n, n + 1);
    assert.equal(hex(md5(d)), createHash('md5').update(d).digest('hex'), `length ${n}`);
  }
});

test('lcg test data matches the Python generator', () => {
  assert.equal(G.crc[3].data, hex(lcg(1000, 7)));
});

async function withReplay(fixture, fn) {
  const log = fixture.tx.map((tx, i) => ({ tx, rx: fixture.rx[i] }));
  const { port, state } = replayPort(log);
  const conn = new SerialConnection(port, fast);
  const dev = new V5Device(conn, { now: () => FIXED_NOW });
  try {
    const result = await fn(dev);
    return { result, state };
  } finally {
    await conn.close();
  }
}

const PACKET_CASES = {
  query_system_version: (d) => d.querySystemVersion(),
  get_system_status: (d) => d.getSystemStatus(),
  ft_initialize_upload_bin: (d) => d.ftInitialize('slot_1.bin', { function: 'upload', length: 1234, crc: 0xdeadbeef, type: 'bin', addr: 0x03800000 }),
  ft_initialize_upload_ini_pros_vid: (d) => d.ftInitialize('slot_8.ini', { function: 'upload', length: 150, crc: 0x01020304, type: 'ini', vid: 'pros', addr: 0x07800000 }),
  ft_write_aligned: (d) => d.ftWrite(0x03800000, lcg(16, 3)),
  ft_write_unaligned: (d) => d.ftWrite(0x03800100, lcg(13, 4)),
  ft_write_extended_len: (d) => d.ftWrite(0x07800000, lcg(256, 5)),
  ft_complete_dont_run: (d) => d.ftComplete(FT_COMPLETE.none),
  ft_complete_run: (d) => d.ftComplete(FT_COMPLETE.run),
  ft_complete_screen: (d) => d.ftComplete(FT_COMPLETE.screen),
  ft_set_link: (d) => d.ftSetLink('gL/Ne2a7Ify0POC/O3642Q', 'pros'),
  execute_program_stop: (d) => d.executeProgramFile('', { run: false }),
  ft_transfer_channel_download: (d) => d.ftTransferChannel('download'),
  get_dir_count_pros: (d) => d.getDirCount('pros'),
  erase_file_all: (d) => d.eraseFile('slot_2.bin', { eraseAll: true, vid: 'user' }),
};

test('every golden packet fixture has a JS case', () => {
  assert.deepEqual(Object.keys(G.packets).sort(), Object.keys(PACKET_CASES).sort());
});

for (const [name, fn] of Object.entries(PACKET_CASES)) {
  test(`packet bytes: ${name}`, async () => {
    const fx = G.packets[name];
    const { result, state } = await withReplay(fx, fn);
    assert.deepEqual(state.mismatches, []);
    assert.deepEqual(state.extra, []);
    assert.equal(state.index, fx.tx.length);
    if (name === 'query_system_version') assert.equal(result.systemVersion, fx.result);
    if (name === 'get_system_status') {
      assert.equal(result.systemVersion, fx.result.system_version);
      assert.equal(result.cpu0Version, fx.result.cpu0_version);
      assert.equal(String(result.systemId), fx.result.system_id);
      assert.equal(String(result.touchVersion), fx.result.touch_version);
    }
    if (name.startsWith('ft_initialize')) {
      assert.deepEqual(result, { maxPacketSize: fx.result.max_packet_size, fileSize: fx.result.file_size, crc: fx.result.crc });
    }
    if (name === 'get_dir_count_pros') assert.equal(result, fx.result);
  });
}

test('ini text matches pros-cli generate_ini_file', () => {
  for (const c of G.ini) {
    const [datePart, timePart] = c.now.split('T');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [h, mi, sFrac] = timePart.split(':');
    const [s, frac = '0'] = sFrac.split('.');
    const date = new Date(y, mo - 1, d, +h, +mi, +s, Math.round(+frac.padEnd(6, '0') / 1000));
    const ini = generateIni({
      name: c.kwargs.remote_name, slot: c.kwargs.slot, ide: c.kwargs.ide, ideVersion: c.kwargs.ide_version,
      icon: c.kwargs.icon, description: c.kwargs.description, date, cpu0Version: '1.1.5-0',
    });
    assert.equal(ini, c.ini, c.label);
  }
});

test('cold library name matches pros-cli generate_cold_hash', () => {
  for (const c of G.coldHash) {
    const cpu0 = c.cpu0 === 'new' ? '1.1.5-0' : '1.0.0-27';
    assert.equal(coldHashName(c.templates, cpu0), c.name, `${c.templates} ${c.cpu0}`);
  }
});

test('version specs behave like semantic_version 2.10', () => {
  // Expected values were checked against the Python library.
  assert.equal(versionMatches('1.1.5-0', '>=', '1.0.5'), true);
  assert.equal(versionMatches('1.0.5-0', '>=', '1.0.5'), false);
  assert.equal(versionMatches('1.0.13-0', '<', '1.0.13'), false);
  assert.equal(versionMatches('1.0.12-99', '<', '1.0.13'), true);
  assert.equal(versionMatches('1.0.0-21', '>=', '1.0.0-22'), false);
  assert.equal(versionMatches('1.0.0-27', '<=', '1.0.0-27'), true);
  assert.equal(versionMatches('1.0.0-28', '<=', '1.0.0-27'), false);
  assert.equal(versionMatches('1.0.0-0.69', '<', '1.0.0-0.70'), true);
});

test('default gzip is byte-identical to pros-cli gzip (Python 3.10 header, XFL 02, level 9)', () => {
  for (const g of G.gzip) {
    assert.equal(g.gz.slice(0, 20), '1f8b08000000000002ff', 'fixture header is the Python 3.10 one');
    assert.equal(hex(prosGzip(unhex(g.data))), g.gz);
  }
});

for (const flow of G.flows) {
  test(`full upload flow replay: ${flow.label}`, { timeout: 60000 }, async () => {
    const { port, state } = replayPort(flow.log);
    const o = flow.options;
    const erased = [];
    const result = await uploadProgram(port, {
      onProgress: (p) => { if (p.stage === 'erased') erased.push(...p.programs); },
      bin: unhex(flow.bin),
      coldBin: flow.coldBin ? unhex(flow.coldBin) : undefined,
      coldTemplates: o.coldTemplates,
      slot: o.slot, name: o.name, description: o.description, runAfter: o.runAfter, compress: o.compress,
      now: () => FIXED_NOW, ...fast,
    });
    assert.deepEqual(state.mismatches, [], 'first differing packet');
    assert.deepEqual(state.extra, [], 'packets PROS did not send');
    assert.equal(state.index, flow.log.length, 'all PROS packets sent');
    if (flow.coldName) assert.equal(result.linkedName, flow.coldName);
    // Every program erase PROS sent (0x56 0x1B with vid 1 = user) must be reported to the app.
    const userErases = flow.log.filter(({ tx }) => {
      const b = unhex(tx);
      if (b[4] !== 0x56 || b[5] !== 0x1b) return false;
      const off = b[6] & 0x80 ? 8 : 7;
      return b[off] === 1;
    }).length;
    assert.equal(erased.length, userErases, 'erased programs reported');
  });
}

test('negative control: a one-character change in the ini breaks the replay', async () => {
  const flow = G.flows.find((f) => f.label === 'monolith_slot1');
  const { port, state } = replayPort(flow.log);
  await assert.rejects(
    uploadProgram(port, {
      bin: unhex(flow.bin), slot: 1, name: '40217S', description: 'Made with PROs',
      now: () => FIXED_NOW, retries: 0, readTimeoutMs: 100,
    }),
    (e) => e.code === 'NO_RESPONSE',
  );
  assert.equal(state.mismatches.length, 1);
});

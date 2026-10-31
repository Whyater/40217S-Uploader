import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readTab, fileKind, cleanName, formatBytes, totalBytes, checkText, planAdd,
  buildInput, summaryText, acceptHeight, MAX_BYTES,
} from '../mapdata.js';

const CSV = 'kind,test,key,value,unit\nSCOURGE,teach,count,1,\n';
const JSON_OK = JSON.stringify({ routes: [], sessions: [] });
const file = (name, text, size = Buffer.byteLength(text)) => ({ name, size, read: async () => text });

test('readTab keeps a known tab and falls back to Upload', () => {
  assert.equal(readTab('map'), 'map');
  assert.equal(readTab('upload'), 'upload');
  assert.equal(readTab('Map'), 'upload');
  assert.equal(readTab(null), 'upload');
  assert.equal(readTab('<script>'), 'upload');
});

test('fileKind goes by extension only', () => {
  assert.equal(fileKind('results-1.csv'), 'csv');
  assert.equal(fileKind('MAP-DATA.JSON'), 'json');
  assert.equal(fileKind('notes.txt'), null);
  assert.equal(fileKind('csv'), null);
  assert.equal(fileKind(undefined), null);
});

test('cleanName drops folders and control characters and shortens', () => {
  assert.equal(cleanName('C:\\Users\\me\\results-1.csv'), 'results-1.csv');
  assert.equal(cleanName('../../etc/results.csv'), 'results.csv');
  assert.equal(cleanName('a\u0000b\nc.csv'), 'abc.csv');
  const long = cleanName('x'.repeat(300) + '.csv');
  assert.ok(long.length <= 80);
  assert.ok(long.endsWith('.csv'));
  assert.equal(cleanName(null), '');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(50 * 1024), '50 KB');
  assert.equal(formatBytes(20 * 1024 * 1024), '20.0 MB');
});

test('checkText accepts a results file and route data', () => {
  assert.deepEqual(checkText('csv', 'a.csv', CSV), { ok: true });
  assert.deepEqual(checkText('csv', 'a.csv', 'junk\r\nSCOURGE,x,y,1,\r\n'), { ok: true });
  assert.deepEqual(checkText('json', 'm.json', JSON_OK), { ok: true });
});

test('checkText refuses bad files with a polite sentence', () => {
  for (const [kind, text] of [['csv', ''], ['csv', 'a,b,c\n1,2,3\n'], ['csv', 'SCOURGE,\u0000'],
    ['json', '{not json'], ['json', '[]'], ['json', 'null'], ['json', '{"hello":1}'], ['json', '']]) {
    const r = checkText(kind, 'f.' + kind, text);
    assert.equal(r.ok, false, `${kind}: ${JSON.stringify(text)}`);
    assert.match(r.error, /^f\.(csv|json) /);
    assert.ok(!/[<>]/.test(r.error));
  }
});

test('a JSON parse error never echoes the file text', () => {
  const r = checkText('json', 'm.json', '<img src=x onerror=alert(1)>');
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes('onerror'));
});

test('planAdd keeps good files and explains the rest', async () => {
  const { accepted, rejected } = await planAdd([], [
    file('a.csv', CSV), file('notes.txt', 'hi'), file('bad.json', '{oops'), file('m.json', JSON_OK),
  ]);
  assert.deepEqual(accepted.map((a) => [a.name, a.kind, a.replaced]), [['a.csv', 'csv', false], ['m.json', 'json', false]]);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /Only results .csv files/);
  assert.match(rejected[1].reason, /not valid JSON/);
});

test('planAdd enforces the 20 MB cap across stored and new files', async () => {
  const existing = [{ name: 'big.csv', kind: 'csv', size: MAX_BYTES - 100 }];
  let reads = 0;
  const f = { name: 'new.csv', size: 101, read: async () => { reads += 1; return CSV; } };
  const r = await planAdd(existing, [f]);
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].reason, /up to 20\.0 MB/);
  assert.equal(reads, 0, 'a refused file is not read into memory');

  const ok = await planAdd(existing, [{ name: 'new.csv', size: 100, read: async () => CSV }]);
  assert.equal(ok.accepted.length, 1);
});

test('planAdd refuses one file over the cap by itself', async () => {
  const r = await planAdd([], [{ name: 'huge.csv', size: MAX_BYTES + 1, read: async () => CSV }]);
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].reason, /over the 20\.0 MB/);
});

test('planAdd lets a same-name file replace the old one and frees its space', async () => {
  const existing = [{ name: 'a.csv', kind: 'csv', size: MAX_BYTES }];
  const r = await planAdd(existing, [file('a.csv', CSV)]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].replaced, true);
});

test('planAdd counts files in the same batch against the cap', async () => {
  const half = MAX_BYTES / 2 + 1;
  const r = await planAdd([], [file('a.csv', CSV, half), file('b.csv', CSV, half)]);
  assert.deepEqual(r.accepted.map((a) => a.name), ['a.csv']);
  assert.equal(r.rejected.length, 1);
});

test('planAdd reports a file that cannot be read', async () => {
  const r = await planAdd([], [{ name: 'a.csv', size: 5, read: async () => { throw new Error('nope'); } }]);
  assert.match(r.rejected[0].reason, /could not be read/);
});

test('buildInput passes csv files and the newest route data', () => {
  const records = [
    { name: 'results-b.csv', kind: 'csv', size: 1, text: CSV, added: 1 },
    { name: 'results-a.csv', kind: 'csv', size: 1, text: CSV, added: 2 },
    { name: 'old.json', kind: 'json', size: 1, text: '{"routes":[{"slot":"old"}]}', added: 5 },
    { name: 'map-data.json', kind: 'json', size: 1, text: '{"routes":[{"slot":"new"}]}', added: 9 },
  ];
  const input = buildInput(records);
  assert.deepEqual(input.csvTexts.map((c) => c.name), ['results-a.csv', 'results-b.csv']);
  assert.equal(input.mapData.routes[0].slot, 'new');
  assert.equal(input.note, 'Route data from map-data.json');
});

test('buildInput with only csv files has no route data', () => {
  const input = buildInput([{ name: 'a.csv', kind: 'csv', size: 1, text: CSV, added: 1 }]);
  assert.equal(input.mapData, null);
  assert.equal('note' in input, false);
});

test('buildInput skips a stored json file that no longer parses', () => {
  const input = buildInput([{ name: 'm.json', kind: 'json', size: 1, text: '{', added: 1 }]);
  assert.equal(input.mapData, null);
});

test('summaryText', () => {
  assert.equal(summaryText([{ size: 1024 }]), '1 file, 1.0 KB of 20.0 MB');
  assert.equal(summaryText([{ size: 1024 }, { size: 1024 }]), '2 files, 2.0 KB of 20.0 MB');
  assert.equal(totalBytes([{ size: 3 }, { size: 4 }]), 7);
});

test('acceptHeight trusts only our own origin and frame', () => {
  const frame = {};
  const origin = 'https://whyater.github.io';
  const good = { origin, source: frame, data: { type: 'scourge-map', height: 812.4 } };
  assert.equal(acceptHeight(good, frame, origin), 812);
  assert.equal(acceptHeight({ ...good, origin: 'https://evil.example' }, frame, origin), null);
  assert.equal(acceptHeight({ ...good, source: {} }, frame, origin), null);
  assert.equal(acceptHeight({ ...good, data: { type: 'other', height: 500 } }, frame, origin), null);
  assert.equal(acceptHeight({ ...good, data: { type: 'scourge-map', height: 'tall' } }, frame, origin), null);
  assert.equal(acceptHeight({ ...good, data: { type: 'scourge-map', height: -5 } }, frame, origin), null);
  assert.equal(acceptHeight({ ...good, data: null }, frame, origin), null);
});

test('acceptHeight clamps absurd sizes', () => {
  const frame = {};
  const o = 'https://x';
  const msg = (height) => ({ origin: o, source: frame, data: { type: 'scourge-map', height } });
  assert.equal(acceptHeight(msg(10), frame, o), 240);
  assert.equal(acceptHeight(msg(1e9), frame, o), 20000);
});

// The simulated shape from the route sync contract.
const SIM = { schema: 1, tag: 'build-70-abc1234', build: 70, routes: [{ id: 'awp-L', slot: null, name: 'AWP', side: 'L', total_ms: 14800, samples: [{ t: 0, x: -52.1, y: -18.0, h: 90.0 }], events: [] }] };

test('buildInput always carries simulated, null when there is none', () => {
  assert.equal(buildInput([]).simulated, null);
  assert.equal(buildInput([], { simulated: undefined }).simulated, null);
  assert.equal(buildInput([], { simulated: [] }).simulated, null);
  assert.deepEqual(buildInput([], {}).csvTexts, []);
});

test('buildInput passes simulated, the downloaded recording, and hand-added results together', () => {
  const rec = { generated: '2026-10-30T23:00:00Z', routes: [{ slot: 'cloud' }], sessions: [] };
  const input = buildInput([{ name: 'a.csv', kind: 'csv', size: 1, text: CSV, added: 1 }], { simulated: SIM, recorded: rec });
  assert.equal(input.simulated, SIM);
  assert.equal(input.mapData, rec);
  assert.deepEqual(input.csvTexts.map((c) => c.name), ['a.csv']);
  assert.equal('note' in input, false);
});

test('buildInput with a downloaded recording only has no mapData when the recording is missing', () => {
  assert.equal(buildInput([], { simulated: SIM, recorded: null }).mapData, null);
});

test('buildInput takes whichever route data is newer, hand-added or downloaded', () => {
  const rec = { generated: '2026-10-30T23:00:00Z', routes: [{ slot: 'cloud' }] };
  const older = { name: 'm.json', kind: 'json', size: 1, text: '{"generated":"2026-10-29T00:00:00Z","routes":[{"slot":"hand"}]}', added: 9 };
  const newer = { name: 'm.json', kind: 'json', size: 1, text: '{"generated":"2026-10-31T00:00:00Z","routes":[{"slot":"hand"}]}', added: 1 };
  assert.equal(buildInput([older], { recorded: rec }).mapData.routes[0].slot, 'cloud');
  assert.equal(buildInput([newer], { recorded: rec }).mapData.routes[0].slot, 'hand');
  // no date inside the file: the time it was added to this device counts
  const undated = { name: 'm.json', kind: 'json', size: 1, text: '{"routes":[{"slot":"hand"}]}', added: Date.parse('2026-11-01') };
  assert.equal(buildInput([undated], { recorded: rec }).mapData.routes[0].slot, 'hand');
  // a recording with no date falls back to recorded_updated
  const undatedRec = { routes: [{ slot: 'cloud' }] };
  assert.equal(buildInput([older], { recorded: undatedRec, recordedUpdated: '2026-11-02T00:00:00Z' }).mapData.routes[0].slot, 'cloud');
});

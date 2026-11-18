import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cobsDecode, UserStreamDecoder, TextLines, scourgeLine, ResultsTally, tallyLines, buildCsv, dataLines,
  sendable, canSendFile, buildSubmission, sendResults, TEXT, RESULTS_HEADER,
} from '../record.js';
import { MANIFEST_URL } from '../mapcloud.js';

const bytes = (s) => new TextEncoder().encode(s);
const hex = (b) => Buffer.from(b).toString('hex');

// The kernel's cobs_encode (src/common/cobs.c) written out again: a 4-byte stream id, then the data.
function kernelPacket(id, data) {
  const src = [...bytes(id), ...(typeof data === 'string' ? bytes(data) : data)];
  const out = [0];
  let codeIdx = 0;
  let code = 1;
  for (const b of src) {
    if (b === 0) { out[codeIdx] = code; code = 1; codeIdx = out.length; out.push(0); continue; }
    out.push(b);
    code += 1;
    if (code === 0xff) { out[codeIdx] = code; code = 1; codeIdx = out.length; out.push(0); }
  }
  out[codeIdx] = code;
  return Uint8Array.from([...out, 0]);
}

/* ---------- COBS ---------- */

test('COBS: hand-worked packets decode', () => {
  // "sout" + "hi\n" has no zero: one block of 7 bytes, code 8.
  assert.equal(hex(kernelPacket('sout', 'hi\n')), '08736f757468690a00');
  assert.deepEqual([...cobsDecode(Uint8Array.from([0x08, 0x73, 0x6f, 0x75, 0x74, 0x68, 0x69, 0x0a]))], [...bytes('southi\n')]);
  // A zero inside: "sout" A 0 B -> 06 s o u t A | 02 B
  assert.equal(hex(kernelPacket('sout', [0x41, 0, 0x42])), '06736f75744102420' + '0');
  assert.deepEqual([...cobsDecode(Uint8Array.from([0x06, 0x73, 0x6f, 0x75, 0x74, 0x41, 0x02, 0x42]))], [0x73, 0x6f, 0x75, 0x74, 0x41, 0, 0x42]);
});

test('COBS: a 254-byte run (code 0xff) and longer runs round-trip', () => {
  for (const n of [250, 251, 252, 300, 600]) {
    const data = 'x'.repeat(n);
    const pkt = kernelPacket('sout', data);
    assert.equal(pkt.indexOf(0), pkt.length - 1, 'only the delimiter is zero');
    const out = cobsDecode(pkt.slice(0, -1));
    assert.equal(new TextDecoder().decode(out), `sout${data}`, `n=${n}`);
  }
});

test('COBS: damaged packets are refused', () => {
  assert.equal(cobsDecode(Uint8Array.from([0x05, 0x73, 0x6f])), null, 'block runs past the end');
  assert.equal(cobsDecode(Uint8Array.from([0x03, 0x00, 0x6f])), null, 'zero inside');
});

/* ---------- the user port stream ---------- */

test('decoder: COBS packets split across USB reads come out whole, per stream', () => {
  const wire = Uint8Array.from([...kernelPacket('sout', 'SCOURGE,drive,left,1.0,m\n'), ...kernelPacket('serr', "I'm alive!\n")]);
  const d = new UserStreamDecoder();
  const got = [];
  for (let i = 0; i < wire.length; i += 5) got.push(...d.push(wire.slice(i, i + 5)));
  assert.equal(d.mode, 'cobs');
  assert.deepEqual(got.map((g) => [g.stream, new TextDecoder().decode(g.data)]),
    [['sout', 'SCOURGE,drive,left,1.0,m\n'], ['serr', "I'm alive!\n"]]);
});

test('decoder: a packet cut off when the cable went in is dropped, the next one is read', () => {
  const second = kernelPacket('sout', 'SCOURGE,HELLO,tester,1,\n');
  const partial = kernelPacket('sout', 'lost text here\n').slice(6);
  const d = new UserStreamDecoder();
  const got = d.push(Uint8Array.from([...partial, ...second]));
  assert.equal(got.length, 1);
  assert.equal(new TextDecoder().decode(got[0].data), 'SCOURGE,HELLO,tester,1,\n');
  assert.equal(d.bad, 1);
});

test('decoder: plain text with no COBS framing is still read', () => {
  const d = new UserStreamDecoder({ plainAfter: 64 });
  const text = 'SCOURGE,drive,left,1.0,m\r\nSCOURGE,drive,right,2.0,m\r\nmore text to pass the limit\n';
  const got = d.push(bytes(text));
  assert.equal(d.mode, 'plain');
  assert.equal(got.map((g) => new TextDecoder().decode(g.data)).join(''), text);
  assert.equal(got[0].stream, '');
  const after = d.push(bytes('SCOURGE,turn,error,0.5,deg\n'));
  assert.equal(new TextDecoder().decode(after[0].data), 'SCOURGE,turn,error,0.5,deg\n');
});

test('decoder: a short COBS stream is never mistaken for plain text', () => {
  const d = new UserStreamDecoder();
  d.push(kernelPacket('sout', 'x'.repeat(400) + '\n').slice(0, 300));
  assert.equal(d.mode, 'unknown');
});

test('lines: a printf in pieces makes one line, and CR LF is trimmed', () => {
  const t = new TextLines();
  assert.deepEqual(t.push('sout', bytes('SCOURGE,AP,0,')), []);
  assert.deepEqual(t.push('serr', bytes('err one\n')), ['err one']);
  assert.deepEqual(t.push('sout', bytes('0;1;2;3;4;5;6;7;8,\r\nnext')), ['SCOURGE,AP,0,0;1;2;3;4;5;6;7;8,']);
  assert.deepEqual(t.flush(), [{ stream: 'sout', line: 'next' }]);
});

test('lines: a multi-byte character split across packets survives', () => {
  const t = new TextLines();
  const b = bytes('é\n');
  assert.deepEqual(t.push('sout', b.slice(0, 1)), []);
  assert.deepEqual(t.push('sout', b.slice(1)), ['é']);
});

test('line filter: keeps SCOURGE to the end, drops what is before it and colour codes', () => {
  assert.equal(scourgeLine('noise SCOURGE,drive,left,1.0,m  '), 'SCOURGE,drive,left,1.0,m');
  assert.equal(scourgeLine('\x1b[31mSCOURGE,turn,error,0.5,deg\x1b[0m'), 'SCOURGE,turn,error,0.5,deg');
  assert.equal(scourgeLine('just a log line'), null);
  assert.equal(scourgeLine('SCOURGE without a comma'), null);
});

/* ---------- tally: the cases from the Mac's Scripts/RecordingCheck/main.swift ---------- */

const ap = (i) => `SCOURGE,AP,${i},${i * 50};100;200;9000;0;10;20;0;0,`;
const begin4 = 'SCOURGE,BEGIN,autopath,1;teach;L;4;Build 1,';
const end4 = 'SCOURGE,END,autopath,4,';

// The rows fake-pros.sh prints: AP, AM, AS in turn.
function fakeAutopath(promised, sent, end, endCount) {
  const out = [`SCOURGE,BEGIN,autopath,1;teach;L;${promised};Build 1,`];
  for (let i = 0; i < sent; i++) {
    if (i % 3 === 0) out.push(`SCOURGE,AP,${i},${i * 50};100;200;9000;0;10;20;0;0,`);
    else if (i % 3 === 1) out.push(`SCOURGE,AM,${i},${i * 50};drop;100;200;9000;0;1;1,`);
    else out.push(`SCOURGE,AS,${i},${i * 50};0;drive;0;0;0;100;200;9000;1,`);
  }
  if (end) out.push(`SCOURGE,END,autopath,${endCount},`);
  return out;
}

test('tally: 45 of 45 rows is one full recording, and rows are not tests or values', () => {
  const t = tallyLines(fakeAutopath(45, 45, true, 45));
  assert.equal(t.recordings, 1);
  assert.equal(t.last, 'full');
  assert.equal(t.rows, 45);
  assert.equal(t.statusLine, 'Got the full recording. Tap Send Results.');
  assert.equal(t.values, 0);
  assert.equal(t.tests.size, 0);
});

test("tally: progress reads 'Recording: N of 45 rows', and BEGIN shows 0 of 45", () => {
  const t = new ResultsTally();
  const lines = fakeAutopath(45, 10, false);
  t.add(lines[0].split(','));
  assert.equal(t.statusLine, 'Recording: 0 of 45 rows');
  for (const l of lines.slice(1)) t.add(l.split(','));
  assert.equal(t.statusLine, 'Recording: 10 of 45 rows');
});

test('tally: Stop between BEGIN and END is cut off, with the Mac wording', () => {
  const t = tallyLines(fakeAutopath(10, 4, false));
  assert.equal(t.last, 'cutOff');
  assert.equal(t.recordings, 0);
  assert.equal(t.cutOff, 1);
  assert.equal(t.statusLine, 'That recording was cut off. Press X on the controller again.');
  assert.equal(t.summary, 'Recorded 1 autopath recording (4 rows, cut off)');
});

test('tally: END after 3 of 6 rows is cut off', () => {
  const t = tallyLines(fakeAutopath(6, 3, true, 3));
  assert.equal(t.last, 'cutOff');
  assert.equal(t.rows, 3);
});

test('tally: tester results keep their wording', () => {
  const t = tallyLines(['SCOURGE,HELLO,tester,1,', 'SCOURGE,BEGIN,drive,0,', 'SCOURGE,drive,left,1.0,m', 'SCOURGE,drive,right,2.0,m',
    'SCOURGE,END,drive,0,', 'SCOURGE,BEGIN,turn,0,', 'SCOURGE,turn,error,0.5,deg']);
  assert.equal(t.summary, 'Recorded 3 values from 2 tests');
  assert.equal(t.statusLine, null);
  assert.equal(t.hasAutopath, false);
  assert.equal(t.values, 3);
  assert.equal(t.tests.size, 2);
});

test('tally: a dropped half recording then a whole one is one full and one cut off', () => {
  const t = tallyLines([...fakeAutopath(6, 3, false), ...fakeAutopath(6, 6, true, 6)]);
  assert.equal(t.last, 'full');
  assert.equal(t.recordings, 1);
  assert.equal(t.cutOff, 1);
});

const rowCases = [
  ['four distinct rows and a matching END is full', [begin4, ap(0), ap(1), ap(2), ap(3), end4], 'full'],
  ['a repeated row does not stand in for a missing one', [begin4, ap(0), ap(1), ap(2), ap(2), end4], 'cutOff'],
  ['padding with repeats of one row is not a full recording', [begin4, ap(0), ap(1), ap(1), ap(1), end4], 'cutOff'],
  ['a truncated row (no trailing comma) is not counted', [begin4, ap(0), ap(1), ap(2), ap(3).slice(0, -1), end4], 'cutOff'],
  ['a row cut in the middle of a number is not counted', [begin4, ap(0), ap(1), ap(2), 'SCOURGE,AP,3,150;100;200;90', end4], 'cutOff'],
  ['a gap in the row numbers is cut off even when the count matches', [begin4, ap(0), ap(1), ap(2), ap(4), end4], 'cutOff'],
  ['a row number reused with different contents is cut off', [begin4, ap(0), ap(1), ap(2), 'SCOURGE,AP,2,999;1;2;3;4;5;6;7;8,', ap(3), end4], 'cutOff'],
  ['an END with no trailing comma is not an END', [begin4, ap(0), ap(1), ap(2), ap(3), end4.slice(0, -1)], 'cutOff'],
  ['END saying a different row count is cut off', [begin4, ap(0), ap(1), ap(2), ap(3), 'SCOURGE,END,autopath,5,'], 'cutOff'],
];
for (const [name, lines, last] of rowCases) {
  test(`tally: ${name}`, () => assert.equal(tallyLines(lines).last, last));
}

test('tally: a second END after a finished recording adds nothing full', () => {
  assert.equal(tallyLines([begin4, ap(0), ap(1), ap(2), ap(3), end4, end4]).recordings, 1);
});

test('tally: rows shown count each row number once, and the summary does too', () => {
  const live = tallyLines([begin4, ap(0), ap(1), ap(2), ap(2)]);
  assert.equal(live.rows, 3);
  assert.equal(tallyLines([begin4, ap(0), ap(0)]).summary, 'Recorded 1 autopath recording (1 rows, cut off)');
});

/* ---------- which file Send uses, what it says, and the double tap ---------- */

const file = (id, lines) => ({ id, lines, tally: tallyLines(lines) });
const good = file('results-1', [begin4, ap(0), ap(1), ap(2), ap(3), end4]);
const cutFile = file('results-2', [begin4, ap(0)]);
const testerFile = file('results-3', ['SCOURGE,BEGIN,drive,0,', 'SCOURGE,drive,left,1.0,m']);
const lateRows = file('results-5', [ap(2), ap(3), end4]);
const lateEnd = file('results-6', [end4]);
const noise = file('results-7', ['SCOURGE,HELLO,tester,1,']);

test('sendable: good files win and fragments never replace them', () => {
  assert.equal(sendable(good, cutFile).id, good.id, 'a cut-off retake does not replace a good earlier file');
  assert.equal(sendable(good, null).id, good.id, 'a recording with no data keeps the earlier file');
  assert.equal(sendable(good, testerFile).id, testerFile.id, 'tester data takes over');
  assert.equal(sendable(cutFile, good).id, good.id, 'a complete recording takes over');
  assert.equal(sendable(null, cutFile).id, cutFile.id, 'with no earlier file a cut-off one is still sendable');
  assert.equal(sendable(good, lateRows).id, good.id);
  assert.equal(sendable(good, lateEnd).id, good.id);
  assert.equal(sendable(good, noise).id, good.id);
  assert.equal(sendable(null, null), null);
});

test('sendable: rows or an END with no BEGIN are one cut-off recording', () => {
  assert.equal(lateRows.tally.last, 'cutOff');
  assert.equal(lateRows.tally.cutOff, 1);
  assert.equal(lateRows.tally.recordings, 0);
  assert.equal(lateRows.tally.usable, false);
  assert.equal(lateRows.tally.statusLine, TEXT.cutOff);
  assert.equal(lateEnd.tally.last, 'cutOff');
  assert.equal(lateEnd.tally.usable, false);
  assert.equal(noise.tally.usable, false);
  assert.ok(testerFile.tally.usable && good.tally.usable);
});

test('send lock: a sent file stays locked until a new file with data replaces it', () => {
  assert.equal(canSendFile(sendable(good, null), good.id), false);
  assert.equal(canSendFile(sendable(good, testerFile), good.id), true);
  assert.equal(canSendFile(good, null), true);
  assert.equal(canSendFile(good, good.id), false);
  assert.equal(canSendFile(null, null), false);
});

test('sent lines match the laptops', () => {
  assert.equal(good.tally.sentLine(), 'Sent. It shows on the Route Map in about a minute.');
  assert.equal(cutFile.tally.sentLine(), 'Sent, but that recording was cut off. Press X on the controller and record again.');
  assert.ok(file('x', [begin4, ap(0), begin4, ap(0), ap(1), ap(2), ap(3), end4]).tally.sentLine().startsWith('Sent. It shows'));
  assert.equal(testerFile.tally.sentLine(), null);
  assert.equal(good.tally.sentLine(false), "Sent, but it won't show on the Route Map without the team code. Enter it in Route Map, then send again.");
  assert.equal(good.tally.sentLine(true), TEXT.sentMap);
  assert.ok(cutFile.tally.sentLine(false).startsWith('Sent, but that recording was cut off'));
  assert.equal(testerFile.tally.sentLine(false), null);
});

/* ---------- CSV ---------- */

test('CSV: header, then one SCOURGE line each, and it reads back the same', () => {
  const lines = good.lines;
  const csv = buildCsv(lines);
  assert.ok(csv.startsWith(`${RESULTS_HEADER}\n`));
  assert.equal(csv, `kind,test,key,value,unit\n${lines.join('\n')}\n`);
  assert.deepEqual(dataLines(csv), lines);
  assert.deepEqual(dataLines(csv.replace(/\n/g, '\r\n')), lines);
  assert.deepEqual(tallyLines(dataLines(csv)), good.tally);
  assert.equal(buildCsv([]), 'kind,test,key,value,unit\n');
});

/* ---------- sending ---------- */

const RELAY = 'https://relay.example.workers.dev';
const NOW = () => Date.UTC(2026, 10, 18, 20, 0, 0);

function fakeFetch({ results = () => new Response('{"ok":true,"issues":[7]}', { status: 201 }), manifest = () => new Response(JSON.stringify({ results_url: `${RELAY}/results` })) } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(MANIFEST_URL)) return manifest();
    return results(url, init);
  };
  fn.calls = calls;
  return fn;
}

test('submission: title and body match the laptops, with "Uploader web"', () => {
  const s = buildSubmission({ lines: ['SCOURGE,a,b,1,', 'SCOURGE,c,d,2,'], version: '1.2.0', testerBuild: 'build-437-abc1234', now: NOW });
  assert.match(s.title, /^Robot data \d{4}-\d{2}-\d{2}$/);
  assert.equal(s.body, 'Uploader web 1.2.0, tester build build-437-abc1234, UTC 2026-11-18T20:00:00.000Z\r\n\r\nSCOURGE,a,b,1,\r\nSCOURGE,c,d,2,');
  assert.match(buildSubmission({ lines: ['x'], version: '1', now: NOW }).body, /tester build unknown,/);
});

test('send: one POST of the whole file with the client header and the team code', async () => {
  const rows = 3200;
  const lines = fakeAutopath(rows, rows, true, rows);
  const big = file('results-big', lines);
  const fetchFn = fakeFetch({ results: () => new Response('{"ok":true,"issues":[8],"on_map":true}', { status: 201 }) });
  const r = await sendResults({ file: big, version: '1.2.0', testerBuild: 'build-1', code: 'check-code-not-real', fetchFn, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.text, TEXT.sentMap);
  assert.equal(r.kind, 'success');
  const posts = fetchFn.calls.filter((c) => c.init.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `${RELAY}/results`);
  assert.equal(posts[0].init.headers['X-Scourge-Client'], 'web-uploader 1.2.0');
  assert.equal(posts[0].init.headers['X-Team-Code'], 'check-code-not-real');
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
  const sent = JSON.parse(posts[0].init.body);
  const body = sent.body.split('\r\n');
  assert.equal(body.length, 2 + rows + 2);
  assert.equal(body.at(-1), `SCOURGE,END,autopath,${rows},`);
  assert.ok(!JSON.stringify(r).includes('check-code-not-real'), 'the code never reaches the message');
});

test('send: no team code means no X-Team-Code header', async () => {
  const fetchFn = fakeFetch();
  await sendResults({ file: good, version: '1', fetchFn, now: NOW });
  const post = fetchFn.calls.find((c) => c.init.method === 'POST');
  assert.equal('X-Team-Code' in post.init.headers, false);
});

test('send: on_map false, absent, and a tester file', async () => {
  let r = await sendResults({ file: good, version: '1', fetchFn: fakeFetch({ results: () => new Response('{"ok":true,"issues":[8],"on_map":false}', { status: 201 }) }), now: NOW });
  assert.equal(r.text, TEXT.sentNoMap);
  assert.equal(r.kind, 'info');
  assert.equal(r.onMap, false);
  r = await sendResults({ file: good, version: '1', fetchFn: fakeFetch(), now: NOW });
  assert.equal(r.onMap, null);
  assert.equal(r.text, TEXT.sentMap);
  r = await sendResults({ file: testerFile, version: '1', fetchFn: fakeFetch({ results: () => new Response('{"ok":true,"issues":[7,9]}', { status: 201 }) }), now: NOW });
  assert.equal(r.text, 'Results sent to the programmer (issue #7, #9).');
  r = await sendResults({ file: cutFile, version: '1', fetchFn: fakeFetch(), now: NOW });
  assert.equal(r.text, TEXT.sentCut);
  assert.equal(r.kind, 'info');
});

test('send: refusals and failures say why and that the results are kept', async () => {
  const tail = ' They are saved in this browser. Check the connection, then click Send Results again.';
  const cases = [
    [() => new Response('{"ok":false,"error":"body too large"}', { status: 413 }), 'Could not send the results. body too large.'],
    [() => new Response('nope', { status: 413 }), 'Could not send the results. The results file is too big for the relay.'],
    [() => new Response('<html>', { status: 502 }), 'Could not send the results. The relay returned HTTP 502.'],
    [() => new Response('{"ok":false,"issues":[]}', { status: 201 }), 'Could not send the results. The relay did not accept the results.'],
    [() => { throw new TypeError('Failed to fetch'); }, "Could not send the results. Couldn't reach the relay."],
  ];
  for (const [results, text] of cases) {
    const r = await sendResults({ file: good, version: '1', fetchFn: fakeFetch({ results }), now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'error');
    assert.equal(r.text, text + tail);
  }
});

test('send: the saved relay address is used when the manifest is out of reach, and none at all is a clear failure', async () => {
  const offline = () => { throw new TypeError('Failed to fetch'); };
  const fetchFn = fakeFetch({ manifest: offline });
  const r = await sendResults({ file: good, version: '1', fetchFn, relay: RELAY, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(fetchFn.calls.at(-1).url, `${RELAY}/results`);
  const none = await sendResults({ file: good, version: '1', fetchFn: fakeFetch({ manifest: offline }), now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.text, /^Could not reach the results service\./);
});

test('send: a file over the relay limit is never cut or sent', async () => {
  const fetchFn = fakeFetch();
  const huge = file('results-huge', Array.from({ length: 12000 }, (_, i) => `SCOURGE,drive,v${i},${'1'.repeat(40)},m`));
  const r = await sendResults({ file: huge, version: '1', fetchFn, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.text, /^This file is too long to send in one go \(\d+ characters, the limit is 600000\)/);
  assert.equal(fetchFn.calls.length, 0);
});

test('send: nothing to send', async () => {
  const r = await sendResults({ file: null, version: '1', fetchFn: fakeFetch(), now: NOW });
  assert.equal(r.text, 'No results yet.');
});

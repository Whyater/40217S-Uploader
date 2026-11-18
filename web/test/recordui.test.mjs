import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordRules, idleLine, lineKind, NO_RESULTS } from '../recordui.js';
import { ResultsTally } from '../record.js';

test('idle with a sendable file: everything is enabled', () => {
  const r = recordRules({ canSend: true });
  assert.deepEqual([r.record, r.send, r.upload, r.tester], [false, false, false, false]);
  assert.equal(r.recordLabel, 'Record Results');
});

test('an upload locks Record and Send', () => {
  const r = recordRules({ uploading: true, canSend: true });
  assert.equal(r.record, true);
  assert.equal(r.send, true);
});

test('recording locks uploads, Put Tester and Send, and Record becomes Stop', () => {
  const r = recordRules({ recording: true, canSend: true });
  assert.equal(r.recordLabel, 'Stop Recording');
  assert.equal(r.record, false);
  assert.deepEqual([r.send, r.upload, r.tester], [true, true, true]);
  assert.equal(recordRules({ recording: true, stopping: true }).record, true);
});

test('Send follows canSend; unsupported browsers cannot record', () => {
  assert.equal(recordRules({ canSend: false }).send, true);
  assert.equal(recordRules({ supported: false }).record, true);
});

test('line text and kinds', () => {
  assert.equal(idleLine(null), NO_RESULTS);
  assert.equal(idleLine({ tally: new ResultsTally() }), 'Recorded 0 values from 0 tests');
  assert.deepEqual(['working', 'success', 'info', 'error', 'x'].map(lineKind), ['work', 'good', 'idle', 'bad', 'idle']);
});

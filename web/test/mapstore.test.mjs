import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../mapstore.js';

// A small fake IndexedDB. Options let a test break it in the ways phones do.
//   failOpen: open() errors      throwStart: n transaction() calls throw      abortWrites: writes abort (quota)
function fakeIdb(opts = {}) {
  const rows = new Map();
  const log = { opens: 0, transactions: 0 };
  const db = {
    createObjectStore() {},
    transaction(_store, mode) {
      log.transactions += 1;
      if (opts.throwStart > 0) { opts.throwStart -= 1; throw new Error('The database connection is closing.'); }
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      const writes = [];
      const os = {
        getAll() { return { result: [...rows.values()].map((r) => ({ ...r })) }; },
        put(r) { writes.push(() => rows.set(r.name, { ...r })); },
        delete(n) { writes.push(() => rows.delete(n)); },
      };
      tx.objectStore = () => os;
      setTimeout(() => {
        if (mode === 'readwrite' && opts.abortWrites) {
          tx.error = new Error('QuotaExceededError');
          tx.onabort && tx.onabort();
          return;
        }
        writes.forEach((w) => w());
        tx.oncomplete && tx.oncomplete();
      }, 0);
      return tx;
    },
  };
  return {
    rows, log,
    open() {
      log.opens += 1;
      const req = { result: db, error: null };
      setTimeout(() => {
        if (opts.failOpen) { req.error = new Error('denied'); req.onerror && req.onerror(); return; }
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
}

const rec = (name, text = 'SCOURGE,x') => ({ name, kind: 'csv', size: text.length, text });

test('files are stored, listed in name order, and removed', async () => {
  const idb = fakeIdb();
  const s = createStore(() => idb);
  await s.putFiles([rec('b.csv'), rec('a.csv')]);
  assert.deepEqual((await s.listFiles()).map((r) => r.name), ['a.csv', 'b.csv']);
  assert.equal(typeof (await s.listFiles())[0].added, 'number');
  await s.removeFile('a.csv');
  assert.deepEqual((await s.listFiles()).map((r) => r.name), ['b.csv']);
  assert.equal(s.state.persistent, true);
  assert.equal(idb.log.opens, 1, 'the connection is opened once and reused');
});

test('a same-name file replaces the stored one', async () => {
  const s = createStore(() => fakeIdb());
  await s.putFiles([rec('a.csv', 'SCOURGE,1')]);
  await s.putFiles([rec('a.csv', 'SCOURGE,22')]);
  const rows = await s.listFiles();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'SCOURGE,22');
});

test('no IndexedDB at all: files live in memory and persistent is false', async () => {
  const s = createStore(() => null);
  await s.putFiles([rec('a.csv')]);
  assert.deepEqual((await s.listFiles()).map((r) => r.name), ['a.csv']);
  assert.equal(s.state.persistent, false);
  await s.removeFile('a.csv');
  assert.deepEqual(await s.listFiles(), []);
});

test('open failure falls back to memory the same way', async () => {
  const s = createStore(() => fakeIdb({ failOpen: true }));
  await s.putFiles([rec('a.csv')]);
  assert.equal((await s.listFiles()).length, 1);
  assert.equal(s.state.persistent, false);
});

test('a dead connection after open is reopened once and the call succeeds', async () => {
  // Simulated iOS "connection is closing": the first transaction() throws.
  const flaky = fakeIdb({ throwStart: 1 });
  flaky.rows.set('a.csv', { ...rec('a.csv'), added: 1 });
  const s2 = createStore(() => flaky);
  assert.deepEqual((await s2.listFiles()).map((r) => r.name), ['a.csv']);
  assert.equal(flaky.log.opens, 2, 'reopened after the failure');
  // and it keeps working afterwards
  await s2.putFiles([rec('b.csv')]);
  assert.equal((await s2.listFiles()).length, 2);
  assert.equal(flaky.log.opens, 2);
});

test('putFiles also recovers from a dead connection', async () => {
  const idb = fakeIdb({ throwStart: 1 });
  const s = createStore(() => idb);
  await s.putFiles([rec('a.csv')]);
  assert.equal(idb.rows.size, 1);
});

test('a connection that stays dead rejects after one retry instead of looping', async () => {
  const idb = fakeIdb({ throwStart: 99 });
  const s = createStore(() => idb);
  await assert.rejects(s.listFiles(), /closing/);
  assert.equal(idb.log.opens, 2);
  assert.equal(idb.log.transactions, 2);
});

test('a refused write (storage full) rejects and leaves the stored files alone', async () => {
  const full = fakeIdb({ abortWrites: true });
  full.rows.set('a.csv', { ...rec('a.csv'), added: 1 });
  const s2 = createStore(() => full);
  await assert.rejects(s2.putFiles([rec('b.csv')]), /Quota/);
  assert.deepEqual((await s2.listFiles()).map((r) => r.name), ['a.csv']);
  assert.equal(full.log.opens, 1, 'a quota error is not treated as a dead connection');
});

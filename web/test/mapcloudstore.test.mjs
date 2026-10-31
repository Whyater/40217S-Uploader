import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../mapstore.js';

// A small fake IndexedDB that keeps each object store apart and knows get().
function fakeIdb() {
  const stores = { files: new Map(), cloud: new Map() };
  const created = [];
  const keyPaths = { files: 'name', cloud: 'key' };
  const db = {
    objectStoreNames: { contains: (n) => created.includes(n) },
    createObjectStore(n, opts) { created.push(n); assert.equal(opts.keyPath, keyPaths[n]); },
    transaction(name) {
      const rows = stores[name];
      const kp = keyPaths[name];
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const writes = [];
      tx.objectStore = () => ({
        getAll() { return { result: [...rows.values()].map((r) => ({ ...r })) }; },
        get(k) { const r = rows.get(k); return { result: r ? { ...r } : undefined }; },
        put(r) { writes.push(() => rows.set(r[kp], { ...r })); },
        delete(k) { writes.push(() => rows.delete(k)); },
      });
      setTimeout(() => { writes.forEach((w) => w()); tx.oncomplete && tx.oncomplete(); }, 0);
      return tx;
    },
  };
  return {
    stores, created,
    open() {
      const req = { result: db };
      setTimeout(() => { req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); }, 0);
      return req;
    },
  };
}

const rec = { code: 'abc 123', relay: 'https://relay.example', tag: 'build-70-abc1234', fetched: 1000, response: { sim: { tag: 'build-70-abc1234' }, recorded: null } };

test('nothing is stored at first', async () => {
  const s = createStore(() => fakeIdb());
  assert.equal(await s.loadCloud(), null);
});

test('the code and the download are stored together and read back', async () => {
  const idb = fakeIdb();
  const s = createStore(() => idb);
  await s.saveCloud(rec);
  assert.deepEqual(await s.loadCloud(), rec, 'no internal key leaks out');
  assert.deepEqual(idb.created.sort(), ['cloud', 'files']);
  assert.equal(idb.stores.cloud.size, 1, 'one record, replaced on every save');
  await s.saveCloud({ ...rec, fetched: 2000 });
  assert.equal(idb.stores.cloud.size, 1);
  assert.equal((await s.loadCloud()).fetched, 2000);
});

test('clearCloud removes the code and the data, and leaves hand-added files alone', async () => {
  const s = createStore(() => fakeIdb());
  await s.putFiles([{ name: 'a.csv', kind: 'csv', size: 3, text: 'SCOURGE,x' }]);
  await s.saveCloud(rec);
  await s.clearCloud();
  assert.equal(await s.loadCloud(), null);
  assert.equal((await s.listFiles()).length, 1);
});

test('without IndexedDB the download lives in memory', async () => {
  const s = createStore(() => null);
  await s.saveCloud(rec);
  assert.deepEqual(await s.loadCloud(), rec);
  assert.equal(s.state.persistent, false);
  await s.clearCloud();
  assert.equal(await s.loadCloud(), null);
});

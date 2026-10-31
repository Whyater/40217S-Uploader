// Route files kept on this device in IndexedDB. Nothing here touches the network.
// If the browser won't give us IndexedDB (some private modes), files live in
// memory until the page closes, and `persistent` says so.

const DB = 'scourge-map';
const STORE = 'files';

// getIdb is a function so tests can hand in a fake IndexedDB.
export function createStore(getIdb) {
  let dbPromise = null;
  const memory = new Map();
  const state = { persistent: true };

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const idb = getIdb();
        if (!idb) { reject(new Error('no indexedDB')); return; }
        const req = idb.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('open failed'));
        req.onblocked = () => reject(new Error('open blocked'));
      }).catch(() => { state.persistent = false; return null; });
    }
    return dbPromise;
  }

  // A transaction that cannot even start means the connection died (iOS closes
  // idle ones). That one case is worth a reopen; any other failure is reported.
  class StartError extends Error {}

  function run(db, mode, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { reject(new StartError(e && e.message)); return; }
      const out = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('storage failed'));
      tx.onabort = () => reject(tx.error || new Error('storage was refused'));
    });
  }

  async function withDb(mode, work, inMemory) {
    for (let attempt = 0; ; attempt++) {
      const db = await openDb();
      if (!db) return inMemory();
      try {
        return await run(db, mode, work);
      } catch (e) {
        if (!(e instanceof StartError) || attempt > 0) throw e;
        dbPromise = null; // reopen once
      }
    }
  }

  const sorted = (rows) => rows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    state,
    async listFiles() {
      const rows = await withDb('readonly', (s) => s.getAll(), () => [...memory.values()]);
      return sorted([...(rows || [])]);
    },
    // records: [{ name, kind, size, text }]. Adds a timestamp so "newest map-data.json" is knowable.
    async putFiles(records) {
      const stamped = records.map((r, i) => ({ name: r.name, kind: r.kind, size: r.size, text: r.text, added: Date.now() + i }));
      await withDb('readwrite', (s) => { stamped.forEach((r) => s.put(r)); }, () => { stamped.forEach((r) => memory.set(r.name, r)); });
    },
    async removeFile(name) {
      await withDb('readwrite', (s) => { s.delete(name); }, () => { memory.delete(name); });
    },
  };
}

const store = createStore(() => (typeof indexedDB === 'undefined' ? null : indexedDB));
export const { state, listFiles, putFiles, removeFile } = store;

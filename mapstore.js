// Route files and the last map download kept on this device in IndexedDB.
// Nothing here touches the network. If the browser won't give us IndexedDB
// (some private modes), everything lives in memory until the page closes, and
// `persistent` says so.

const DB = 'scourge-map';
const STORE = 'files';
const CLOUD = 'cloud'; // one record: the team code and the last good download
const CLOUD_KEY = 'main';

// getIdb is a function so tests can hand in a fake IndexedDB.
export function createStore(getIdb) {
  let dbPromise = null;
  const memory = new Map();
  let memoryCloud = null;
  const state = { persistent: true };

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const idb = getIdb();
        if (!idb) { reject(new Error('no indexedDB')); return; }
        const req = idb.open(DB, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          const has = (n) => !!(db.objectStoreNames && db.objectStoreNames.contains(n));
          if (!has(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
          if (!has(CLOUD)) db.createObjectStore(CLOUD, { keyPath: 'key' });
        };
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

  function run(db, mode, work, storeName) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(storeName, mode); } catch (e) { reject(new StartError(e && e.message)); return; }
      const out = work(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('storage failed'));
      tx.onabort = () => reject(tx.error || new Error('storage was refused'));
    });
  }

  async function withDb(mode, work, inMemory, storeName = STORE) {
    for (let attempt = 0; ; attempt++) {
      const db = await openDb();
      if (!db) return inMemory();
      try {
        return await run(db, mode, work, storeName);
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
    // The map download: { code, relay, tag, fetched, response } or null. Kept
    // in one record so the code and the data it unlocked go away together.
    async loadCloud() {
      const row = await withDb('readonly', (s) => s.get(CLOUD_KEY), () => memoryCloud, CLOUD);
      if (!row) return null;
      const { key, ...rec } = row;
      return rec;
    },
    async saveCloud(rec) {
      const row = { ...rec, key: CLOUD_KEY };
      await withDb('readwrite', (s) => { s.put(row); }, () => { memoryCloud = row; }, CLOUD);
    },
    async clearCloud() {
      await withDb('readwrite', (s) => { s.delete(CLOUD_KEY); }, () => { memoryCloud = null; }, CLOUD);
    },
  };
}

const store = createStore(() => (typeof indexedDB === 'undefined' ? null : indexedDB));
export const { state, listFiles, putFiles, removeFile, loadCloud, saveCloud, clearCloud } = store;

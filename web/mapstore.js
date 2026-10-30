// Route files kept on this device in IndexedDB. Nothing here touches the network.
// If the browser won't give us IndexedDB (some private modes), files live in
// memory until the page closes, and `persistent` says so.

const DB = 'scourge-map';
const STORE = 'files';

let dbPromise = null;
const memory = new Map();
export const state = { persistent: true };

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('open failed'));
      req.onblocked = () => reject(new Error('open blocked'));
    }).catch((e) => { state.persistent = false; dbPromise = Promise.resolve(null); return null; });
  }
  return dbPromise;
}

function run(db, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('storage failed'));
    tx.onabort = () => reject(tx.error || new Error('storage was refused'));
  });
}

export async function listFiles() {
  const db = await openDb();
  if (!db) return [...memory.values()].sort((a, b) => a.name.localeCompare(b.name));
  const all = await run(db, 'readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => a.name.localeCompare(b.name));
}

// records: [{ name, kind, size, text }]. Adds a timestamp so "newest map-data.json" is knowable.
export async function putFiles(records) {
  const db = await openDb();
  const stamped = records.map((r, i) => ({ name: r.name, kind: r.kind, size: r.size, text: r.text, added: Date.now() + i }));
  if (!db) { stamped.forEach((r) => memory.set(r.name, r)); return; }
  await run(db, 'readwrite', (s) => { stamped.forEach((r) => s.put(r)); });
}

export async function removeFile(name) {
  const db = await openDb();
  if (!db) { memory.delete(name); return; }
  await run(db, 'readwrite', (s) => { s.delete(name); });
}

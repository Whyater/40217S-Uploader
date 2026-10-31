// Pure helpers for the Route Map tab: no DOM, no storage, so Node can test them.
// Files picked on the phone are untrusted text. Nothing here builds HTML.

export const TABS = ['upload', 'map'];
export const DEFAULT_TAB = 'upload';
export const MAX_BYTES = 20 * 1024 * 1024; // all stored files together
export const NAME_MAX = 80;

// Whatever was saved last, or the Upload tab if it is missing or unknown.
export function readTab(raw) {
  return TABS.includes(raw) ? raw : DEFAULT_TAB;
}

// "results-1.csv" -> "csv", "map-data.json" -> "json", anything else -> null.
export function fileKind(name) {
  const m = /\.(csv|json)$/i.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : null;
}

// Drop any folder part and control characters, and keep the name short.
export function cleanName(name) {
  let n = String(name == null ? '' : name).split(/[\\/]/).pop();
  n = n.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').trim();
  if (n.length > NAME_MAX) {
    const ext = /\.[A-Za-z0-9]{1,5}$/.exec(n);
    const tail = ext ? ext[0] : '';
    n = n.slice(0, NAME_MAX - tail.length - 1) + '…' + tail;
  }
  return n;
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function totalBytes(records) {
  return records.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Is this text worth keeping? Returns { ok: true } or { ok: false, error } where
// error is a plain sentence that is safe to show with textContent.
export function checkText(kind, name, text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: `${name} is empty.` };
  if (text.indexOf('\u0000') !== -1) return { ok: false, error: `${name} is not a text file.` };
  if (kind === 'csv') {
    // The page ignores noise lines, but a file with no robot lines at all is the wrong file.
    if (!/(^|[\r\n,])SCOURGE,/.test(text)) {
      return { ok: false, error: `${name} has no robot results in it. Use a results file the laptop app recorded.` };
    }
    return { ok: true };
  }
  if (kind === 'json') {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: `${name} is not valid JSON, so it was skipped. Use the map-data.json file from the laptop.` };
    }
    if (!isPlainObject(data) || !(Array.isArray(data.routes) || Array.isArray(data.sessions))) {
      return { ok: false, error: `${name} does not look like route data. Use the map-data.json file from the laptop.` };
    }
    return { ok: true };
  }
  return { ok: false, error: `${name} is not a .csv or .json file.` };
}

// Decide what to keep from a batch of picked files.
//   existing: stored records { name, kind, size, ... }
//   incoming: [{ name, size, read }]  read() returns the file's text; it is only
//             called for a file that passed the name and size checks, so a
//             batch that is too big is never loaded into memory.
//   cap: byte limit for everything together
// Returns { accepted: [{ name, kind, size, text, replaced }], rejected: [{ name, reason }] }.
// A file with the same name as a stored one replaces it, so its old size is freed first.
export async function planAdd(existing, incoming, cap = MAX_BYTES) {
  const accepted = [];
  const rejected = [];
  const sizes = new Map(existing.map((r) => [r.name, Number(r.size) || 0]));
  let used = totalBytes(existing);

  for (const f of incoming) {
    const name = cleanName(f.name) || 'Unnamed file';
    const kind = fileKind(name);
    if (!kind) {
      rejected.push({ name, reason: `${name} was skipped. Only results .csv files and map-data.json files are used.` });
      continue;
    }
    const size = Number(f.size) || 0;
    if (size > cap) {
      rejected.push({ name, reason: `${name} is ${formatBytes(size)}, which is over the ${formatBytes(cap)} this device keeps for route files, so it was not added.` });
      continue;
    }
    const replaced = sizes.has(name);
    const freed = replaced ? sizes.get(name) : 0;
    if (used - freed + size > cap) {
      rejected.push({
        name,
        reason: `${name} was not added. This device keeps up to ${formatBytes(cap)} of route files and ${formatBytes(used)} is used. Remove some files first.`,
      });
      continue;
    }
    let text;
    try {
      text = await f.read();
    } catch {
      rejected.push({ name, reason: `${name} could not be read.` });
      continue;
    }
    const check = checkText(kind, name, text);
    if (!check.ok) {
      rejected.push({ name, reason: check.error });
      continue;
    }
    used = used - freed + size;
    sizes.set(name, size);
    accepted.push({ name, kind, size, text, replaced });
  }
  return { accepted, rejected };
}

// The object ScourgeMap.load takes: { mapData, csvTexts, note }.
// The newest map-data.json wins; every results file is passed along.
export function buildInput(records) {
  const json = records.filter((r) => r.kind === 'json').sort((a, b) => (b.added || 0) - (a.added || 0));
  let mapData = null;
  for (const r of json) {
    try {
      const d = JSON.parse(r.text);
      if (isPlainObject(d)) { mapData = d; break; }
    } catch { /* a bad stored file is skipped, not fatal */ }
  }
  const csvTexts = records
    .filter((r) => r.kind === 'csv')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({ name: r.name, text: r.text }));
  const input = { mapData, csvTexts };
  if (json.length > 1 && mapData) input.note = `Route data from ${json[0].name}`;
  return input;
}

// Summary line under the file panel, e.g. "3 files, 1.2 MB of 20 MB".
export function summaryText(records, cap = MAX_BYTES) {
  const n = records.length;
  return `${n} ${n === 1 ? 'file' : 'files'}, ${formatBytes(totalBytes(records))} of ${formatBytes(cap)}`;
}

// A message from the embedded page is only trusted when it came from our own
// origin and from the frame we created.
export function acceptHeight(event, frameWindow, origin) {
  if (!event || event.origin !== origin || event.source !== frameWindow) return null;
  const d = event.data;
  if (!d || typeof d !== 'object' || d.type !== 'scourge-map') return null;
  const h = Number(d.height);
  if (!Number.isFinite(h) || h <= 0) return null;
  return Math.min(Math.max(Math.round(h), 240), 20000);
}

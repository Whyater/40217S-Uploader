// Ported from the PROS CLI (https://github.com/purduesigbots/pros-cli).
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Program-level pieces pros-cli builds before talking to the brain:
 * the slot .ini, timestamps, gzip, the cold library name, and version checks.
 */
import { gzipCrc32 } from './crc.js';
import { v5Error } from './errors.js';
import { md5 } from './md5.js';
import { deflateRaw } from './vendor/pako.mjs';

/** pros-cli `--icon` choices (pros/cli/upload.py name_to_file). */
export const PROS_ICONS = {
  pros: 'USER902x.bmp',
  pizza: 'USER003x.bmp',
  planet: 'USER013x.bmp',
  alien: 'USER027x.bmp',
  ufo: 'USER029x.bmp',
  clawbot: 'USER010x.bmp',
  robot: 'USER011x.bmp',
  question: 'USER002x.bmp',
  power: 'USER012x.bmp',
  X: 'USER001x.bmp',
};

export const DEFAULT_DESCRIPTION = 'Made with PROS'; // pros-cli `--description` default
/** pros-cli writes the project's kernel version as [project] version; 40217S uses kernel 4.2.2. */
export const DEFAULT_IDE_VERSION = '4.2.2';
export const DEFAULT_COLD_ADDR = 0x03800000;
export const DEFAULT_HOT_ADDR = 0x07800000;

// ---------- versions (semantic_version 2.10 behaviour for the specs pros-cli uses) ----------

export function parseVersion(str) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(str);
  if (!m) throw new Error(`bad version ${str}`);
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

function cmpCore(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  return 0;
}

export function compareVersions(x, y) {
  const a = typeof x === 'string' ? parseVersion(x) : x;
  const b = typeof y === 'string' ? parseVersion(y) : y;
  const c = cmpCore(a, b);
  if (c) return c;
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const p = a.pre[i], q = b.pre[i];
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (+p !== +q) return +p < +q ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}

/** Spec('<op><target>').match(version), for the operators pros-cli uses. */
export function versionMatches(version, op, target) {
  const v = parseVersion(version);
  const t = parseVersion(target);
  const c = compareVersions(v, t);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '<':
      // Legacy Spec: '<1.0.13' does not match pre-releases of 1.0.13 itself.
      if (!t.pre.length && v.pre.length && cmpCore(v, t) === 0) return false;
      return c < 0;
    default: throw new Error(`unsupported op ${op}`);
  }
}

// ---------- time ----------

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** datetime.now().isoformat() for a local, naive time (JS has ms resolution). */
export function pythonIsoformat(date) {
  const base = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const ms = date.getMilliseconds();
  return ms ? `${base}.${pad(ms, 3)}000` : base;
}

/** int((datetime.now() - datetime(2000, 1, 1)).total_seconds()), local wall time. */
export function vexTimestamp(date) {
  const wall = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(),
    date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  return Math.trunc((wall - Date.UTC(2000, 0, 1)) / 1000);
}

// ---------- ini ----------

/** ConfigParser BasicInterpolation.before_set: reject a stray '%'. */
function checkInterpolation(value) {
  const tmp = value.replace(/%%/g, '').replace(/%\(([^)]+)\)s/g, '');
  if (tmp.includes('%')) {
    throw v5Error('BAD_INPUT', `"%" must be written as "%%" in "${value}" (PROS rejects it too).`);
  }
}

/** ConfigParser.write() for plain sections of string values. */
export function writeConfigParser(sections) {
  let out = '';
  for (const [section, entries] of sections) {
    out += `[${section}]\n`;
    for (const [key, value] of entries) {
      const v = String(value);
      checkInterpolation(v);
      out += `${key.toLowerCase()} = ${v.replace(/\n/g, '\n\t')}\n`;
    }
    out += '\n';
  }
  return out;
}

/**
 * V5Device.generate_ini_file. `slot` is the 0-based slot pros-cli stores.
 * `cpu0Version` only matters when no icon is given (pre-1.0.0-22 firmware used USER999x.bmp).
 */
export function generateIni({ name, slot, ide = 'PROS', ideVersion = 'None', programVersion = '0.0.0',
  icon, description = 'Created with PROS', date = new Date(), cpu0Version = '1.0.0-22' }) {
  const defaultIcon = versionMatches(cpu0Version, '>=', '1.0.0-22') ? 'USER902x.bmp' : 'USER999x.bmp';
  return writeConfigParser([
    ['project', [['version', ideVersion], ['ide', ide]]],
    ['program', [
      ['version', programVersion || '0.0.0'],
      ['name', name],
      ['slot', slot],
      ['icon', icon || defaultIcon],
      ['description', description],
      ['date', pythonIsoformat(date)],
    ]],
  ]);
}

/** Name handling from pros-cli: '@' becomes '_' (cli/upload.py), then cut to 23 chars (write_program). */
export function programRemoteName(name) {
  return String(name).replace(/@/g, '_').slice(0, 23);
}

// ---------- cold library name ----------

function pythonRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`) + q;
}

function base64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * V5Device.generate_cold_hash. pros-cli hashes str(sorted(template_names, key=first char))
 * (versions are NOT part of the hash: sorting a dict yields its keys). The list must be in
 * project.pros template order, since the sort is stable and only looks at the first character.
 * Firmware with cpu0 <= 1.0.0-27 limits linked names, so it is cut to 17 characters there.
 */
export function coldHashName(templateNames, cpu0Version) {
  const sorted = [...templateNames].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const text = `[${sorted.map(pythonRepr).join(', ')}]`;
  let name = base64(md5(asciiBytes(text))).replace(/=+$/, '');
  if (cpu0Version && versionMatches(cpu0Version, '<=', '1.0.0-27')) name = name.slice(0, 17);
  return name;
}

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw v5Error('BAD_INPUT', `Template names must be ASCII (got "${s}")`);
    out[i] = c;
  }
  return out;
}

// ---------- gzip ----------

/** Header Python 3.10's gzip.GzipFile(fileobj=BytesIO(), mtime=0) writes: no name, XFL 2 (level 9), OS 255. */
const PY310_GZIP_HEADER = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]);

/**
 * gzip byte-identical to the installed PROS CLI (Python 3.10 GzipFile, compresslevel 9, mtime 0,
 * deflate via zlib level 9 / wbits -15 / memLevel 8 / default strategy).
 * The bytes must match, or the cold library CRC differs and pros-cli's library logic
 * replaces it and erases every program linked to the old copy.
 * legacyHash makes pako use zlib's classic hash, which is what reproduces zlib's output.
 */
export function prosGzip(data) {
  const raw = deflateRaw(data, { level: 9, windowBits: 15, memLevel: 8, strategy: 0, legacyHash: true });
  const out = new Uint8Array(PY310_GZIP_HEADER.length + raw.length + 8);
  out.set(PY310_GZIP_HEADER, 0);
  out.set(raw, PY310_GZIP_HEADER.length);
  const crc = gzipCrc32(data);
  const len = data.length >>> 0;
  let o = PY310_GZIP_HEADER.length + raw.length;
  for (const v of [crc, len]) {
    out[o++] = v & 0xff;
    out[o++] = (v >>> 8) & 0xff;
    out[o++] = (v >>> 16) & 0xff;
    out[o++] = (v >>> 24) & 0xff;
  }
  return out;
}

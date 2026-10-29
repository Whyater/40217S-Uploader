// Ported from the PROS CLI (https://github.com/purduesigbots/pros-cli).
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * High-level flows, ported from pros-cli V5Device.write_program / write_file /
 * upload_library / ensure_library_space / DownloadChannel and cli/upload.py.
 */
import { SerialConnection } from './connection.js';
import { V5Error, isCommError, v5Error } from './errors.js';
import { V5Device, crc32 } from './device.js';
import { FT_COMPLETE, PRODUCT, ascii, resolveVid } from './framing.js';
import {
  DEFAULT_COLD_ADDR, DEFAULT_DESCRIPTION, DEFAULT_HOT_ADDR, PROS_ICONS,
  DEFAULT_IDE_VERSION, coldHashName, generateIni, programRemoteName, prosGzip,
} from './program.js';

const WIRELESS_WARN_BYTES = 0x25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toBytes(data, what) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw v5Error('BAD_INPUT', `${what} must be a Uint8Array or ArrayBuffer.`);
}

function runAfterOption(runAfter) {
  if (runAfter === undefined || runAfter === null || runAfter === false || runAfter === 'none') return FT_COMPLETE.none;
  if (runAfter === true || runAfter === 'run') return FT_COMPLETE.run;
  if (runAfter === 'screen') return FT_COMPLETE.screen;
  throw v5Error('BAD_INPUT', `runAfter must be 'none', 'run' or 'screen' (got ${runAfter}).`);
}

/** Turn a timeout during the first contact into the friendly "brain didn't answer" error. */
async function firstContact(dev) {
  try {
    return await dev.querySystemVersion();
  } catch (e) {
    if (e instanceof V5Error && e.code === 'BAD_RESPONSE') {
      throw new V5Error('NOT_V5', "Something answered, but it isn't a V5 brain or controller system port.", {
        detail: e.detail, cause: e,
      });
    }
    throw e;
  }
}

/**
 * V5Device.DownloadChannel. Over a controller, switch the radio to the faster
 * download channel for the duration of fn, then back to pit.
 */
export async function withDownloadChannel(dev, fn, { switchTimeoutMs = 5000 } = {}) {
  let version = await firstContact(dev);
  let didSwitch = false;
  if (version.product === PRODUCT.CONTROLLER) {
    dev.defaultTimeout = 2;
    if (!version.connected) throw v5Error('CONTROLLER_NOT_LINKED', version);
    await dev.ftTransferChannel('download');
    didSwitch = true;
    await sleep(250);
    version = await dev.querySystemVersion();
    const start = Date.now();
    while (!version.connected && Date.now() - start < switchTimeoutMs) {
      version = await dev.querySystemVersion();
      await sleep(250);
    }
    if (!version.connected) throw v5Error('CONTROLLER_CHANNEL', version);
  }
  let failed = false;
  try {
    return await fn(version);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (didSwitch) {
      try {
        await dev.ftTransferChannel('pit');
      } catch (e) {
        if (!failed) throw e;
      }
    }
  }
}

/**
 * V5Device.write_file (upload direction).
 * @returns the bytes actually sent (gzipped when compressed).
 */
export async function writeFile(dev, data, remoteFile, {
  runAfter = FT_COMPLETE.none, linkedFilename = null, linkedVid = 'pros', compress = false,
  gzip = prosGzip, addr, vid = 'user', type = 'bin', onProgress, confirmLargeWireless,
} = {}) {
  let file = data;
  if (compress && (await dev.canCompress())) file = toBytes(await gzip(file), 'gzip output');
  if ((await dev.isWireless()) && file.length > WIRELESS_WARN_BYTES) {
    // pros-cli asks here and defaults to no; without a callback we carry on.
    if (confirmLargeWireless && !(await confirmLargeWireless(file.length))) throw v5Error('CANCELLED');
  }
  const crc = crc32(file);
  const base = addr ?? 0x03800000;
  const meta = await dev.ftInitialize(remoteFile, { function: 'upload', length: file.length, crc, vid, type, addr });
  if (linkedFilename !== null && linkedFilename !== undefined) await dev.ftSetLink(linkedFilename, linkedVid);
  if (meta.fileSize < file.length) {
    throw v5Error('BAD_RESPONSE', { why: 'brain reported a smaller file size than requested', meta });
  }
  const chunk = Math.floor(meta.maxPacketSize / 2);
  if (chunk <= 0) throw v5Error('BAD_RESPONSE', { why: 'max packet size of 0', meta });
  onProgress?.({ file: remoteFile, sent: 0, total: file.length });
  for (let i = 0; i < file.length; i += chunk) {
    const part = file.subarray(i, Math.min(i + chunk, file.length));
    await dev.ftWrite(base + i, part);
    onProgress?.({ file: remoteFile, sent: i + part.length, total: file.length });
  }
  // pros-cli sizes the completion timeout from the file length (flash write time).
  await dev.ftComplete(runAfter, Math.max(file.length / 200000, 1.0));
  return file;
}

/**
 * V5Device.ensure_library_space: remove orphaned programs and libraries before
 * uploading library `name` into `vid`. When more than 3 libraries are in use,
 * pros-cli asks before evicting old ones; here that is `confirmEviction(list)`,
 * and with no callback nothing is evicted.
 */
export async function ensureLibrarySpace(dev, name, vid, { confirmEviction, onErase } = {}) {
  const v = resolveVid(vid);
  const key = (lv, ln) => `${lv}\u0000${ln}`;
  const used = [];
  const unused = [];
  const libCount = await dev.getDirCount(v);
  for (let i = 0; i < libCount; i++) {
    const e = await dev.getFileMetadataByIdx(i);
    unused.push({ vid: v, name: e.filename });
  }
  const idx = unused.findIndex((l) => l.vid === v && l.name === name);
  if (idx >= 0) unused.splice(idx, 1);
  used.push({ vid: v, name });

  const userCount = await dev.getDirCount('user');
  const userFiles = [];
  for (let i = 0; i < userCount; i++) userFiles.push(await dev.getFileMetadataByIdx(i));
  const programs = new Map();
  for (const p of userFiles) {
    if (p.type === 'bin') programs.set(p.filename, await dev.getFileMetadataByName(p.filename, 'user'));
  }
  const usage = new Map();
  for (const [prog, meta] of programs) {
    const k = key(meta.linkedVid, meta.linkedFilename);
    if (!usage.has(k)) usage.set(k, { vid: meta.linkedVid, name: meta.linkedFilename, programs: [] });
    usage.get(k).programs.push(prog);
  }

  const orphaned = [];
  for (const link of usage.values()) {
    if (link.vid === v && link.name === name) {
      orphaned.push(...link.programs); // the library is being replaced, so its programs go too
    } else if (link.vid !== 0) {
      const u = unused.findIndex((l) => l.vid === link.vid && l.name === link.name);
      if (u >= 0) {
        unused.splice(u, 1);
        used.push({ vid: link.vid, name: link.name });
      } else {
        try {
          await dev.getFileMetadataByName(link.name, link.vid);
          used.push({ vid: link.vid, name: link.name });
        } catch (e) {
          if (!isCommError(e)) throw e;
          orphaned.push(...link.programs); // linked library is gone
        }
      }
    }
  }
  orphaned.push(...unused);
  const erasedPrograms = orphaned.filter((f) => typeof f === 'string');
  for (const f of orphaned) {
    if (typeof f === 'string') await dev.eraseFile(f, { eraseAll: true, vid: 'user' });
    else await dev.eraseFile(f.name, { vid: f.vid });
  }

  if (used.length > 3) {
    const libs = [];
    for (const l of used) {
      const ts = (await dev.getFileMetadataByName(l.name, l.vid)).timestamp;
      const progs = usage.get(key(l.vid, l.name))?.programs ?? [];
      const newest = Math.max(ts, ...progs.map((p) => programs.get(p).timestamp));
      libs.push({ ...l, newest, programs: progs });
    }
    libs.sort((a, b) => a.newest - b.newest);
    const plan = libs.slice(0, 3);
    if (confirmEviction && (await confirmEviction(plan.map((l) => ({ library: l.name, programs: l.programs }))))) {
      for (const l of plan) {
        await dev.eraseFile(l.name, { vid: l.vid });
        for (const p of l.programs) await dev.eraseFile(p, { eraseAll: true, vid: 'user' });
        erasedPrograms.push(...l.programs);
      }
    }
  }
  // pros-cli only logs these; the app tells the user which slots got wiped.
  if (erasedPrograms.length) onErase?.(erasedPrograms);
}

/**
 * V5Device.upload_library: upload the cold package unless an identical copy
 * (same size and CRC32 after gzip) is already on the brain.
 * @returns true if it uploaded, false if the brain already had it.
 */
export async function uploadLibrary(dev, data, remoteName, {
  vid = 'pros', addr, compress = true, forceUpload = false, gzip = prosGzip, onProgress, confirmEviction, onErase,
  confirmLargeWireless,
} = {}) {
  const name = remoteName.slice(0, 23);
  let file = data;
  if (compress && (await dev.canCompress())) file = toBytes(await gzip(file), 'gzip output');
  const crc = crc32(file);
  if (!forceUpload) {
    try {
      const meta = await dev.getFileMetadataByName(name, vid);
      if (meta.size === file.length && meta.crc === crc) return false;
    } catch (e) {
      if (!isCommError(e)) throw e; // a NACK means "not there"; anything else is a real failure
    }
  }
  await ensureLibrarySpace(dev, name, vid, { confirmEviction, onErase });
  await writeFile(dev, file, name, { vid, addr, onProgress, confirmLargeWireless });
  return true;
}

function openDevice(port, opts) {
  const conn = new SerialConnection(port, { readTimeoutMs: opts.readTimeoutMs ?? 1000 });
  const now = opts.now instanceof Date ? () => opts.now : opts.now ?? (() => new Date());
  const dev = new V5Device(conn, { defaultTimeout: opts.defaultTimeout ?? 0.1, retries: opts.retries ?? 3, now, log: opts.log });
  return { conn, dev, now };
}

/**
 * Confirm a V5 is on the other end of the port and read its versions.
 * Works with the brain's system port, or a controller's system port (reports whether it is linked).
 * Throws V5Error NO_RESPONSE (user port, wrong device, cable in nothing), NOT_V5, or
 * CONTROLLER_NOT_LINKED.
 *
 * @param {{readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>}} port opened SerialPort
 * @param {{readTimeoutMs?: number, defaultTimeout?: number, retries?: number}} [opts]
 */
export async function queryBrain(port, opts = {}) {
  const { conn, dev } = openDevice(port, opts);
  try {
    const version = await firstContact(dev);
    if (version.product === PRODUCT.CONTROLLER && !version.connected) {
      throw v5Error('CONTROLLER_NOT_LINKED', version);
    }
    const status = await dev.getSystemStatus();
    return { ...version, wireless: version.product === PRODUCT.CONTROLLER, status };
  } finally {
    await conn.close();
  }
}

/**
 * Upload a PROS program the way `pros upload` does (quirk 0).
 *
 * @param {{readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>}} port opened SerialPort
 * @param {object} o
 * @param {Uint8Array|ArrayBuffer} o.bin       monolith.bin, or hot.package.bin when coldBin is given
 * @param {Uint8Array|ArrayBuffer} [o.coldBin] cold.package.bin (hot/cold linked upload)
 * @param {string} [o.coldName]                library name on the brain; or give coldTemplates
 * @param {string[]} [o.coldTemplates]         template names in project.pros order, e.g. ['LemLib', 'kernel', 'liblvgl']
 * @param {number} o.slot                      1..8, as shown on the brain
 * @param {string} o.name                      program name ('@' becomes '_', cut to 23 chars)
 * @param {string} [o.description]            default 'Made with PROS'
 * @param {string} [o.icon]                    icon file or a PROS_ICONS key; default 'USER902x.bmp'
 * @param {string} [o.ideVersion]              [project] version in the ini; pros-cli writes the project's
 *                                             kernel version. Default '4.2.2' (the 40217S kernel)
 * @param {string} [o.programVersion]          [program] version, default '0.0.0'
 * @param {'none'|'run'|'screen'|boolean} [o.runAfter] default 'none' (pros-cli's own default is 'screen')
 * @param {boolean} [o.compress]               gzip the binaries, default true
 * @param {(data: Uint8Array) => Promise<Uint8Array>|Uint8Array} [o.gzip] default prosGzip (byte-identical to the PROS CLI)
 * @param {(p: {stage: string, file?: string, sent?: number, total?: number}) => void} [o.onProgress]
 */
export async function uploadProgram(port, o) {
  if (!o || !o.bin) throw v5Error('BAD_INPUT', 'No program binary given.');
  const bin = toBytes(o.bin, 'bin');
  const cold = o.coldBin ? toBytes(o.coldBin, 'coldBin') : null;
  if (!Number.isInteger(o.slot) || o.slot < 1 || o.slot > 8) throw v5Error('BAD_INPUT', 'Slot must be 1 to 8.');
  if (!o.name) throw v5Error('BAD_INPUT', 'Program name is required.');
  if (cold && !o.coldName && !o.coldTemplates) {
    throw v5Error('BAD_INPUT', 'A cold package needs coldName or coldTemplates.');
  }
  const name = programRemoteName(o.name);
  const icon = PROS_ICONS[o.icon] ?? o.icon ?? PROS_ICONS.pros;
  const description = o.description ?? DEFAULT_DESCRIPTION;
  // Validate the ini text (ASCII, ConfigParser '%' rule) before touching the port.
  ascii(generateIni({ name, slot: o.slot - 1, ideVersion: o.ideVersion ?? DEFAULT_IDE_VERSION, programVersion: o.programVersion, icon, description }));
  const runAfter = runAfterOption(o.runAfter);
  const compress = o.compress ?? true;
  const gzip = o.gzip ?? prosGzip;
  const report = (p) => o.onProgress?.(p);

  const { conn, dev, now } = openDevice(port, o);
  try {
    report({ stage: 'connect' });
    let linkedName = null;
    if (cold) {
      // pros-cli computes the cold name (which reads system status) before opening the download channel.
      const status = await dev.status();
      linkedName = o.coldName ?? coldHashName(o.coldTemplates, status.cpu0Version);
    }
    await withDownloadChannel(dev, async () => {
      const status = await dev.status();
      const slot0 = o.slot - 1;
      const ini = generateIni({
        name, slot: slot0, ide: 'PROS', ideVersion: o.ideVersion ?? DEFAULT_IDE_VERSION, programVersion: o.programVersion,
        icon, description, date: now(), cpu0Version: status.cpu0Version,
      });
      const hotAddr = cold ? (o.hotAddr ?? DEFAULT_HOT_ADDR) : undefined;
      if (cold) {
        report({ stage: 'library', file: linkedName });
        const uploaded = await uploadLibrary(dev, cold, linkedName, {
          addr: o.coldAddr ?? DEFAULT_COLD_ADDR, compress, gzip, confirmEviction: o.confirmEviction,
          onErase: (programs) => report({ stage: 'erased', programs }),
          confirmLargeWireless: o.confirmLargeWireless,
          onProgress: (p) => report({ stage: 'library', ...p }),
        });
        if (!uploaded) report({ stage: 'library-skipped', file: linkedName });
      }
      report({ stage: 'stop' });
      await dev.executeProgramFile('', { run: false });
      report({ stage: 'ini' });
      // pros-cli passes the hot address to the ini transfer too.
      await writeFile(dev, ascii(ini), `slot_${o.slot}.ini`, {
        type: 'ini', addr: hotAddr, confirmLargeWireless: o.confirmLargeWireless,
        onProgress: (p) => report({ stage: 'ini', ...p }),
      });
      report({ stage: 'bin' });
      await writeFile(dev, bin, `slot_${o.slot}.bin`, {
        type: 'bin', runAfter, linkedFilename: linkedName, compress, gzip, addr: hotAddr,
        confirmLargeWireless: o.confirmLargeWireless, onProgress: (p) => report({ stage: 'bin', ...p }),
      });
    });
    report({ stage: 'done' });
    return { slot: o.slot, name, linkedName };
  } finally {
    await conn.close();
  }
}

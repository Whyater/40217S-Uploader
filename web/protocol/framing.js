// Ported from the PROS CLI (https://github.com/purduesigbots/pros-cli).
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Packet framing and payload layouts for the V5 system port.
 * Every builder here mirrors a pros-cli function (named in its comment).
 */
import { VEX_CRC16 } from './crc.js';
import { NACKS, nackError, v5Error } from './errors.js';

export const TX_HEADER = [0xc9, 0x36, 0xb8, 0x47];
export const RX_HEADER = [0xaa, 0x55];
export const EXT_COMMAND = 0x56;
export const ACK_BYTE = 0x76;

export const VID = { user: 1, system: 15, rms: 16, pros: 24, mw: 32 };
export const CHANNEL = { pit: 0, download: 1 };
export const FT_FUNCTION = { upload: 1, download: 2 };
export const FT_TARGET = { ddr: 0, flash: 1, screen: 2 };
/** V5Device.FTCompleteOptions */
export const FT_COMPLETE = { none: 0, run: 0b01, screen: 0b11 };
export const PRODUCT = { BRAIN: 0x10, CONTROLLER: 0x11 };
export const CONNECTED_FLAG = 0x02;

export function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** ASCII-encode like Python's str.encode('ascii'); throws on anything else. */
export function ascii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 0x7f) throw v5Error('BAD_INPUT', `Only plain ASCII text is allowed (got "${str}").`);
    out[i] = c;
  }
  return out;
}

export function resolveVid(vid) {
  if (typeof vid === 'number') return vid;
  const v = VID[String(vid).toLowerCase()];
  if (v === undefined) throw v5Error('BAD_INPUT', `Unknown vid ${vid}`);
  return v;
}

/** Little-endian struct packer covering the formats pros-cli uses ('<B', '<H', '<I', '<Ns'). */
export class Packer {
  constructor() {
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v) {
    v >>>= 0;
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  /** struct 'Ns': truncate or zero-pad to exactly n bytes. */
  str(data, n) {
    const b = typeof data === 'string' ? ascii(data) : data;
    for (let i = 0; i < n; i++) this.bytes.push(i < b.length ? b[i] : 0);
    return this;
  }
  raw(data) {
    for (const b of data) this.bytes.push(b);
    return this;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

export class Unpacker {
  constructor(bytes) {
    this.b = bytes;
    this.o = 0;
  }
  skip(n) {
    this.o += n;
    return this;
  }
  u8() {
    return this.b[this.o++];
  }
  u16() {
    const v = this.b[this.o] | (this.b[this.o + 1] << 8);
    this.o += 2;
    return v;
  }
  i16() {
    const v = this.u16();
    return v & 0x8000 ? v - 0x10000 : v;
  }
  u32() {
    const v = (this.b[this.o] | (this.b[this.o + 1] << 8) | (this.b[this.o + 2] << 16) | (this.b[this.o + 3] << 24)) >>> 0;
    this.o += 4;
    return v;
  }
  bytes(n) {
    const v = this.b.slice(this.o, this.o + n);
    this.o += n;
    return v;
  }
  /** pros.serial.decode_bytes_to_str: cut at the first NUL, decode UTF-8. */
  cstr(n) {
    const b = this.bytes(n);
    const z = b.indexOf(0);
    return new TextDecoder().decode(z >= 0 ? b.slice(0, z) : b);
  }
}

/** VEXDevice._form_simple_packet */
export function formSimplePacket(command) {
  return Uint8Array.from([...TX_HEADER, command]);
}

/** V5Device._form_extended_payload: [cmd, len(1 or 2 bytes), payload, crc16 hi, crc16 lo] */
export function formExtendedPayload(command, payload = new Uint8Array(0)) {
  const n = payload.length;
  if (n > 0x7fff) throw v5Error('BAD_INPUT', `Extended payload too large (${n} bytes)`);
  const len = n >= 0x80 ? [(n >> 8) | 0x80, n & 0xff] : [n];
  const body = concat(Uint8Array.from([command, ...len]), payload);
  const crc = VEX_CRC16.compute(concat(formSimplePacket(EXT_COMMAND), body));
  return concat(body, Uint8Array.from([crc >> 8, crc & 0xff]));
}

/** Full bytes on the wire for an extended (0x56) command. */
export function buildExtPacket(command, payload) {
  return concat(formSimplePacket(EXT_COMMAND), formExtendedPayload(command, payload));
}

/**
 * V5Device._rx_ext_packet: validate a 0x56 response and return the data after the ACK.
 * `msg` is { command, payload, raw } from the receive step.
 */
export function parseExtResponse(msg, command, rxLength, { checkAck = true, checkLength = true, exact = false } = {}) {
  if (msg.command !== EXT_COMMAND) throw v5Error('BAD_RESPONSE', { why: 'not an extended reply', got: msg.command });
  const crc = VEX_CRC16.compute(msg.raw);
  if (crc !== 0) throw v5Error('BAD_RESPONSE', { why: 'reply CRC mismatch', crc });
  if (msg.payload[0] !== command) {
    throw v5Error('BAD_RESPONSE', { why: 'reply is for another command', expected: command, got: msg.payload[0] });
  }
  let data = msg.payload.slice(1, msg.payload.length - 2);
  if (checkAck) {
    if (data.length === 0) throw v5Error('BAD_RESPONSE', { why: 'empty reply' });
    const ack = data[0];
    if (ack !== ACK_BYTE) {
      if (ack in NACKS) throw nackError(ack, command);
      throw v5Error('BAD_RESPONSE', { why: "device didn't ACK", got: ack });
    }
    data = data.slice(1);
  }
  if (checkLength && data.length < rxLength) {
    throw v5Error('BAD_RESPONSE', { why: `reply shorter than ${rxLength}`, got: data.length });
  }
  // pros-cli only warns on a longer reply, but struct.unpack then fails, so struct replies must match exactly.
  if (exact && data.length !== rxLength) {
    throw v5Error('BAD_RESPONSE', { why: `reply length ${data.length}, expected ${rxLength}` });
  }
  return data;
}

// ---------- payload builders ----------

/** ft_transfer_channel: struct '<2B' (1, channel) */
export function transferChannelPayload(channel) {
  const c = typeof channel === 'string' ? CHANNEL[channel] : channel;
  return new Packer().u8(1).u8(c).done();
}

/** ft_initialize: struct '<4B3I4s2I24s' */
export function ftInitializePayload(o) {
  const fn = typeof o.function === 'string' ? FT_FUNCTION[o.function.toLowerCase()] : o.function;
  const target = typeof o.target === 'string' ? FT_TARGET[o.target.toLowerCase()] : o.target;
  const options = (o.options ?? 0) | (o.overwrite === false ? 0 : 1);
  return new Packer()
    .u8(fn)
    .u8(target)
    .u8(resolveVid(o.vid))
    .u8(options)
    .u32(o.length)
    .u32(o.addr)
    .u32(o.crc)
    .str(o.type, 4)
    .u32(o.timestamp)
    .u32(o.version ?? 0x01000000)
    .str(o.name, 24)
    .done();
}

/** ft_write: struct '<I{n}s', data zero-padded to a multiple of 4 */
export function ftWritePayload(addr, data) {
  const pad = data.length % 4 === 0 ? 0 : 4 - (data.length % 4);
  return new Packer().u32(addr).raw(data).raw(new Uint8Array(pad)).done();
}

/** ft_complete: struct '<B' */
export function ftCompletePayload(option) {
  return Uint8Array.from([option & 0xff]);
}

/** '<2B24s' (vid, options, name): ft_set_link, execute_program_file, get_file_metadata_by_name, erase_file */
export function vidOptionsNamePayload(vid, options, name) {
  return new Packer().u8(resolveVid(vid)).u8(options).str(name, 24).done();
}

/** get_dir_count / get_file_metadata_by_idx: '<2B' */
export function twoBytePayload(a, b) {
  return Uint8Array.from([a & 0xff, b & 0xff]);
}

// ---------- reply parsers ----------

/** V5Device.SystemVersion from the '>8B' reply to simple command 0xA4 */
export function parseSystemVersion(p) {
  return {
    systemVersion: `${p[0]}.${p[1]}.${p[2]}-${p[3]}.${p[4]}`,
    product: p[5],
    productName: p[5] === PRODUCT.BRAIN ? 'BRAIN' : p[5] === PRODUCT.CONTROLLER ? 'CONTROLLER' : 'UNKNOWN',
    productFlags: p[6],
    connected: (p[6] & CONNECTED_FLAG) !== 0,
  };
}

/** V5Device.SystemStatus from '<x12B3xBI12x[B3x]' */
export function parseSystemStatus(p) {
  const u = new Unpacker(p).skip(1);
  const v = () => `${u.u8()}.${u.u8()}.${u.u8()}-${u.u8()}`;
  const systemVersion = v();
  const cpu0Version = v();
  const cpu1Version = v();
  u.skip(3);
  const touchVersion = u.u8();
  const systemId = u.u32();
  return { systemVersion, cpu0Version, cpu1Version, touchVersion, systemId };
}

/** ft_initialize reply '<H2I' */
export function parseFtInit(p) {
  const u = new Unpacker(p);
  return { maxPacketSize: u.u16(), fileSize: u.u32(), crc: u.u32() };
}

/** get_file_metadata_by_idx / _by_name reply '<B3L4sLL24s' */
export function parseFileMetadata(p, byName) {
  const u = new Unpacker(p);
  const first = u.u8();
  const size = u.u32();
  const addr = u.u32();
  const crc = u.u32();
  const type = u.cstr(4);
  const timestamp = u.u32();
  const version = u.u32();
  const name = u.cstr(24);
  return byName
    ? { linkedVid: first, size, addr, crc, type, timestamp, version, linkedFilename: name }
    : { idx: first, size, addr, crc, type, timestamp, version, filename: name };
}

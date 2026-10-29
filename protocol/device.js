// Ported from the PROS CLI (https://github.com/purduesigbots/pros-cli).
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * V5 system-port commands, ported from pros-cli VEXDevice + V5Device.
 * Each public command retries like pros-cli's @retries decorator (3 retries, so 4 tries).
 */
import { VEX_CRC32 } from './crc.js';
import { V5Error, v5Error } from './errors.js';
import {
  EXT_COMMAND, FT_COMPLETE, PRODUCT, RX_HEADER,
  buildExtPacket, formSimplePacket, ftCompletePayload, ftInitializePayload, ftWritePayload,
  parseExtResponse, parseFileMetadata, parseFtInit, parseSystemStatus, parseSystemVersion,
  resolveVid, transferChannelPayload, twoBytePayload, vidOptionsNamePayload,
} from './framing.js';
import { vexTimestamp, versionMatches } from './program.js';

export class V5Device {
  /**
   * @param {import('./connection.js').SerialConnection} conn
   * @param {{defaultTimeout?: number, retries?: number, now?: () => Date, log?: (msg: string) => void}} [opts]
   *   defaultTimeout is in seconds, like pros-cli (0.1 s; each byte read can still wait readTimeoutMs).
   */
  constructor(conn, { defaultTimeout = 0.1, retries = 3, now = () => new Date(), log } = {}) {
    this.conn = conn;
    this.defaultTimeout = defaultTimeout;
    this.retries = retries;
    this.now = now;
    this.log = log ?? (() => {});
    this._status = null;
  }

  async _retry(fn) {
    let last;
    for (let i = 0; i <= this.retries; i++) {
      try {
        return await fn();
      } catch (e) {
        // A closed port or bad caller input won't fix itself, so don't retry those.
        if (e instanceof V5Error && (e.code === 'PORT_CLOSED' || e.code === 'BAD_INPUT')) throw e;
        last = e;
        this.log(`retry ${i + 1}: ${e.message}`);
      }
    }
    throw last;
  }

  // ---------- packet layer (VEXDevice) ----------

  /** VEXDevice._tx_packet: flush input, write. */
  async txPacket(bytes) {
    this.conn.discardInput();
    await this.conn.write(bytes);
    return bytes;
  }

  /** VEXDevice._rx_packet: hunt for AA 55, then command, length (extended for 0x56), payload. */
  async rxPacket(timeout = this.defaultTimeout) {
    const start = Date.now();
    let found = 0;
    let rx = [];
    while ((rx.length > 0 || Date.now() - start < timeout * 1000) && found < RX_HEADER.length) {
      const b = await this.conn.read(1);
      if (b.length === 0) {
        if (rx.length > 0) break; // pros-cli would spin forever here; give up instead
        continue;
      }
      if (b[0] === RX_HEADER[found]) {
        found++;
        rx.push(b[0]);
      } else {
        found = 0;
        rx = [];
      }
    }
    if (found < RX_HEADER.length) {
      throw v5Error('NO_RESPONSE', { why: `no response header after ${timeout} s`, got: rx });
    }
    const head = await this.conn.read(2);
    if (head.length < 2) throw v5Error('NO_RESPONSE', { why: 'reply cut off after header' });
    rx.push(head[0], head[1]);
    const command = head[0];
    let length = head[1];
    if (command === EXT_COMMAND && (length & 0x80) === 0x80) {
      const ext = await this.conn.read(1);
      if (ext.length < 1) throw v5Error('NO_RESPONSE', { why: 'reply cut off in length' });
      rx.push(ext[0]);
      length = ((length & 0x7f) << 8) + ext[0];
    }
    const payload = await this.conn.read(length);
    const raw = Uint8Array.from([...rx, ...payload]);
    return { command, payload, raw };
  }

  async txrxSimple(command, rxLen, timeout) {
    await this.txPacket(formSimplePacket(command));
    const msg = await this.rxPacket(timeout);
    if (msg.command !== command) throw v5Error('BAD_RESPONSE', { why: 'reply command mismatch', got: msg.command });
    if (msg.payload.length !== rxLen) {
      throw v5Error('BAD_RESPONSE', { why: "reply length doesn't match", got: msg.payload.length });
    }
    return msg.payload;
  }

  /** V5Device._txrx_ext_packet (+ _txrx_ext_struct when exact is set). */
  async txrxExt(command, payload, rxLength, { timeout, checkAck = true, checkLength = true, exact = false } = {}) {
    await this.txPacket(buildExtPacket(command, payload));
    const msg = await this.rxPacket(timeout ?? this.defaultTimeout);
    return parseExtResponse(msg, command, rxLength, { checkAck, checkLength, exact });
  }

  // ---------- commands ----------

  /** Simple 0xA4: system version, product (brain/controller), flags. */
  querySystemVersion() {
    return this._retry(async () => {
      const p = await this.txrxSimple(0xa4, 8);
      const v = parseSystemVersion(p);
      if (v.product !== PRODUCT.BRAIN && v.product !== PRODUCT.CONTROLLER) {
        throw new V5Error('NOT_V5', "Something answered, but it isn't a V5 brain or controller system port.", {
          detail: { product: v.product },
        });
      }
      return v;
    });
  }

  /** Ext 0x22 (get_system_status). Calls querySystemVersion first to pick the reply layout. */
  getSystemStatus() {
    return this._retry(async () => {
      const v = await this.querySystemVersion();
      const short = (v.product === PRODUCT.BRAIN && versionMatches(v.systemVersion, '<', '1.0.13')) ||
        (v.product === PRODUCT.CONTROLLER && versionMatches(v.systemVersion, '<', '1.0.0-0.70'));
      const len = short ? 33 : 37;
      const p = await this.txrxExt(0x22, new Uint8Array(0), len, { exact: true });
      return parseSystemStatus(p);
    });
  }

  /** Cached status, like the V5Device.status property. */
  async status() {
    if (!this._status) this._status = await this.getSystemStatus();
    return this._status;
  }

  /** V5Device.can_compress: system version >= 1.0.5 */
  async canCompress() {
    return versionMatches((await this.status()).systemVersion, '>=', '1.0.5');
  }

  /** V5Device.is_wireless: plugged into a controller that is linked to a brain. */
  async isWireless() {
    const v = await this.querySystemVersion();
    return v.product === PRODUCT.CONTROLLER && v.connected;
  }

  /** Ext 0x10 */
  ftTransferChannel(channel) {
    return this._retry(() => this.txrxExt(0x10, transferChannelPayload(channel), 0));
  }

  /** Ext 0x11. Returns { maxPacketSize, fileSize, crc }. */
  ftInitialize(fileName, o = {}) {
    return this._retry(async () => {
      const payload = ftInitializePayload({
        function: 'upload', target: 'flash', vid: 'user', overwrite: true, options: 0, length: 0,
        addr: 0x03800000, crc: 0, type: 'bin', version: 0x01000000, name: fileName,
        ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)),
        timestamp: vexTimestamp(o.timestamp ?? this.now()),
      });
      const p = await this.txrxExt(0x11, payload, 10, { timeout: o.timeout ?? this.defaultTimeout * 5, exact: true });
      return parseFtInit(p);
    });
  }

  /** Ext 0x12. options: FT_COMPLETE value (0 none, 1 run, 3 run screen). timeout in seconds. */
  ftComplete(options = FT_COMPLETE.none, timeout = 1.0) {
    const opt = typeof options === 'boolean' ? (options ? FT_COMPLETE.run : FT_COMPLETE.none) : options;
    return this._retry(() => this.txrxExt(0x12, ftCompletePayload(opt), 0, { timeout }));
  }

  /** Ext 0x13 */
  ftWrite(addr, data) {
    return this._retry(() => this.txrxExt(0x13, ftWritePayload(addr, data), 0));
  }

  /** Ext 0x15 */
  ftSetLink(linkName, vid = 'user', options = 0) {
    return this._retry(() => this.txrxExt(0x15, vidOptionsNamePayload(vid, options, linkName), 0));
  }

  /** Ext 0x16 */
  getDirCount(vid = 1, options = 0) {
    return this._retry(async () => {
      const p = await this.txrxExt(0x16, twoBytePayload(resolveVid(vid), options), 2, { exact: true });
      const v = p[0] | (p[1] << 8);
      return v & 0x8000 ? v - 0x10000 : v;
    });
  }

  /** Ext 0x17 */
  getFileMetadataByIdx(idx, options = 0) {
    return this._retry(async () =>
      parseFileMetadata(await this.txrxExt(0x17, twoBytePayload(idx, options), 49, { exact: true }), false));
  }

  /** Ext 0x18. run=false (options 0x80) stops the running program. */
  executeProgramFile(fileName, { vid = 'user', run = true } = {}) {
    return this._retry(() => this.txrxExt(0x18, vidOptionsNamePayload(vid, run ? 0 : 0x80, fileName), 0));
  }

  /** Ext 0x19 */
  getFileMetadataByName(fileName, vid = 1, options = 0) {
    return this._retry(async () =>
      parseFileMetadata(await this.txrxExt(0x19, vidOptionsNamePayload(vid, options, fileName), 49, { exact: true }), true));
  }

  /** Ext 0x1B, then ft_complete (inside the same retry, like pros-cli). */
  eraseFile(fileName, { eraseAll = false, vid = 'user' } = {}) {
    return this._retry(async () => {
      const r = await this.txrxExt(0x1b, vidOptionsNamePayload(vid, eraseAll ? 0x80 : 0, fileName), 0);
      await this.ftComplete();
      return r;
    });
  }
}

export function crc32(data) {
  return VEX_CRC32.compute(data);
}

// Ported from the PROS CLI (https://github.com/purduesigbots/pros-cli).
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Table-driven, non-reflected CRC, same algorithm as pros-cli's crc.py.
 * Initial value 0, no final XOR.
 */
export class CRC {
  constructor(size, polynomial) {
    this.size = size;
    this.mask = size === 32 ? 0xffffffff : (1 << size) - 1;
    const top = size === 32 ? 0x80000000 : 1 << (size - 1);
    this.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let acc = (i << (size - 8)) >>> 0;
      for (let j = 0; j < 8; j++) {
        acc = acc & top ? (acc << 1) ^ polynomial : acc << 1;
        acc = (acc & this.mask) >>> 0;
      }
      this.table[i] = acc;
    }
  }

  compute(data, accumulator = 0) {
    const shift = this.size - 8;
    let acc = accumulator >>> 0;
    for (let k = 0; k < data.length; k++) {
      const i = ((acc >>> shift) ^ data[k]) & 0xff;
      acc = (((acc << 8) ^ this.table[i]) & this.mask) >>> 0;
    }
    return acc;
  }
}

/** CRC-16-CCITT (XMODEM form), used on every extended packet. */
export const VEX_CRC16 = new CRC(16, 0x1021);
/** CRC-32 poly 0x04C11DB7, non-reflected, init 0. Used for whole-file checksums. */
export const VEX_CRC32 = new CRC(32, 0x04c11db7);

const GZIP_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** Standard (reflected) CRC-32 used in the gzip trailer, same as zlib.crc32. */
export function gzipCrc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = GZIP_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

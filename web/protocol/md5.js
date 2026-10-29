/**
 * Small MD5 (RFC 1321). Web Crypto has no MD5, and PROS names the cold
 * library with an MD5 hash, so we need our own.
 */
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(bytes) {
  const len = bytes.length;
  const nBlocks = ((len + 8) >>> 6) + 1;
  const words = new Uint32Array(nBlocks * 16);
  for (let i = 0; i < len; i++) words[i >>> 2] |= bytes[i] << ((i % 4) * 8);
  words[len >>> 2] |= 0x80 << ((len % 4) * 8);
  const bitLen = len * 8;
  words[nBlocks * 16 - 2] = bitLen >>> 0;
  words[nBlocks * 16 - 1] = Math.floor(bitLen / 2 ** 32);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let blk = 0; blk < nBlocks; blk++) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + words[blk * 16 + g]) | 0;
      A = D; D = C; C = B;
      const s = S[(i >>> 4) * 4 + (i % 4)];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((w, j) => {
    for (let k = 0; k < 4; k++) out[j * 4 + k] = (w >>> (8 * k)) & 0xff;
  });
  return out;
}

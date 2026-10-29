import { VEX_CRC16 } from '../../protocol/crc.js';

export const hex = (b) => Buffer.from(b).toString('hex');
export const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

/**
 * A port that expects exactly the packets in `log` (recorded from pros-cli) and
 * answers each with the recorded reply. Mismatches are collected, not answered.
 */
export function replayPort(log) {
  let ctrl;
  const readable = new ReadableStream({ start(c) { ctrl = c; } });
  const state = { index: 0, mismatches: [], extra: [] };
  const writable = new WritableStream({
    write(chunk) {
      const tx = hex(chunk);
      const exp = log[state.index];
      if (!exp) {
        state.extra.push(tx);
        return;
      }
      if (tx !== exp.tx) {
        state.mismatches.push({ index: state.index, got: tx, expected: exp.tx });
        return;
      }
      state.index++;
      const rx = unhex(exp.rx);
      setTimeout(() => ctrl.enqueue(rx), 0);
    },
  });
  return { port: { readable, writable }, state };
}

function extReply(cmd, ack, data = []) {
  const body = [cmd, ack, ...data];
  const n = body.length + 2;
  const len = n >= 0x80 ? [(n >> 8) | 0x80, n & 0xff] : [n];
  const pkt = Uint8Array.from([0xaa, 0x55, 0x56, ...len, ...body]);
  const crc = VEX_CRC16.compute(pkt);
  return Uint8Array.from([...pkt, crc >> 8, crc & 0xff]);
}

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const rdU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const cstr = (b) => {
  const z = b.indexOf(0);
  return Buffer.from(z >= 0 ? b.slice(0, z) : b).toString('ascii');
};

/**
 * Scripted fake V5 brain. Parses every packet (checking the CRC), answers like
 * a brain, and keeps the files it was sent.
 *
 * opts.product      0x10 brain / 0x11 controller
 * opts.flags        product flags byte from 0xA4 (0x02 = controller linked)
 * opts.maxPacket    max_packet_size returned by ft_initialize
 * opts.nack         { [extCmd]: [code, code, ...] } NACK the next calls with these codes
 * opts.silentAfter  stop answering after this many packets (timeout tests)
 * opts.silent       never answer
 * opts.answer(pkt)  optional override: return Uint8Array to send instead
 */
export function fakeBrain(opts = {}) {
  const {
    product = 0x10, flags = 0x00, maxPacket = 512, nack = {}, silentAfter = Infinity, silent = false,
    version = [1, 1, 5, 0, 13], status = [1, 1, 5, 0], answer,
  } = opts;
  let ctrl;
  const readable = new ReadableStream({ start(c) { ctrl = c; } });
  const brain = { packets: [], files: {}, current: null, port: null };
  const nackQ = Object.fromEntries(Object.entries(nack).map(([k, v]) => [k, [...v]]));

  function respond(b) {
    if (b[0] !== 0xc9 || b[1] !== 0x36 || b[2] !== 0xb8 || b[3] !== 0x47) throw new Error('bad header');
    const cmd = b[4];
    if (cmd === 0xa4) {
      brain.packets.push({ cmd: 'A4' });
      return Uint8Array.from([0xaa, 0x55, 0xa4, 0x08, ...version, product, flags, 0]);
    }
    if (cmd !== 0x56) throw new Error('unknown simple command');
    if (VEX_CRC16.compute(b) !== 0) throw new Error('bad CRC on tx packet');
    const ext = b[5];
    let n = b[6];
    let off = 7;
    if (n & 0x80) {
      n = ((n & 0x7f) << 8) + b[7];
      off = 8;
    }
    const p = b.slice(off, off + n);
    if (p.length !== n || off + n + 2 !== b.length) throw new Error('bad ext length');
    const rec = { cmd: ext.toString(16).padStart(2, '0'), payload: p };
    brain.packets.push(rec);
    const q = nackQ[ext];
    if (q && q.length) return extReply(ext, q.shift());
    switch (ext) {
      case 0x10: return extReply(ext, 0x76);
      case 0x11: {
        const length = rdU32(p, 4);
        brain.current = {
          vid: p[2], length, addr: rdU32(p, 8), crc: rdU32(p, 12), type: cstr(p.slice(16, 20)),
          name: cstr(p.slice(28, 52)), data: new Uint8Array(length), link: null, writes: [],
        };
        rec.name = brain.current.name;
        return extReply(ext, 0x76, [maxPacket & 0xff, maxPacket >> 8, ...u32(length), ...u32(0)]);
      }
      case 0x13: {
        const addr = rdU32(p, 0);
        const data = p.slice(4);
        const c = brain.current;
        c.writes.push({ addr, size: data.length });
        const off2 = addr - c.addr;
        c.data.set(data.slice(0, Math.max(0, Math.min(data.length, c.length - off2))), off2);
        return extReply(ext, 0x76);
      }
      case 0x15:
        brain.current.link = { vid: p[0], name: cstr(p.slice(2, 26)) };
        return extReply(ext, 0x76);
      case 0x12:
        rec.option = p[0];
        if (brain.current) {
          brain.files[`${brain.current.vid}/${brain.current.name}`] = brain.current;
          brain.current = null;
        }
        return extReply(ext, 0x76);
      case 0x18: return extReply(ext, 0x76);
      case 0x19: return extReply(ext, 0xd9); // nothing on the brain yet
      case 0x16: return extReply(ext, 0x76, [0, 0]);
      case 0x22: return extReply(ext, 0x76, [0, ...status, ...status, ...status, 0, 0, 0, 3, ...u32(0x1234), ...new Array(12).fill(0), 0, 0, 0, 0]);
      default: throw new Error(`fake brain: unhandled ext 0x${ext.toString(16)}`);
    }
  }

  const writable = new WritableStream({
    write(chunk) {
      const b = new Uint8Array(chunk);
      const count = brain.packets.length;
      if (silent || count >= silentAfter) {
        brain.packets.push({ cmd: 'ignored', raw: hex(b) });
        return;
      }
      const reply = answer?.(b, brain) ?? respond(b);
      setTimeout(() => ctrl.enqueue(reply), 1);
    },
  });
  brain.port = { readable, writable };
  return brain;
}

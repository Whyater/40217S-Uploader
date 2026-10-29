// Ported from the PROS CLI (https://github.com/purduesigbots/pros-cli).
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Byte-level link over an opened Web Serial port.
 *
 * Port contract: any object shaped like an *opened* Web Serial `SerialPort`:
 *   { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> }
 * A native `navigator.serial` port and the WebUSB serial polyfill both fit.
 * The caller opens the port (PROS uses 115200 8N1) and closes it afterwards.
 * We take a reader and a writer for the length of one operation and release
 * both locks when done, so the port stays usable.
 */
import { v5Error } from './errors.js';

export class SerialConnection {
  /**
   * @param {{readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>}} port
   * @param {{readTimeoutMs?: number}} [opts] readTimeoutMs mirrors pyserial's 1 s read timeout in pros-cli.
   */
  constructor(port, { readTimeoutMs = 1000 } = {}) {
    if (!port || !port.readable || !port.writable) {
      throw v5Error('BAD_INPUT', 'Port must be opened first (needs .readable and .writable).');
    }
    this.port = port;
    this.readTimeoutMs = readTimeoutMs;
    this.buf = new Uint8Array(0);
    this.closed = false;
    this.error = null;
    this.waiters = new Set();
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.pump = this.#pumpLoop();
  }

  async #pumpLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          const next = new Uint8Array(this.buf.length + value.length);
          next.set(this.buf);
          next.set(value, this.buf.length);
          this.buf = next;
          this.#wake();
        }
      }
    } catch (e) {
      if (!this.released) this.error = e;
    }
    this.closed = true;
    this.#wake();
  }

  #wake() {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  #waitForData(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** pyserial read_all(): drop anything already received. */
  discardInput() {
    this.buf = new Uint8Array(0);
  }

  async write(bytes) {
    if (this.closed && !this.released) throw v5Error('PORT_CLOSED', String(this.error ?? 'stream ended'));
    try {
      await this.writer.write(bytes);
    } catch (e) {
      throw v5Error('PORT_CLOSED', String(e), e);
    }
  }

  /**
   * pyserial read(n): wait up to timeoutMs for n bytes; on timeout return
   * whatever arrived (possibly fewer than n, possibly none).
   */
  async read(n, timeoutMs = this.readTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.closed) {
        if (this.buf.length === 0) throw v5Error('PORT_CLOSED', String(this.error ?? 'stream ended'));
        break;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await this.#waitForData(left);
    }
    const take = Math.min(n, this.buf.length);
    const out = this.buf.slice(0, take);
    this.buf = this.buf.slice(take);
    return out;
  }

  /** Release the reader and writer locks. Does not close the port. */
  async close() {
    if (this.released) return;
    this.released = true;
    try {
      this.writer.releaseLock();
    } catch {
      /* already released */
    }
    try {
      // Current browsers reject the pending read on release; the pump loop catches that.
      this.reader.releaseLock();
    } catch {
      // Older Chromium refuses to release with a read pending, so cancel the stream instead.
      await this.reader.cancel().catch(() => {});
    }
    await Promise.race([this.pump.catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
  }
}

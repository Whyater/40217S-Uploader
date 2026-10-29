// The default gzip must match the installed PROS CLI byte for byte on the team's real
// cold library, or upload_library replaces it and erases every program linked to it.
// Reference: /usr/lib/libz.1.dylib called directly (what the CLI's Python 3.10 zlib loads),
// plus this machine's Python gzip at level 9, both via test/protocol/gzip_reference.py.
//
// Binaries are not committed. Fetch them with:
//   gh release download -R Whyater/40217S-Uploader -p cold.package.bin -p tester-cold.package.bin \
//     -p hot.package.bin -D /tmp/coldtest --clobber
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VEX_CRC32 } from '../../protocol/crc.js';
import { prosGzip } from '../../protocol/program.js';

const DIR = process.env.COLDTEST_DIR ?? '/tmp/coldtest';
const SCRIPT = fileURLToPath(new URL('./gzip_reference.py', import.meta.url));
const hasPython = (() => {
  try {
    execFileSync('python3', ['-I', '-c', 'import ctypes'], { stdio: 'ignore' });
    return existsSync('/usr/lib/libz.1.dylib') || process.platform === 'darwin';
  } catch {
    return false;
  }
})();

for (const name of ['cold.package.bin', 'tester-cold.package.bin', 'hot.package.bin']) {
  const path = join(DIR, name);
  const skip = !existsSync(path)
    ? `${path} not found (download it from the Whyater/40217S-Uploader release, see the top of this file)`
    : !hasPython ? 'needs python3 and /usr/lib/libz.1.dylib (macOS)' : false;
  test(`gzip of real ${name} matches libz and Python byte for byte`, { skip, timeout: 120000 }, () => {
    const data = new Uint8Array(readFileSync(path));
    const out = mkdtempSync(join(tmpdir(), 'gzref-'));
    const versions = JSON.parse(execFileSync('python3', ['-I', SCRIPT, path, out], { encoding: 'utf8' }).trim());
    const libz = new Uint8Array(readFileSync(join(out, `${name}.libz.gz`)));
    const py = new Uint8Array(readFileSync(join(out, `${name}.py.gz`)));
    const js = prosGzip(data);
    const crc = (b) => VEX_CRC32.compute(b).toString(16).padStart(8, '0');
    console.log(`${name}: ${data.length} B -> ${js.length} B gz; VEX CRC32 js=${crc(js)} libz=${crc(libz)} ` +
      `py=${crc(py)} (libz ${versions.libz}, python ${versions.python})`);
    assert.deepEqual(js.subarray(0, 10), Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]));
    assert.ok(Buffer.from(js).equals(Buffer.from(libz)), 'JS gzip == libz via ctypes');
    assert.ok(Buffer.from(py).equals(Buffer.from(libz)), 'Python gzip (level 9) == libz via ctypes');
  });
}

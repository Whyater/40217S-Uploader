"""
Reference gzip outputs for checking the JS gzip against what pros-cli produces.

pros-cli (compress_file in pros/serial/devices/vex/v5_device.py) does:
    gzip.GzipFile(fileobj=BytesIO(), mode='wb', mtime=0), compresslevel 9,
    writing the input in 16 KiB pieces.
The installed macOS CLI bundles Python 3.10, whose zlib module loads
/usr/lib/libz.1.dylib. Python 3.10 writes the header 1f 8b 08 00 00000000 02 ff.

Usage:
    python3 -I gzip_reference.py INPUT OUTDIR

Writes into OUTDIR:
    <name>.libz.gz  /usr/lib/libz.1.dylib called directly through ctypes
                    (deflateInit2_ level 9, wbits -15, memLevel 8, strategy 0,
                    fed 16 KiB at a time, then Z_FINISH) with the 3.10 header
    <name>.py.gz    this interpreter's gzip.GzipFile as pros-cli calls it, but with
                    compresslevel=9 passed explicitly: Python 3.10 defaulted to 9,
                    newer Pythons default to 6, which would not match the CLI
And prints a JSON line with zlib versions.
"""
import ctypes
import gzip
import io
import json
import os
import sys
import zlib

CHUNK = 16 * 1024
PY310_HEADER = bytes([0x1F, 0x8B, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xFF])


class ZStream(ctypes.Structure):
    _fields_ = [
        ('next_in', ctypes.c_void_p), ('avail_in', ctypes.c_uint), ('total_in', ctypes.c_ulong),
        ('next_out', ctypes.c_void_p), ('avail_out', ctypes.c_uint), ('total_out', ctypes.c_ulong),
        ('msg', ctypes.c_char_p), ('state', ctypes.c_void_p),
        ('zalloc', ctypes.c_void_p), ('zfree', ctypes.c_void_p), ('opaque', ctypes.c_void_p),
        ('data_type', ctypes.c_int), ('adler', ctypes.c_ulong), ('reserved', ctypes.c_ulong),
    ]


def libz_raw_deflate(data: bytes, lib_path='/usr/lib/libz.1.dylib'):
    z = ctypes.CDLL(lib_path)
    z.zlibVersion.restype = ctypes.c_char_p
    version = z.zlibVersion()
    z.deflateInit2_.argtypes = [ctypes.POINTER(ZStream), ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    z.deflate.argtypes = [ctypes.POINTER(ZStream), ctypes.c_int]
    z.deflateEnd.argtypes = [ctypes.POINTER(ZStream)]
    z.deflateBound.argtypes = [ctypes.POINTER(ZStream), ctypes.c_ulong]
    z.deflateBound.restype = ctypes.c_ulong

    strm = ZStream()
    rc = z.deflateInit2_(ctypes.byref(strm), 9, 8, -15, 8, 0, version, ctypes.sizeof(ZStream))
    assert rc == 0, f'deflateInit2_ failed: {rc}'
    out = bytearray()
    outbuf = ctypes.create_string_buffer(z.deflateBound(ctypes.byref(strm), len(data)) + 1024)

    def pump(chunk: bytes, flush: int):
        inbuf = ctypes.create_string_buffer(chunk, len(chunk))
        strm.next_in = ctypes.cast(inbuf, ctypes.c_void_p)
        strm.avail_in = len(chunk)
        while True:
            strm.next_out = ctypes.cast(outbuf, ctypes.c_void_p)
            strm.avail_out = len(outbuf)
            rc = z.deflate(ctypes.byref(strm), flush)
            assert rc in (0, 1), f'deflate failed: {rc}'
            out.extend(outbuf.raw[:len(outbuf) - strm.avail_out])
            if flush == 4:
                if rc == 1:
                    return
            elif strm.avail_in == 0 and strm.avail_out != 0:
                return

    for i in range(0, len(data), CHUNK):
        pump(data[i:i + CHUNK], 0)  # Z_NO_FLUSH
    pump(b'', 4)  # Z_FINISH
    z.deflateEnd(ctypes.byref(strm))
    return bytes(out), version.decode()


def gzip_wrap(raw: bytes, data: bytes) -> bytes:
    trailer = (zlib.crc32(data) & 0xFFFFFFFF).to_bytes(4, 'little') + (len(data) & 0xFFFFFFFF).to_bytes(4, 'little')
    return PY310_HEADER + raw + trailer


def python_gzip(data: bytes) -> bytes:
    buf = io.BytesIO()
    src = io.BytesIO(data)
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as f:
        while True:
            piece = src.read(CHUNK)
            if not piece:
                break
            f.write(piece)
    return buf.getvalue()


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    with open(src, 'rb') as fh:
        data = fh.read()
    name = os.path.basename(src)
    raw, libz_version = libz_raw_deflate(data)
    with open(os.path.join(outdir, f'{name}.libz.gz'), 'wb') as fh:
        fh.write(gzip_wrap(raw, data))
    with open(os.path.join(outdir, f'{name}.py.gz'), 'wb') as fh:
        fh.write(python_gzip(data))
    print(json.dumps({'libz': libz_version, 'python': sys.version.split()[0],
                      'python_zlib_runtime': zlib.ZLIB_RUNTIME_VERSION}))


if __name__ == '__main__':
    main()

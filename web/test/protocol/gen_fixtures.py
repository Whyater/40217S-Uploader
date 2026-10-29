"""
Generate golden fixtures from the official PROS CLI source.

The JS uploader in src/protocol/ must produce byte-identical packets. This
script drives the real pros-cli V5Device against a scripted fake brain,
records every packet it writes (and what the fake answered), and dumps
everything to test/protocol/fixtures/*.json.

Setup (once):
    python3 -m venv /tmp/prosvenv
    pip download pros-cli --no-deps -d /tmp/proscli --proxy ""
    /tmp/prosvenv/bin/pip install --proxy "" /tmp/proscli/pros_cli-*.whl

Run from anywhere:
    /tmp/prosvenv/bin/python -I test/protocol/gen_fixtures.py

Pinned to pros-cli 3.5.6 (the version the fixtures were made with).
"""
import contextlib
import gzip
import io
import json
import os
import struct
import time
from datetime import datetime

import pros.serial.devices.vex.v5_device as v5mod
from pros.serial.devices.vex.crc import CRC
from pros.serial.devices.vex.v5_device import V5Device, compress_file

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
FIXED_NOW = datetime(2026, 10, 28, 17, 34, 56, 789000)
FIXED_NOW_NO_MICRO = datetime(2026, 1, 2, 3, 4, 5, 0)

CRC16 = CRC(16, 0x1021)


class FixedDatetime(datetime):
    fixed = FIXED_NOW

    @classmethod
    def now(cls, tz=None):
        f = cls.fixed
        return cls(f.year, f.month, f.day, f.hour, f.minute, f.second, f.microsecond)


v5mod.datetime = FixedDatetime


class GzipFile310(gzip.GzipFile):
    """The installed PROS CLI runs Python 3.10, where GzipFile defaults to compresslevel 9 (newer: 6)."""

    def __init__(self, filename=None, mode=None, compresslevel=9, fileobj=None, mtime=None):
        super().__init__(filename, mode, compresslevel, fileobj, mtime)


v5mod.gzip.GzipFile = GzipFile310
time_sleep = time.sleep
v5mod.time.sleep = lambda s: None  # controller channel switch sleeps; not needed against a fake


def lcg_bytes(n, seed):
    out = bytearray()
    x = seed
    for _ in range(n):
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        out.append((x >> 16) & 0xFF)
    return bytes(out)


def pad_name(name: str) -> bytes:
    return struct.pack('<24s', name.encode('ascii'))


class FakeBrain:
    """Scripted V5 that answers packets the way a brain does (per the PROS parser)."""

    def __init__(self, version8, status_payload, max_packet_size=512, dirs=None, metadata=None,
                 nack=None, controller_connect_after=0):
        self.version8 = bytearray(version8)
        self.status_payload = bytes(status_payload)
        self.max_packet_size = max_packet_size
        self.dirs = dirs or {}
        self.metadata = metadata or {}
        self.nack = nack or {}
        self.dir_vid = 1
        self.out = bytearray()
        self.log = []
        self.controller_connect_after = controller_connect_after
        self.channel_switched = False
        self.a4_after_switch = 0

    # BasePort-like API used by VEXDevice
    def read(self, n=0):
        if n <= 0:
            r = bytes(self.out)
            self.out.clear()
            return r
        r = bytes(self.out[:n])
        del self.out[:n]
        return r

    def read_all(self):
        return self.read(0)

    def flush(self):
        pass

    def write(self, data):
        data = bytes(data)
        resp = self.respond(data)
        self.log.append({'tx': data.hex(), 'rx': resp.hex()})
        self.out += resp

    def ext_response(self, cmd, ack, payload=b''):
        body = bytes([cmd, ack]) + bytes(payload)
        n = len(body) + 2
        if n >= 0x80:
            length = bytes([(n >> 8) | 0x80, n & 0xFF])
        else:
            length = bytes([n])
        pkt = bytes([0xAA, 0x55, 0x56]) + length + body
        crc = CRC16.compute(pkt)
        return pkt + bytes([crc >> 8, crc & 0xFF])

    def respond(self, data):
        assert data[:4] == bytes([0xC9, 0x36, 0xB8, 0x47]), data.hex()
        cmd = data[4]
        if cmd == 0xA4:
            v = bytearray(self.version8)
            if self.version8[5] == 0x11 and self.channel_switched:
                self.a4_after_switch += 1
                if self.a4_after_switch > self.controller_connect_after:
                    v[6] |= 0x02
                else:
                    v[6] &= ~0x02
            return bytes([0xAA, 0x55, 0xA4, 0x08]) + bytes(v)
        assert cmd == 0x56
        assert CRC16.compute(data) == 0, 'bad tx crc'
        ext = data[5]
        n = data[6]
        off = 7
        if n & 0x80:
            n = ((n & 0x7F) << 8) + data[7]
            off = 8
        payload = data[off:off + n]
        assert len(payload) == n
        key = ext
        if self.nack.get(key):
            code = self.nack[key].pop(0)
            if code is not None:
                return self.ext_response(ext, code)
        if ext == 0x10:
            self.channel_switched = payload[1] == 1
            if not self.channel_switched:
                self.a4_after_switch = 0
            return self.ext_response(ext, 0x76)
        if ext == 0x11:
            length = struct.unpack('<I', payload[4:8])[0]
            return self.ext_response(ext, 0x76, struct.pack('<H2I', self.max_packet_size, length, 0))
        if ext in (0x12, 0x13, 0x15, 0x18, 0x1B):
            return self.ext_response(ext, 0x76)
        if ext == 0x16:
            vid = payload[0]
            self.dir_vid = vid
            return self.ext_response(ext, 0x76, struct.pack('<h', len(self.dirs.get(vid, []))))
        if ext == 0x17:
            idx = payload[0]
            e = self.dirs[self.dir_vid][idx]
            return self.ext_response(ext, 0x76, struct.pack(
                '<B3L4sLL24s', idx, e['size'], e['addr'], e['crc'], e['type'].encode(), e['timestamp'],
                e['version'], e['name'].encode()))
        if ext == 0x19:
            vid = payload[0]
            name = payload[2:26].split(b'\0', 1)[0].decode()
            m = self.metadata.get((vid, name))
            if m is None:
                return self.ext_response(ext, 0xD9)
            return self.ext_response(ext, 0x76, struct.pack(
                '<B3L4sLL24s', m['linked_vid'], m['size'], m['addr'], m['crc'], m['type'].encode(),
                m['timestamp'], m['version'], m['linked_name'].encode()))
        if ext == 0x22:
            return self.ext_response(ext, 0x76, self.status_payload)
        raise AssertionError(f'unhandled ext 0x{ext:02x}')


def status_payload(sysv, cpu0, cpu1, touch=3, sys_id=0x12345678, extended=True):
    p = bytes([0]) + bytes(sysv) + bytes(cpu0) + bytes(cpu1) + bytes(3) + bytes([touch]) + \
        struct.pack('<I', sys_id) + bytes(12)
    if extended:
        p += bytes([0]) + bytes(3)
    return p


BRAIN_VERSION = [1, 1, 5, 0, 13, 0x10, 0x00, 0x00]
BRAIN_STATUS = status_payload([1, 1, 5, 0], [1, 1, 5, 0], [1, 1, 5, 0])
OLD_CPU_STATUS = status_payload([1, 1, 5, 0], [1, 0, 0, 27], [1, 0, 0, 27])
CONTROLLER_VERSION = [1, 0, 0, 0, 72, 0x11, 0x02, 0x00]


@contextlib.contextmanager
def quiet():
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield


def py_gzip(data: bytes) -> bytes:
    buf, _ = compress_file(io.BytesIO(data), len(data))
    return buf.getvalue()


class FakeTemplate:
    def __init__(self, version):
        self.version = version


class FakeProject:
    def __init__(self, names_versions):
        self.templates = {n: FakeTemplate(v) for n, v in names_versions}


def cli_kwargs(**over):
    """Keyword args the PROS CLI passes to write_program for a V5 project upload."""
    kw = {'remote_name': '40217S', 'slot': 0, 'run_after': V5Device.FTCompleteOptions.DONT_RUN,
              'quirk': 0, 'compress_bin': True, 'ide': 'PROS', 'ide_version': '4.2.2', 'icon': 'USER902x.bmp',
              'description': 'Made with PROS', 'program_version': None, 'ini_config': None}
    kw.update(over)
    return kw


def run_monolith(brain, bin_data, **over):
    dev = V5Device(brain)
    with quiet():
        dev.write_program(io.BytesIO(bin_data), **cli_kwargs(**over))
    return brain.log


def run_hot_cold(brain, hot, cold, templates, **over):
    dev = V5Device(brain)
    with quiet():
        cold_name = dev.generate_cold_hash(FakeProject(templates), {})
        dev.write_program(io.BytesIO(hot), linked_file=io.BytesIO(cold), linked_remote_name=cold_name,
                          linked_file_addr=0x03800000, addr=0x07800000, **cli_kwargs(**over))
    return cold_name, brain.log


def single(brain_kwargs, fn):
    brain = FakeBrain(**brain_kwargs)
    dev = V5Device(brain)
    with quiet():
        result = fn(dev)
    return brain.log, result


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    std_brain = {'version8': BRAIN_VERSION, 'status_payload': BRAIN_STATUS}

    # ---------------- CRC ----------------
    crc32 = V5Device.VEX_CRC32
    crc_inputs = [b'', b'123456789', bytes(range(256)), lcg_bytes(1000, 7),
                  bytes([0xC9, 0x36, 0xB8, 0x47, 0x56])]
    crc = [{'data': d.hex(), 'crc16': CRC16.compute(d), 'crc32': crc32.compute(d)} for d in crc_inputs]

    # ---------------- single packets ----------------
    packets = {}

    def add(name, brain_kwargs, fn):
        log, result = single(brain_kwargs, fn)
        packets[name] = {'tx': [e['tx'] for e in log], 'rx': [e['rx'] for e in log],
                         'result': result}

    add('query_system_version', std_brain, lambda d: str(d.query_system_version().system_version))
    add('get_system_status', std_brain, lambda d: {
        k: str(v) for k, v in d.get_system_status().__dict__.items()})
    add('ft_initialize_upload_bin', std_brain, lambda d: d.ft_initialize(
        'slot_1.bin', function='upload', length=1234, crc=0xDEADBEEF, type='bin', addr=0x03800000))
    add('ft_initialize_upload_ini_pros_vid', std_brain, lambda d: d.ft_initialize(
        'slot_8.ini', function='upload', length=150, crc=0x01020304, type='ini', vid='pros',
        addr=0x07800000))
    add('ft_write_aligned', std_brain, lambda d: d.ft_write(0x03800000, lcg_bytes(16, 3)))
    add('ft_write_unaligned', std_brain, lambda d: d.ft_write(0x03800100, lcg_bytes(13, 4)))
    add('ft_write_extended_len', std_brain, lambda d: d.ft_write(0x07800000, lcg_bytes(256, 5)))
    add('ft_complete_dont_run', std_brain, lambda d: d.ft_complete(V5Device.FTCompleteOptions.DONT_RUN))
    add('ft_complete_run', std_brain, lambda d: d.ft_complete(V5Device.FTCompleteOptions.RUN_IMMEDIATELY))
    add('ft_complete_screen', std_brain, lambda d: d.ft_complete(V5Device.FTCompleteOptions.RUN_SCREEN))
    add('ft_set_link', std_brain, lambda d: d.ft_set_link('gL/Ne2a7Ify0POC/O3642Q', vid='pros'))
    add('execute_program_stop', std_brain, lambda d: d.execute_program_file('', run=False))
    add('ft_transfer_channel_download', std_brain, lambda d: d.ft_transfer_channel('download'))
    add('get_dir_count_pros', dict(std_brain, dirs={24: [{}, {}]}), lambda d: d.get_dir_count(vid='pros'))
    add('erase_file_all', std_brain, lambda d: d.erase_file('slot_2.bin', erase_all=True, vid='user'))

    # ---------------- ini ----------------
    ini_cases = []

    def ini_case(label, fixed, kwargs, status=BRAIN_STATUS):
        FixedDatetime.fixed = fixed
        brain = FakeBrain(version8=BRAIN_VERSION, status_payload=status)
        dev = V5Device(brain)
        with quiet():
            text = dev.generate_ini_file(**kwargs)
        ini_cases.append({'label': label, 'now': fixed.isoformat(), 'kwargs': kwargs, 'ini': text})

    ini_case('cli_default', FIXED_NOW, {'remote_name': '40217S', 'slot': 0, 'ide': 'PROS', 'ide_version': '4.2.2',
                                            'icon': 'USER902x.bmp', 'description': 'Made with PROS'})
    ini_case('slot8_no_micro', FIXED_NOW_NO_MICRO, {'remote_name': 'Skills Auton', 'slot': 7, 'ide': 'PROS',
                                                        'ide_version': 'None', 'icon': 'USER010x.bmp',
                                                        'description': 'Scourge skills'})
    ini_case('multiline_description', FIXED_NOW, {'remote_name': 'x', 'slot': 2, 'ide': 'PROS', 'ide_version': '4.2.2',
                                                      'icon': 'USER902x.bmp', 'description': 'line one\nline two'})
    FixedDatetime.fixed = FIXED_NOW

    # ---------------- cold hash ----------------
    cold_hash = []
    for templates in [[('LemLib', '0.5.6'), ('kernel', '4.2.2')],
                      [('kernel', '4.2.2'), ('LemLib', '0.5.6')],
                      [('kernel', '4.2.2')],
                      [('kernel', '3.8.0'), ('okapilib', '4.8.0'), ('liblvgl', '8.3.8'), ('arms', '1.0')]]:
        for label, status in [('new', BRAIN_STATUS), ('old_cpu0', OLD_CPU_STATUS)]:
            brain = FakeBrain(version8=BRAIN_VERSION, status_payload=status)
            dev = V5Device(brain)
            with quiet():
                name = dev.generate_cold_hash(FakeProject(templates), {})
            cold_hash.append({'templates': [t[0] for t in templates], 'cpu0': label, 'name': name})

    # ---------------- gzip ----------------
    gz_inputs = [b'', b'hello pros', lcg_bytes(2000, 11), bytes(5000)]
    gz = [{'data': d.hex(), 'gz': py_gzip(d).hex()} for d in gz_inputs]

    # ---------------- full upload transcripts ----------------
    flows = []
    mono = lcg_bytes(2000, 1)
    hot = lcg_bytes(1500, 2)
    cold = lcg_bytes(3000, 3)
    templates = [('LemLib', '0.5.6'), ('kernel', '4.2.2')]

    log = run_monolith(FakeBrain(**std_brain), mono)
    flows.append({'label': 'monolith_slot1', 'options': {'slot': 1, 'name': '40217S', 'runAfter': 'none'},
                  'bin': mono.hex(), 'log': log})

    log = run_monolith(FakeBrain(**std_brain), mono, slot=4, remote_name='A_very_long_program_name_here',
                       run_after=V5Device.FTCompleteOptions.RUN_SCREEN, description='Scourge')
    flows.append({'label': 'monolith_slot5_screen_longname',
                  'options': {'slot': 5, 'name': 'A_very_long_program_name_here', 'runAfter': 'screen',
                              'description': 'Scourge'},
                  'bin': mono.hex(), 'log': log})

    log = run_monolith(FakeBrain(**std_brain, max_packet_size=1024), mono, compress_bin=False,
                       run_after=V5Device.FTCompleteOptions.RUN_IMMEDIATELY)
    flows.append({'label': 'monolith_uncompressed_run',
                  'options': {'slot': 1, 'name': '40217S', 'runAfter': 'run', 'compress': False},
                  'bin': mono.hex(), 'log': log})

    log = run_monolith(FakeBrain(version8=CONTROLLER_VERSION, status_payload=BRAIN_STATUS,
                                 controller_connect_after=1), mono[:600])
    flows.append({'label': 'monolith_via_controller',
                  'options': {'slot': 1, 'name': '40217S', 'runAfter': 'none'},
                  'bin': mono[:600].hex(), 'log': log})

    # hot/cold, library not on the brain, nothing else on the brain
    name, log = run_hot_cold(FakeBrain(**std_brain), hot, cold, templates, slot=2)
    flows.append({'label': 'hot_cold_fresh_brain',
                  'options': {'slot': 3, 'name': '40217S', 'runAfter': 'none', 'coldTemplates': ['LemLib', 'kernel']},
                  'bin': hot.hex(), 'coldBin': cold.hex(), 'coldName': name, 'log': log})

    # hot/cold, library already on the brain (size + crc match), so only ini + hot go up
    cold_gz = py_gzip(cold)
    cold_crc = crc32.compute(cold_gz)
    meta = {(24, 'gL/Ne2a7Ify0POC/O3642Q'): {'linked_vid': 0, 'size': len(cold_gz), 'addr': 0x03800000, 'crc': cold_crc,
                                                 'type': 'bin', 'timestamp': 1000, 'version': 0x01000000, 'linked_name': ''}}
    name, log = run_hot_cold(FakeBrain(**std_brain, metadata=meta), hot, cold, templates, slot=0,
                             run_after=V5Device.FTCompleteOptions.RUN_SCREEN)
    flows.append({'label': 'hot_cold_library_onboard',
                  'options': {'slot': 1, 'name': '40217S', 'runAfter': 'screen', 'coldTemplates': ['LemLib', 'kernel']},
                  'bin': hot.hex(), 'coldBin': cold.hex(), 'coldName': name, 'log': log})

    # hot/cold, stale library with the same name + orphan cleanup
    def entry(name, typ='bin', size=100, crc=1):
        return {'name': name, 'type': typ, 'size': size, 'addr': 0x03800000, 'crc': crc, 'timestamp': 5000, 'version': 0x01000000}

    dirs = {
        24: [entry('gL/Ne2a7Ify0POC/O3642Q'), entry('oldcold')],
        1: [entry('slot_1.bin'), entry('slot_1.ini', typ='ini'), entry('slot_2.bin'), entry('slot_4.bin')],
    }
    meta = {
        (24, 'gL/Ne2a7Ify0POC/O3642Q'): {'linked_vid': 0, 'size': 99, 'addr': 0x03800000, 'crc': 5, 'type': 'bin',
                                             'timestamp': 1000, 'version': 0x01000000, 'linked_name': ''},
        (1, 'slot_1.bin'): {'linked_vid': 24, 'size': 100, 'addr': 0x07800000, 'crc': 1, 'type': 'bin', 'timestamp': 6000,
                                'version': 0x01000000, 'linked_name': 'gL/Ne2a7Ify0POC/O3642Q'},
        (1, 'slot_2.bin'): {'linked_vid': 24, 'size': 100, 'addr': 0x07800000, 'crc': 1, 'type': 'bin', 'timestamp': 7000,
                                'version': 0x01000000, 'linked_name': 'oldcold'},
        (1, 'slot_4.bin'): {'linked_vid': 24, 'size': 100, 'addr': 0x07800000, 'crc': 1, 'type': 'bin', 'timestamp': 8000,
                                'version': 0x01000000, 'linked_name': 'gone'},
    }
    name, log = run_hot_cold(FakeBrain(**std_brain, dirs=dirs, metadata=meta), hot, cold, templates, slot=2)
    flows.append({'label': 'hot_cold_stale_library_cleanup',
                  'options': {'slot': 3, 'name': '40217S', 'runAfter': 'none', 'coldTemplates': ['LemLib', 'kernel']},
                  'bin': hot.hex(), 'coldBin': cold.hex(), 'coldName': name, 'log': log})

    # NACK on the first ft_write, which PROS retries
    log = run_monolith(FakeBrain(**std_brain, nack={0x13: [0xCE]}), mono[:300])
    flows.append({'label': 'monolith_write_nack_retried',
                  'options': {'slot': 1, 'name': '40217S', 'runAfter': 'none'},
                  'bin': mono[:300].hex(), 'log': log})

    fixtures = {
        'pros_cli_version': '3.5.6',
        'now': FIXED_NOW.isoformat(),
        'crc': crc, 'packets': packets, 'ini': ini_cases, 'coldHash': cold_hash, 'gzip': gz, 'flows': flows,
    }
    with open(os.path.join(OUT_DIR, 'pros_golden.json'), 'w') as f:
        json.dump(fixtures, f, indent=1, default=lambda o: o.hex() if isinstance(o, (bytes, bytearray)) else str(o))
    print('wrote', os.path.join(OUT_DIR, 'pros_golden.json'),
          'flows:', [(fl['label'], len(fl['log'])) for fl in flows])


if __name__ == '__main__':
    main()

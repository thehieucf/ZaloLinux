#!/usr/bin/env python3
"""Find raw references to a VA in a PE32 image: absolute pointers (vtables)
and E9 jmp thunks (incremental-link tables), then pointers to those thunks.

usage: pe-xref.py FILE VA_HEX
"""
import struct, sys

data = open(sys.argv[1], "rb").read()
target = int(sys.argv[2], 16)
pe = struct.unpack_from("<I", data, 0x3c)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
optsz = struct.unpack_from("<H", data, pe + 20)[0]
base = struct.unpack_from("<I", data, pe + 24 + 28)[0]
secs = []
for i in range(nsec):
    o = pe + 24 + optsz + 40 * i
    name = data[o:o + 8].rstrip(b"\0").decode()
    vsz, va, rsz, raw = struct.unpack_from("<IIII", data, o + 8)
    secs.append((name, base + va, vsz, raw, rsz))

def off2va(off):
    for name, va, vsz, raw, rsz in secs:
        if raw <= off < raw + rsz:
            return va + off - raw, name
    return None, None

def pointers_to(v):
    needle = struct.pack("<I", v)
    i = data.find(needle)
    while i >= 0:
        yield off2va(i)
        i = data.find(needle, i + 1)

targets = {target}
# jmp rel32 thunks: E9 xx xx xx xx with dest == target
for off in range(len(data) - 5):
    if data[off] == 0xE9:
        va, sec = off2va(off)
        if va and va + 5 + struct.unpack_from("<i", data, off + 1)[0] == target:
            print(f"thunk  {va:08x} ({sec}) -> {target:08x}")
            targets.add(va)
for t in sorted(targets):
    for va, sec in pointers_to(t):
        print(f"ptr    {va:08x} ({sec}) -> {t:08x}")

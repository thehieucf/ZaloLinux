#!/usr/bin/env python3
"""Given an address inside an MSVC vtable (PE32), print the owning class (via
RTTI CompleteObjectLocator) and the slot offset.

usage: pe-vtable.py FILE SLOT_VA_HEX
"""
import struct, sys

data = open(sys.argv[1], "rb").read()
slot = int(sys.argv[2], 16)
pe = struct.unpack_from("<I", data, 0x3c)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
optsz = struct.unpack_from("<H", data, pe + 20)[0]
base = struct.unpack_from("<I", data, pe + 24 + 28)[0]
secs = []
for i in range(nsec):
    o = pe + 24 + optsz + 40 * i
    name = data[o:o + 8].rstrip(b"\0").decode()
    vsz, va, rsz, raw = struct.unpack_from("<IIII", data, o + 8)
    secs.append((name, base + va, max(vsz, rsz), raw))

def sec_of(va):
    for name, sva, sz, raw in secs:
        if sva <= va < sva + sz:
            return name, raw + va - sva
    return None, None

def u32(va):
    _, off = sec_of(va)
    return struct.unpack_from("<I", data, off)[0]

def cstr(va):
    _, off = sec_of(va)
    return data[off:data.index(b"\0", off)].decode(errors="replace")

va = slot
while sec_of(u32(va - 4))[0] == ".text":
    va -= 4
col = u32(va - 4)
td = u32(col + 12)
print(f"vtable start {va:08x}, class {cstr(td + 8)}, slot offset 0x{slot - va:x} (index {(slot - va) // 4})")

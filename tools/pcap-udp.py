#!/usr/bin/env python3
"""Minimal pcap reader for UDP payloads (Ethernet, Linux SLL / SLL2).

usage: pcap-udp.py FILE [--host IP] [--port N] [-n MAX] [--hex BYTES] [--summary]
Prints: time  src -> dst  len  first bytes (hex)
"""
import argparse
import ipaddress
import struct


def packets(path):
    with open(path, "rb") as f:
        hdr = f.read(24)
        magic = struct.unpack("<I", hdr[:4])[0]
        endian = "<" if magic in (0xA1B2C3D4, 0xA1B23C4D) else ">"
        nano = magic in (0xA1B23C4D, 0x4D3CB2A1)
        linktype = struct.unpack(endian + "I", hdr[20:24])[0]
        while True:
            rec = f.read(16)
            if len(rec) < 16:
                return
            sec, frac, incl, _ = struct.unpack(endian + "IIII", rec)
            data = f.read(incl)
            yield sec + frac / (1e9 if nano else 1e6), linktype, data


def ip_payload(linktype, data):
    if linktype == 1:  # Ethernet
        etype, off = struct.unpack(">H", data[12:14])[0], 14
    elif linktype == 113:  # Linux SLL
        etype, off = struct.unpack(">H", data[14:16])[0], 16
    elif linktype == 276:  # Linux SLL2
        etype, off = struct.unpack(">H", data[0:2])[0], 20
    else:
        return None
    return etype, data[off:]


def udp(path):
    for ts, lt, data in packets(path):
        r = ip_payload(lt, data)
        if not r:
            continue
        etype, ip = r
        if etype == 0x0800 and ip[9] == 17:
            ihl = (ip[0] & 15) * 4
            src, dst = ipaddress.ip_address(ip[12:16]), ipaddress.ip_address(ip[16:20])
            u = ip[ihl:]
        elif etype == 0x86DD and ip[6] == 17:
            src, dst = ipaddress.ip_address(ip[8:24]), ipaddress.ip_address(ip[24:40])
            u = ip[40:]
        else:
            continue
        sp, dp, ln = struct.unpack(">HHH", u[:6])
        yield ts, f"{src}:{sp}", f"{dst}:{dp}", u[8:ln]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("-n", type=int, default=50)
    ap.add_argument("--hex", type=int, default=48)
    a = ap.parse_args()
    t0 = None
    shown = 0
    for ts, s, d, p in udp(a.file):
        if a.host and a.host not in (s.rsplit(":", 1)[0], d.rsplit(":", 1)[0]):
            continue
        if a.port and a.port not in (int(s.rsplit(":", 1)[1]), int(d.rsplit(":", 1)[1])):
            continue
        t0 = t0 or ts
        print(f"{ts - t0:8.3f} {s:>22} -> {d:<22} {len(p):5d}  {p[:a.hex].hex(' ')}")
        shown += 1
        if shown >= a.n:
            break

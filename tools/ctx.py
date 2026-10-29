#!/usr/bin/env python3
"""Print context around regex matches in (minified) files.

usage: ctx.py PATTERN FILE... [-c CHARS] [-n MAX]
"""
import argparse
import re

ap = argparse.ArgumentParser()
ap.add_argument("pattern")
ap.add_argument("files", nargs="+")
ap.add_argument("-c", type=int, default=150, help="chars of context each side")
ap.add_argument("-n", type=int, default=10, help="max matches per file")
args = ap.parse_args()

rx = re.compile(args.pattern)
for path in args.files:
    with open(path, encoding="utf-8", errors="replace") as f:
        data = f.read()
    for i, m in enumerate(rx.finditer(data)):
        if i >= args.n:
            print(f"  ... ({path}: more matches)")
            break
        s, e = max(0, m.start() - args.c), min(len(data), m.end() + args.c)
        print(f"--- {path}@{m.start()}")
        print(data[s:e].replace("\n", "⏎"))

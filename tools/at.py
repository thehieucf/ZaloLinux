#!/usr/bin/env python3
"""Print context around FILE:LINE:COL (as reported in stack traces).

usage: at.py FILE:LINE:COL [CHARS]
"""
import sys

loc = sys.argv[1]
width = int(sys.argv[2]) if len(sys.argv) > 2 else 300
path, line, col = loc.rsplit(":", 2)
with open(path, encoding="utf-8", errors="replace") as f:
    for i, text in enumerate(f, 1):
        if i == int(line):
            c = int(col) - 1
            print(text[max(0, c - width):c] + "⟦HERE⟧" + text[c:c + width])
            break

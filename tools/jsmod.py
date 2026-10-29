#!/usr/bin/env python3
"""Extract the webpack module containing NEEDLE from a minified bundle and
pretty-print it (newline + indent on braces/semicolons).

usage: jsmod.py BUNDLE NEEDLE [-o OUT] [--raw]

The formatter is a lexer-light pass: it skips strings, template literals,
comments and (heuristically) regex literals, so it never splits inside them.
Good enough for reading, not for re-executing.
"""
import argparse
import re

REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^")
REGEX_KW = ("return", "typeof", "case", "do", "else", "in", "of", "void", "throw", "delete", "new")


def scan(src, start=0):
    """Yield (index, char, in_code) for every char, tracking literals."""
    i, n = start, len(src)
    prev_sig = ""
    tmpl_depth = []  # brace depth stack for ${ } inside template literals
    depth = 0
    while i < n:
        c = src[i]
        if c in "\"'":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            yield i, src[i:j + 1], False
            i = j + 1
            prev_sig = "a"
            continue
        if c == "`" or (c == "}" and tmpl_depth and tmpl_depth[-1] == depth):
            if c == "}":
                tmpl_depth.pop()
            j = i + 1
            while j < n and src[j] != "`":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "$" and j + 1 < n and src[j + 1] == "{":
                    tmpl_depth.append(depth)
                    j += 2
                    break
                j += 1
            else:
                j += 1
            yield i, src[i:j], False
            i = j
            prev_sig = "a"
            continue
        if c == "/" and i + 1 < n and src[i + 1] in "/*":
            end = src.find("\n" if src[i + 1] == "/" else "*/", i + 2)
            end = n if end < 0 else end + (0 if src[i + 1] == "/" else 2)
            yield i, src[i:end], False
            i = end
            continue
        if c == "/":
            word = re.search(r"([A-Za-z_$]+)\s*$", src[max(0, i - 12):i])
            if prev_sig in REGEX_PREV or prev_sig == "" or (word and word.group(1) in REGEX_KW and prev_sig == "w"):
                j, in_cls = i + 1, False
                while j < n:
                    if src[j] == "\\":
                        j += 2
                        continue
                    if src[j] == "[":
                        in_cls = True
                    elif src[j] == "]":
                        in_cls = False
                    elif src[j] == "/" and not in_cls:
                        break
                    elif src[j] == "\n":
                        break
                    j += 1
                j += 1
                while j < n and src[j].isalpha():
                    j += 1
                yield i, src[i:j], False
                i = j
                prev_sig = "a"
                continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        if not c.isspace():
            prev_sig = "w" if (c.isalnum() or c in "_$") else c
            if c in ")]":
                prev_sig = "a"
        yield i, c, True
        i += 1


def module_bounds(src, pos):
    """Find the `"id":function(e,t,n){...}` webpack module enclosing pos."""
    # Search a little past pos so a needle naming the module itself ("id:function(") works.
    for m in reversed(list(re.finditer(r'[{,]("?[\w$+/-]+"?):function\([\w$,]*\)\{', src[:pos + 64]))):
        start = m.end() - 1
        depth = 0
        for i, tok, code in scan(src, start):
            if code and tok == "{":
                depth += 1
            elif code and tok == "}":
                depth -= 1
                if depth == 0:
                    if i >= pos:
                        return m.group(1), m.start() + 1, i + 1
                    break
    raise SystemExit("no enclosing module found")


def pretty(code):
    out, indent, paren = [], 0, 0
    nl = lambda: out.append("\n" + "  " * indent)
    for _, tok, is_code in scan(code):
        if not is_code:
            out.append(tok)
            continue
        if tok in "([":
            paren += 1
        elif tok in ")]":
            paren = max(0, paren - 1)
        if tok == "{":
            indent += 1
            out.append("{")
            nl()
        elif tok == "}":
            indent = max(0, indent - 1)
            nl()
            out.append("}")
        elif tok == ";" and paren == 0:
            out.append(";")
            nl()
        else:
            out.append(tok)
    text = "".join(out)
    return re.sub(r"\n\s*\n", "\n", text)


ap = argparse.ArgumentParser()
ap.add_argument("bundle")
ap.add_argument("needle")
ap.add_argument("-o", "--out")
ap.add_argument("--raw", action="store_true", help="do not pretty-print")
a = ap.parse_args()

src = open(a.bundle, encoding="utf-8", errors="replace").read()
pos = src.find(a.needle)
if pos < 0:
    raise SystemExit("needle not found")
mid, s, e = module_bounds(src, pos)
body = src[s:e]
text = body if a.raw else pretty(body)
header = f"// module {mid} from {a.bundle} [{s}:{e}]\n"
if a.out:
    open(a.out, "w", encoding="utf-8").write(header + text + "\n")
    print(f"module {mid}: {e - s} bytes -> {a.out} ({text.count(chr(10))} lines)")
else:
    print(header + text)

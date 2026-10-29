#!/usr/bin/env python3
"""Build a Linux-runnable copy of Zalo PC from the extracted Windows app.asar.

usage: patch.py SRC DST
  SRC: extracted app.asar of the Windows build (pristine, never modified)
  DST: output directory (recreated on each run)

Every change to Zalo's own files lives here, so a new Zalo release is ported
by re-extracting and re-running this script.
"""
import glob
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHIMS = os.path.join(os.path.dirname(HERE), "shims")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, data):
    with open(path, "w", encoding="utf-8") as f:
        f.write(data)


def replace_in(paths, old, new, expect=None):
    """Replace `old` with `new` in every file; fail loudly if nothing matched."""
    total = 0
    for path in paths:
        data = read(path)
        n = data.count(old)
        if n:
            write(path, data.replace(old, new))
            total += n
    if total == 0 or (expect is not None and total != expect):
        sys.exit(f"patch failed: {old!r} matched {total} times (expected {expect})")
    print(f"  {total:3d} × {old[:70]!r}")


def main():
    src, dst = sys.argv[1], sys.argv[2]
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=True)
    os.chdir(dst)

    bundles = (glob.glob("main-dist/**/*.js", recursive=True)
               + glob.glob("pc-dist/**/*.js", recursive=True))

    print("windows path separators in require()")
    replace_in(bundles, 'require("..\\\\native\\\\nativelibs")',
               'require("../native/nativelibs")')

    print("drive helpers: POSIX paths live on the '/' drive")
    replace_in(bundles, 'const t=e.match(/^([A-Z]+:)/i);return t?`${t[1]}\\\\`:null',
               'if(e&&e[0]==="/")return"/";'
               'const t=e.match(/^([A-Z]+:)/i);return t?`${t[1]}\\\\`:null')

    # Zalo's servers gate features by client type (23 macOS, 24 Windows,
    # 25 Linux). Type 25 gets message sync (v1 and v2) disabled, and Zalo's
    # non-win32 code paths are the macOS ones anyway, so present as macOS.
    print("client type: report Linux as macOS (23)")
    replace_in(bundles, 'case"LINUX":return 25', 'case"LINUX":return 23', expect=3)

    # Call engine: on Linux run our engine (native/zcall-linux, an Electron
    # app: it needs windows and audio) instead of ZaloCall.exe /
    # ZaloHelper.app. It speaks the same socket protocol, so it gets the IPC
    # AES key Zalo keeps in `R`.
    print("call engine: spawn the native/zcall-linux Electron app on Linux")
    env = ('(()=>{const x=Object.assign({},process.env,{ZCALL_IPC_KEY:R});'
           'delete x.ELECTRON_RUN_AS_NODE;return x})()')
    for send_var, bundle in (("y", "main-dist/main.js"), ("g", "main-dist/compact-app.js")):
        replace_in([bundle], f'A=i(e,[v,{send_var}])',
                   f'A="linux"===process.platform'
                   f'?i(process.execPath,["--no-sandbox",__dirname+"/../native/zcall-linux",v,{send_var}],'
                   f'{{env:{env}}})'
                   f':i(e,[v,{send_var}])', expect=1)

    # Zalo enables auto-launch on every start unless the user turned it off.
    # auto-launch's Linux backend writes ~/.config/autostart/<name>.desktop
    # with Exec=process.execPath, i.e. a bare Electron without our app, and
    # the name came out as "electron". Point it at the launcher instead
    # (tools/install.sh exports ZALO_LAUNCHER).
    print("auto-launch: start the Zalo launcher on Linux")
    replace_in(["main-dist/main.js"], 'e.path=t}d=new r(e)',
               'e.path=t}else if("linux"===process.platform){e.name="Zalo";'
               'e.path=process.env.ZALO_LAUNCHER||'
               '`"${process.execPath}" --no-sandbox "${i.getAppPath()}"`}d=new r(e)', expect=1)

    print("shims")
    for root, _, files in os.walk(SHIMS):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), SHIMS)
            out = os.path.join("native", rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(os.path.join(root, name), out)
            print(f"      {out}")


if __name__ == "__main__":
    main()

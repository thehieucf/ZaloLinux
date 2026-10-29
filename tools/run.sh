#!/bin/bash
# Run the patched Zalo (app/) on native Electron without installing it.
# usage: tools/run.sh [seconds] [log-name]   (seconds=0: run until closed)
# env: ZALO_DEBUG_PORT=9222 exposes the DevTools protocol (see tools/cdp-errors.js)
#      ZALO_PROFILE=dir uses dir/ZaloData instead of ~/.config/ZaloData
cd "$(dirname "$0")/.."
secs=${1:-40}; log=logs/${2:-run}.log
mkdir -p logs
# Keep the autostart entry on the installed launcher (tools/install.sh).
[ -x "$HOME/.local/bin/zalo" ] && export ZALO_LAUNCHER="$HOME/.local/bin/zalo"
cmd=(env -u ELECTRON_RUN_AS_NODE ${ZALO_PROFILE:+XDG_CONFIG_HOME="$ZALO_PROFILE"}
     runtime/electron/electron app --enable-logging --no-sandbox
     ${ZALO_DEBUG_PORT:+--remote-debugging-port=$ZALO_DEBUG_PORT})
if [ "$secs" = 0 ]; then "${cmd[@]}" >"$log" 2>&1; else timeout "$secs" "${cmd[@]}" >"$log" 2>&1; fi
echo "exit=$?"
grep -v -E '^Fontconfig|^$' "$log" | cut -c1-400 | head -${LINES_MAX:-80}

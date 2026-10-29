#!/bin/bash
# Build node_sqlite3.node for Linux: node-sqlite3 v5.0.2 (the exact version
# Zalo ships) linked against the system SQLCipher, since Zalo's databases are
# SQLCipher-encrypted. Needs: sqlcipher (pacman -S sqlcipher), g++.
#
# Output: shims/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
src=$root/vendor/node-sqlite3-5.0.2
naa=$root/vendor/node-addon-api-3.2.1
out=$root/shims/nativelibs/sqlite3/binding/napi-v6-linux-x64
obj=$root/build/sqlite3
mkdir -p "$out" "$obj"

[ -f /usr/include/sqlcipher/sqlite3.h ] || { echo "missing sqlcipher: sudo pacman -S sqlcipher" >&2; exit 1; }

flags=(-std=c++17 -O2 -fPIC -fexceptions
       -DNAPI_VERSION=6 -DNAPI_DISABLE_CPP_EXCEPTIONS=1 -DSQLITE_HAS_CODEC
       -DNODE_GYP_MODULE_NAME=node_sqlite3 -DBUILDING_NODE_EXTENSION
       -I/usr/include/sqlcipher -I/usr/include/node -I"$naa")

for f in backup database node_sqlite3 statement; do
    g++ "${flags[@]}" -c "$src/src/$f.cc" -o "$obj/$f.o"
done
# N-API symbols resolve against the Electron binary at load time.
g++ -shared -o "$out/node_sqlite3.node" "$obj"/*.o -lsqlcipher -Wl,--allow-shlib-undefined
echo "built $out/node_sqlite3.node"

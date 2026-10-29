var path = require('path');
var os = require('os');

var BINARY_PATH = path.join(__dirname, `binding/napi-v6-${process.platform}-${process.arch}/node_sqlite3.node`);
console.debug('BINARY_PATH', BINARY_PATH);

var binding;
if (process.platform === 'linux') {
    // Electron already has the system libsqlite3 in its global symbol scope
    // (pulled in through libnss3). A plain require() would bind the addon's
    // sqlite3_* calls to it instead of libsqlcipher, silently dropping
    // encryption. RTLD_DEEPBIND makes the addon resolve against its own
    // dependencies (libsqlcipher) first.
    var flags = os.constants.dlopen;
    var mod = { exports: {} };
    process.dlopen(mod, BINARY_PATH, flags.RTLD_NOW | flags.RTLD_DEEPBIND);
    binding = mod.exports;
} else {
    binding = require(BINARY_PATH);
}
module.exports = exports = binding;

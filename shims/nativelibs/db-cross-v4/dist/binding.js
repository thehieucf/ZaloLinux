"use strict";
// Linux shim for db-cross-v4-native.node (Windows/macOS only).
// It is used only to restore message backups made on another device. Every
// call reports failure in the shape shared-worker reads ({result != 0, ...}),
// so a restore fails cleanly instead of crashing the worker on require().
const NOT_SUPPORTED = -1;
const message = 'db-cross-v4 is not available on Linux';

const fail = (extra) => Object.assign({
    result: NOT_SUPPORTED,
    error_message: message,
    err_message: message,
    inner_error: NOT_SUPPORTED,
}, extra);

module.exports = {
    getVersion: () => '0.0.0-linux-shim',
    parseBinNet: () => fail({ data: null }),
    decompressAndDecryptDb: (input, output, password) => fail({ input, output, password }),
    decompressAndDecryptDb_V2: (input, output, password) => fail({ input, output, password }),
};

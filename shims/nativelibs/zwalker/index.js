// Linux shim for zwalker (NAPI-RS, built for Windows/macOS only). It powers
// storage cleanup of downloaded media; on Linux every call rejects so the
// cleanup job is skipped rather than throwing when the module is required.
const notSupported = () => Promise.reject(new Error('zwalker is not available on Linux'))

module.exports.scanDirectory = notSupported
module.exports.updateReferenceMessageId = notSupported
module.exports.deleteHomelessFiles = notSupported
module.exports.statUnmarkedFiles = notSupported
module.exports.deleteEmptyFolders = notSupported

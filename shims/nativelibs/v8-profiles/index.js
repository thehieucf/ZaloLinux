// Linux shim for the v8-profiler addon (Windows/macOS only), used by Zalo's
// diagnostics. Profiling becomes a no-op that yields an empty profile.
function CpuProfile(title) {
  this.title = title;
  this.typeId = 'CPU';
  this.uid = 0;
  this.head = null;
  this.startTime = Date.now();
  this.endTime = this.startTime;
}

CpuProfile.prototype.getHeader = function() {
  return { typeId: this.typeId, uid: this.uid, title: this.title };
};
CpuProfile.prototype.delete = function() {};
CpuProfile.prototype.export = function(cb) {
  const json = JSON.stringify({ nodes: [], startTime: this.startTime, endTime: this.endTime, samples: [], timeDeltas: [] });
  if (typeof cb === 'function') return cb(null, json);
  return json;
};

module.exports = {
  get profiles() { return {}; },
  startProfiling: function() {},
  stopProfiling: function(name) { return new CpuProfile(name || ''); },
  setSamplingInterval: function() {},
  deleteAllProfiles: function() {}
};

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const zaloData = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ZaloData');
const logFile = path.join(zaloData, 'zcall-linux.log');

function log(tag, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const line = `${new Date().toISOString()} ${tag} ${text}\n`;
  try { fs.appendFileSync(logFile, line); } catch (e) { process.stderr.write(line); }
}

module.exports = { log, zaloData };

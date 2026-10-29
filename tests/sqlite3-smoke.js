// Smoke test for the Linux node_sqlite3.node through Zalo's own JS wrapper:
// SQLCipher encrypt/reopen round trip plus features Zalo's schema relies on.
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require(path.join(__dirname, '../app/native/nativelibs/sqlite3'));

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zsq-')), 'test.db');
const q = (db, sql) => new Promise((res, rej) => db.all(sql, (e, r) => e ? rej(e) : res(r)));
const open = () => new Promise((res, rej) => { const db = new sqlite3.Database(file, e => e ? rej(e) : res(db)); });
const close = db => new Promise(res => db.close(res));

(async () => {
  let db = await open();
  await q(db, "PRAGMA key = 'zalo-test-key'");
  console.log('cipher_version', (await q(db, 'PRAGMA cipher_version'))[0]);
  await q(db, 'CREATE TABLE t(id INTEGER PRIMARY KEY, msg TEXT)');
  await q(db, "INSERT INTO t(msg) VALUES ('xin chào')");
  await q(db, 'CREATE VIRTUAL TABLE f USING fts5(body)');
  await q(db, 'CREATE VIRTUAL TABLE r USING rtree(id, x0, x1)');
  console.log('math', (await q(db, 'SELECT sqrt(16) AS v'))[0]);
  await close(db);

  const head = fs.readFileSync(file).subarray(0, 16).toString('latin1');
  console.log('encrypted on disk:', !head.startsWith('SQLite format 3'));

  db = await open();
  await q(db, "PRAGMA key = 'wrong'");
  try { await q(db, 'SELECT * FROM t'); console.log('wrong key: UNEXPECTED success'); }
  catch (e) { console.log('wrong key rejected:', e.code); }
  await close(db);

  db = await open();
  await q(db, "PRAGMA key = 'zalo-test-key'");
  console.log('reopen rows', await q(db, 'SELECT * FROM t'));
  const opts = (await q(db, 'PRAGMA compile_options')).map(r => r.compile_options);
  console.log('options', opts.filter(o => /FTS|RTREE|MATH|CODEC|THREADSAFE|COLUMN_METADATA|TEMP_STORE/.test(o)).join(' '));
  await close(db);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

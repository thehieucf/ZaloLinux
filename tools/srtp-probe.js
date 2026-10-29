// Try candidate SRTP master keys against captured RTP packets.
// Oracle: the HMAC-SHA1 auth tag (RFC 3711, AES_CM_128_HMAC_SHA1_80/_32) must
// verify — a match cannot happen by chance.
//
// usage: node tools/srtp-probe.js re/work/call1-audio.json
const crypto = require('crypto');
const fs = require('fs');

const cap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// RFC 3711 §4.3 key derivation with key_derivation_rate 0 (index term = 0).
function kdf(masterKey, masterSalt, label, len) {
  const x = Buffer.alloc(14);
  masterSalt.copy(x);
  x[7] ^= label; // label sits at byte 7 of the 112-bit value (before the 48-bit index)
  const iv = Buffer.concat([x, Buffer.alloc(2)]);
  const c = crypto.createCipheriv('aes-128-ctr', masterKey, iv);
  return c.update(Buffer.alloc(len));
}

function sessionKeys(master) {
  const mk = master.subarray(0, 16), ms = master.subarray(16, 30);
  return { enc: kdf(mk, ms, 0, 16), auth: kdf(mk, ms, 1, 20), salt: kdf(mk, ms, 2, 14) };
}

function verify(keys, pkt, tagLen, roc = 0) {
  const body = pkt.subarray(0, pkt.length - tagLen), tag = pkt.subarray(pkt.length - tagLen);
  const r = Buffer.alloc(4); r.writeUInt32BE(roc);
  const mac = crypto.createHmac('sha1', keys.auth).update(body).update(r).digest().subarray(0, tagLen);
  return mac.equals(tag);
}

function rtpHeaderLen(p) {
  let n = 12 + 4 * (p[0] & 15);
  if (p[0] & 0x10) n += 4 + 4 * p.readUInt16BE(n + 2);
  return n;
}

function decrypt(keys, pkt, tagLen, roc = 0) {
  const h = rtpHeaderLen(pkt);
  const seq = pkt.readUInt16BE(2), ssrc = pkt.readUInt32BE(8);
  const iv = Buffer.alloc(16);
  keys.salt.copy(iv);
  const idx = BigInt(roc) * 65536n + BigInt(seq);
  for (let i = 0; i < 4; i++) iv[4 + i] ^= (ssrc >>> (24 - 8 * i)) & 255;
  for (let i = 0; i < 6; i++) iv[8 + i] ^= Number((idx >> BigInt(40 - 8 * i)) & 255n);
  const c = crypto.createDecipheriv('aes-128-ctr', keys.enc, iv);
  return c.update(pkt.subarray(h, pkt.length - tagLen));
}

const h = (alg, ...parts) => { const x = crypto.createHash(alg); parts.forEach(p => x.update(p)); return x.digest(); };
const b64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const s = cap.session, sb = Buffer.from(s), sd = b64url(s);
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const ids = [String(cap.callId), u32(cap.callId), String(cap.myUid), String(cap.partnerUid)];

const candidates = {
  'session[0:30]': sb.subarray(0, 30),
  'session[-30:]': sb.subarray(sb.length - 30),
  'b64(session)[0:30]': sd.subarray(0, 30),
  'b64(session)[-30:]': sd.subarray(sd.length - 30),
};
for (const alg of ['md5', 'sha1', 'sha256', 'sha512']) {
  for (const [name, src] of [['session', sb], ['b64(session)', sd], ['callId', ids[0]], ['session+callId', [sb, ids[0]]]]) {
    const parts = Array.isArray(src) ? src : [src];
    let d = h(alg, ...parts);
    while (d.length < 30) d = Buffer.concat([d, h(alg, d)]);
    candidates[`${alg}(${name})`] = d.subarray(0, 30);
  }
}

const pkts = [...cap.audio['0'], ...cap.audio['1']].map(x => Buffer.from(x, 'hex'));
console.log(`${pkts.length} packets, session ${s.length} chars, b64 ${sd.length} bytes`);
let found = false;
for (const [name, master] of Object.entries(candidates)) {
  if (master.length < 30) continue;
  const keys = sessionKeys(master);
  for (const tagLen of [10, 4]) {
    const ok = pkts.filter(p => verify(keys, p, tagLen)).length;
    if (ok) {
      found = true;
      const toc = pkts.slice(0, 8).map(p => decrypt(keys, p, tagLen)[0].toString(16)).join(' ');
      console.log(`MATCH ${name} tag=${tagLen}: ${ok}/${pkts.length} verified, opus TOC: ${toc}`);
    }
  }
}
if (!found) console.log('no candidate verified');

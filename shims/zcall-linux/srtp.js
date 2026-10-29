'use strict';
// SRTP (RFC 3711), AES_CM_128_HMAC_SHA1_80, as used by Zalo 1:1 calls: the
// master key||salt is the first 30 bytes of the signaled `session` token and
// both directions share it (re/NOTES.md, "SRTP key"). RTCP is not encrypted.
const crypto = require('crypto');

const TAG_LEN = 10;

function kdf(masterKey, masterSalt, label, len) {
  const x = Buffer.alloc(16);
  masterSalt.copy(x);
  x[7] ^= label;
  return crypto.createCipheriv('aes-128-ctr', masterKey, x).update(Buffer.alloc(len));
}

function rtpHeaderLength(p) {
  let n = 12 + 4 * (p[0] & 0x0f);
  if (p[0] & 0x10) n += 4 + 4 * p.readUInt16BE(n + 2);
  return n;
}

class SrtpContext {
  constructor(master) {
    if (master.length < 30) throw new Error('SRTP master key+salt must be 30 bytes');
    const mk = master.subarray(0, 16), ms = master.subarray(16, 30);
    this.encKey = kdf(mk, ms, 0, 16);
    this.authKey = kdf(mk, ms, 1, 20);
    this.salt = kdf(mk, ms, 2, 14);
    this.streams = new Map(); // ssrc -> { roc, lastSeq } (receive side)
    this.sendRoc = new Map(); // ssrc -> { roc, lastSeq } (send side)
  }

  static fromSession(session) {
    return new SrtpContext(Buffer.from(session, 'latin1').subarray(0, 30));
  }

  _keystreamXor(packet, headerLen, end, ssrc, index) {
    const iv = Buffer.alloc(16);
    this.salt.copy(iv);
    iv[4] ^= ssrc >>> 24; iv[5] ^= (ssrc >>> 16) & 255; iv[6] ^= (ssrc >>> 8) & 255; iv[7] ^= ssrc & 255;
    for (let i = 0; i < 6; i++) iv[8 + i] ^= Number((index >> BigInt(40 - 8 * i)) & 255n);
    const ks = crypto.createCipheriv('aes-128-ctr', this.encKey, iv).update(Buffer.alloc(end - headerLen));
    for (let i = 0; i < ks.length; i++) packet[headerLen + i] ^= ks[i];
  }

  _tag(data, roc) {
    const r = Buffer.alloc(4);
    r.writeUInt32BE(roc >>> 0);
    return crypto.createHmac('sha1', this.authKey).update(data).update(r).digest().subarray(0, TAG_LEN);
  }

  // RFC 3711 §3.3.1 index estimation, relative to the highest seq seen.
  static _guessRoc(state, seq) {
    if (!state) return 0;
    const { roc, lastSeq } = state;
    if (lastSeq < 32768) return seq - lastSeq > 32768 ? (roc === 0 ? 0 : roc - 1) : roc;
    return lastSeq - 32768 > seq ? roc + 1 : roc;
  }

  static _advance(map, ssrc, seq, roc) {
    const s = map.get(ssrc);
    if (!s || roc > s.roc || (roc === s.roc && seq > s.lastSeq)) map.set(ssrc, { roc, lastSeq: seq });
  }

  protect(rtp) {
    const seq = rtp.readUInt16BE(2), ssrc = rtp.readUInt32BE(8);
    const roc = SrtpContext._guessRoc(this.sendRoc.get(ssrc), seq);
    SrtpContext._advance(this.sendRoc, ssrc, seq, roc);
    const out = Buffer.from(rtp);
    this._keystreamXor(out, rtpHeaderLength(out), out.length, ssrc, BigInt(roc) * 65536n + BigInt(seq));
    return Buffer.concat([out, this._tag(out, roc)]);
  }

  // Returns the plain RTP packet, or null when authentication fails.
  unprotect(srtp) {
    if (srtp.length < 12 + TAG_LEN) return null;
    const seq = srtp.readUInt16BE(2), ssrc = srtp.readUInt32BE(8);
    const roc = SrtpContext._guessRoc(this.streams.get(ssrc), seq);
    const body = srtp.subarray(0, srtp.length - TAG_LEN);
    if (!crypto.timingSafeEqual(this._tag(body, roc), srtp.subarray(srtp.length - TAG_LEN))) return null;
    SrtpContext._advance(this.streams, ssrc, seq, roc);
    const out = Buffer.from(body);
    this._keystreamXor(out, rtpHeaderLength(out), out.length, ssrc, BigInt(roc) * 65536n + BigInt(seq));
    return out;
  }
}

module.exports = { SrtpContext, rtpHeaderLength };

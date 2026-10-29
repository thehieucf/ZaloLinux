'use strict';
// Wire formats of Zalo's relay ("ZRTP" server) protocol and RTP framing, as
// decoded from zrtc::ZRTPPacket and a real capture (re/NOTES.md). All integers
// in the relay headers are little-endian (raw x86 writes); RTP is big-endian.

const KIND_REQUEST = 0x01;   // control request to the relay
const KIND_RESPONSE = 0x02;  // relay response
const KIND_AUDIO_OUT = 0x03; // client → relay: [03][token u32][SRTP]
const KIND_AUDIO_IN = 0x04;  // relay → client: [04][SRTP]
const KIND_RTCP = 0x05;      // out: [05][token][RTCP], in: [05][00 00 00 00][RTCP]
// Video, from zrtc::ZRTPPacket::initZRTPPacketVideo / _parsePacketInternal:
const KIND_VIDEO_OUT = 0x0d; // client → relay: [0d][token][SRTP]
const KIND_VIDEO_IN = 0x0e;  // relay → client: [0e][SRTP]
const KIND_VIDEO_RTCP = 0x0f; // like KIND_RTCP
const KIND_P2P = 0x7f;

const SUB_PING = 0x02;        // in-call keepalive carrying the session
const SUB_END_CALL = 0x03;    // leave a relay (also relayed to the partner as a 02 response)
const SUB_ECHO = 0x05;        // anonymous echo, used for RTT probes and keepalive
const SUB_INIT_CALLER = 0x0b;
const SUB_INIT_CALLEE = 0x0c;
const SUB_SIGNAL = 0x20;      // partner's in-band signals (network quality …), relayed
const PROTO_VERSION = 0x7e; // byte 1 of InitCall/EndCall packets in the capture
const ECHO_MAGIC = [0x003e9765, 0x012f833c]; // fixed words of the capture's echo packets

// Common 21-byte request header: kind | u8 | u32 | u32 id | u32 uid | u32 token | u16 subcmd | u8 flags
function requestHeader(extra, { version = 0x01, id = 0, uid = 0, token = null, subcmd, flags = 0 }) {
  const b = Buffer.alloc(21 + extra);
  b[0] = KIND_REQUEST;
  b[1] = version;
  b.writeUInt32LE(id >>> 0, 6);
  b.writeUInt32LE(uid >>> 0, 10);
  if (token) token.copy(b, 14);
  b.writeUInt16LE(subcmd, 18);
  b[20] = flags;
  return b;
}

// Echo probe: header (id, fixed magic words) + S2 text, zero-padded to `size`.
function buildEcho(id, text, size = 0) {
  const t = Buffer.from(text, 'latin1');
  const b = requestHeader(Math.max(2 + t.length, size - 21), { id, subcmd: SUB_ECHO });
  b.writeUInt32LE(ECHO_MAGIC[0], 10);
  b.writeUInt32LE(ECHO_MAGIC[1], 14);
  b.writeUInt16LE(t.length, 21);
  t.copy(b, 23);
  return b;
}

// In-call ping: header (uid, token, flags 1) + S2 session.
function buildPing({ myUid, token, session }) {
  const s = Buffer.from(session, 'latin1');
  const b = requestHeader(2 + s.length, { uid: myUid, token, subcmd: SUB_PING, flags: 1 });
  b.writeUInt16LE(s.length, 21);
  s.copy(b, 23);
  return b;
}

// Leave a relay: header (uid, token) + u32 callId.
function buildEndCall({ myUid, token, callId }) {
  const b = requestHeader(4, { version: PROTO_VERSION, uid: myUid, token, subcmd: SUB_END_CALL });
  b.writeUInt32LE(callId >>> 0, 21);
  return b;
}

// InitCall: 01 7e | u32 0 | u32 0 | u32 myUid | u32 0 | u16 subcmd | u8 2 |
//           u32 callId | u32 partnerUid | u16 len | session
function buildInitCall({ isCaller, myUid, callId, partnerUid, session }) {
  const s = Buffer.from(session, 'latin1');
  const b = Buffer.alloc(31 + s.length);
  b[0] = KIND_REQUEST;
  b[1] = PROTO_VERSION;
  b.writeUInt32LE(myUid >>> 0, 10);
  b.writeUInt16LE(isCaller ? SUB_INIT_CALLER : SUB_INIT_CALLEE, 18);
  b[20] = 0x02;
  b.writeUInt32LE(callId >>> 0, 21);
  b.writeUInt32LE(partnerUid >>> 0, 25);
  b.writeUInt16LE(s.length, 29);
  s.copy(b, 31);
  return b;
}

// Response: 02 7e | header (same as request) | u32 ? | u32 callId | u32 token | u16 len | "ip|port"
function parseInitResponse(p) {
  if (p.length < 35 || p[0] !== KIND_RESPONSE) return null;
  const subcmd = p.readUInt16LE(18);
  if (subcmd !== SUB_INIT_CALLER && subcmd !== SUB_INIT_CALLEE) return null;
  const len = p.readUInt16LE(33);
  return {
    subcmd,
    callId: p.readUInt32LE(25),
    token: p.subarray(29, 33),
    publicAddress: p.subarray(35, 35 + len).toString('latin1'),
  };
}

function wrapAudio(token, srtp) {
  return Buffer.concat([Buffer.from([KIND_AUDIO_OUT]), token, srtp]);
}

function wrapRtcp(token, rtcp) {
  return Buffer.concat([Buffer.from([KIND_RTCP]), token, rtcp]);
}

function wrapVideo(token, srtp) {
  return Buffer.concat([Buffer.from([KIND_VIDEO_OUT]), token, srtp]);
}

function wrapVideoRtcp(token, rtcp) {
  return Buffer.concat([Buffer.from([KIND_VIDEO_RTCP]), token, rtcp]);
}

// Per-second in-call status relayed to the partner (subcmd 0x20, flags 0x0a,
// S4 payload). Bytes copied from the PC engine's packets in the capture; the
// fourth word varies 0x19..0x33 there (looks like a measured delay in ms).
function buildStatus({ myUid, token, seq, value = 0x32 }) {
  const payload = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, value & 0xff, 0, 0, 0, 0]);
  const b = requestHeader(4 + payload.length, { id: seq, uid: myUid, token, subcmd: SUB_SIGNAL, flags: 0x0a });
  b.writeUInt32LE(payload.length, 21);
  payload.copy(b, 25);
  return b;
}

// Classify an incoming datagram from a relay.
function parseRelayDatagram(p) {
  switch (p[0]) {
    case KIND_AUDIO_IN: return { type: 'rtp', data: p.subarray(1) };
    case KIND_RTCP: return { type: 'rtcp', data: p.subarray(5) };
    case KIND_VIDEO_IN: return { type: 'video', data: p.subarray(1) };
    case KIND_VIDEO_RTCP: return { type: 'video-rtcp', data: p.subarray(5) };
    case KIND_RESPONSE: {
      const r = parseInitResponse(p);
      if (r) return { type: 'init', ...r };
      if (p.length >= 21 && p.readUInt16LE(18) === SUB_END_CALL) return { type: 'end', uid: p.readUInt32LE(10), data: p };
      return { type: 'response', data: p };
    }
    case KIND_REQUEST: {
      const subcmd = p.length >= 21 ? p.readUInt16LE(18) : -1;
      if (subcmd === SUB_ECHO) return { type: 'echo', id: p.readUInt32LE(6), data: p };
      if (subcmd === SUB_SIGNAL) return { type: 'signal', uid: p.readUInt32LE(10), data: p };
      return { type: 'request', subcmd, data: p };
    }
    case KIND_P2P: return { type: 'p2p', data: p };
    default: return { type: 'unknown', data: p };
  }
}

// Split an Opus packet into single-frame (code 0) packets, RFC 6716 §3.2.
// Chromium 108's encoder ignores opus.frameDuration and emits 60 ms code-3
// packets; Zalo negotiates 20 ms per RTP packet.
function splitOpus(p) {
  const code = p[0] & 3;
  const toc = p[0] & 0xfc;
  const frames = [];
  if (code === 0) return [p];
  if (code === 1) {
    const n = (p.length - 1) / 2;
    frames.push(p.subarray(1, 1 + n), p.subarray(1 + n));
  } else if (code === 2) {
    let off = 1;
    let len = p[off++];
    if (len >= 252) len += 4 * p[off++];
    frames.push(p.subarray(off, off + len), p.subarray(off + len));
  } else {
    const vbr = p[1] & 0x80, padded = p[1] & 0x40, count = p[1] & 0x3f;
    let off = 2, pad = 0;
    if (padded) {
      let b;
      do { b = p[off++]; pad += b === 255 ? 254 : b; } while (b === 255);
    }
    const end = p.length - pad;
    const lens = [];
    if (vbr) {
      for (let i = 0; i < count - 1; i++) {
        let len = p[off++];
        if (len >= 252) len += 4 * p[off++];
        lens.push(len);
      }
      lens.push(end - off - lens.reduce((a, b) => a + b, 0));
    } else {
      for (let i = 0; i < count; i++) lens.push((end - off) / count);
    }
    for (const len of lens) { frames.push(p.subarray(off, off + len)); off += len; }
  }
  return frames.map(f => Buffer.concat([Buffer.from([toc]), f]));
}

// RTP with the one-byte header extension Zalo always sends: id 5, 2 bytes =
// transport-wide sequence number (big-endian), padded to 4 bytes.
function buildRtp({ marker, pt, seq, ts, ssrc, twcc, payload, ext = true }) {
  if (!ext) {
    const h = Buffer.alloc(12);
    h[0] = 0x80;
    h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
    h.writeUInt16BE(seq & 0xffff, 2);
    h.writeUInt32BE(ts >>> 0, 4);
    h.writeUInt32BE(ssrc >>> 0, 8);
    return Buffer.concat([h, payload]);
  }
  const h = Buffer.alloc(20);
  h[0] = 0x90; // V=2, X=1
  h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(ts >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  h[12] = 0xbe; h[13] = 0xde; h.writeUInt16BE(1, 14);
  h[16] = 0x51; h.writeUInt16BE(twcc & 0xffff, 17); h[19] = 0;
  return Buffer.concat([h, payload]);
}

// ---- H.264 over RTP (RFC 6184) --------------------------------------------

// Annex B byte stream → NAL units (without start codes).
function splitAnnexB(b) {
  const nals = [];
  let start = -1;
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) nals.push(b.subarray(start, i > 0 && b[i - 1] === 0 ? i - 1 : i));
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0) nals.push(b.subarray(start));
  else if (b.length) nals.push(b);
  return nals.filter(n => n.length);
}

// One access unit (Annex B) → RTP payloads: single NAL units, or FU-A
// fragments for NALs larger than `max`.
function packetizeH264(annexb, max = 1150) {
  const out = [];
  for (const nal of splitAnnexB(annexb)) {
    if (nal.length <= max) { out.push(nal); continue; }
    const fnri = nal[0] & 0xe0, type = nal[0] & 0x1f;
    for (let off = 1; off < nal.length; off += max - 2) {
      const end = Math.min(off + max - 2, nal.length);
      const fuHeader = (off === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type;
      out.push(Buffer.concat([Buffer.from([fnri | 28, fuHeader]), nal.subarray(off, end)]));
    }
  }
  return out;
}

// Zalo's own mode (webrtc RtpPacketizerH264 patched with a mode 3, what the
// phones send): an access unit that fits one packet goes out as raw Annex B;
// a larger one, start codes included, is cut into FU-A-shaped packets
// `1c | S/E bits (NAL type 0) | bytes`.
function packetizeH264Zalo(annexb, max = 1100) {
  if (annexb.length <= max + 2) return [annexb];
  const out = [];
  for (let off = 0; off < annexb.length; off += max) {
    const end = Math.min(off + max, annexb.length);
    out.push(Buffer.concat([Buffer.from([0x1c, (off === 0 ? 0x80 : 0) | (end === annexb.length ? 0x40 : 0)]), annexb.subarray(off, end)]));
  }
  return out;
}

const isZaloFragment = p => p.length >= 2 && (p[0] & 0x1f) === 28 && (p[1] & 0x1f) === 0;
const isAnnexB = p => p.length >= 4 && p[0] === 0 && p[1] === 0 && (p[2] === 1 || (p[2] === 0 && p[3] === 1));

function hasKeyNal(annexb) {
  return splitAnnexB(annexb).some(n => (n[0] & 0x1f) === 5 || (n[0] & 0x1f) === 7);
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

// RTP payloads → access units. push() returns a finished {data (Annex B),
// key, ts} when a frame completes (marker bit), or null. A sequence gap
// drops the frame and sets `needKeyframe` until the next IDR.
class H264Depacketizer {
  constructor() {
    this.parts = [];
    this.ts = null;
    this.lastSeq = null;
    this.broken = false;
    this.needKeyframe = true;
    this.fu = null;
  }

  // A packet of the stream that carries no picture (other payload type):
  // keep the sequence check in step.
  skip(rtp) {
    if (this.lastSeq === null || ((rtp.seq - this.lastSeq) & 0xffff) < 0x8000) this.lastSeq = rtp.seq;
  }

  push(rtp) {
    if (this.lastSeq !== null && ((rtp.seq - this.lastSeq) & 0xffff) !== 1) this.broken = true;
    this.lastSeq = rtp.seq;
    if (this.ts !== rtp.ts) { this.parts = []; this.raw = null; this.fu = null; this.ts = rtp.ts; if (this.broken) this.needKeyframe = true; this.broken = false; }
    const p = rtp.payload;
    if (!p.length) return null;
    const type = p[0] & 0x1f;
    if (isZaloFragment(p) || isAnnexB(p)) {
      if (isAnnexB(p)) this.raw = [p];
      else {
        if (p[1] & 0x80) this.raw = [];
        if (this.raw) this.raw.push(p.subarray(2));
        else this.broken = true;
      }
      if (!(p[1] & 0x40) && !rtp.marker) return null;
      const raw = this.raw;
      this.raw = null;
      this.ts = null;
      if (this.broken || !raw) { this.broken = false; this.needKeyframe = true; return null; }
      const data = Buffer.concat(raw);
      const nals = splitAnnexB(data).map(n => n[0] & 0x1f);
      if (!nals.some(t => t >= 1 && t <= 5)) return null; // no picture (SEI/parameter sets only)
      const key = nals.includes(5) || nals.includes(7);
      if (this.needKeyframe && !key) return null;
      if (key) this.needKeyframe = false;
      return { data, key, ts: rtp.ts, nals };
    }
    if (type >= 1 && type <= 23) this.parts.push(p);
    else if (type === 24) { // STAP-A
      for (let off = 1; off + 2 <= p.length;) {
        const len = p.readUInt16BE(off);
        this.parts.push(p.subarray(off + 2, off + 2 + len));
        off += 2 + len;
      }
    } else if (type === 28) { // FU-A
      const start = p[1] & 0x80, end = p[1] & 0x40;
      if (start) this.fu = [Buffer.from([(p[0] & 0xe0) | (p[1] & 0x1f)]), p.subarray(2)];
      else if (this.fu) this.fu.push(p.subarray(2));
      else this.broken = true;
      if (end && this.fu) { this.parts.push(Buffer.concat(this.fu)); this.fu = null; }
    }
    if (!rtp.marker) return null;
    const parts = this.parts;
    this.parts = [];
    this.ts = null;
    if (this.broken) { this.broken = false; this.needKeyframe = true; return null; }
    const key = parts.some(n => (n[0] & 0x1f) === 5 || (n[0] & 0x1f) === 7);
    if (!parts.some(n => (n[0] & 0x1f) >= 1 && (n[0] & 0x1f) <= 5)) return null;
    if (this.needKeyframe && !key) return null;
    if (key) this.needKeyframe = false;
    const data = Buffer.concat(parts.flatMap(n => [START_CODE, n]));
    return { data, key, ts: rtp.ts, nals: parts.map(n => n[0] & 0x1f) };
  }
}

// ---- RTCP ------------------------------------------------------------------

// NTP timestamp (RFC 3550) of `ms` since the Unix epoch → [seconds, fraction].
function ntp(ms) {
  const secs = Math.floor(ms / 1000) + 2208988800;
  return [secs >>> 0, Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0];
}

// SR (PT 200) for our stream with one report block on the partner's, then a
// REMB (PT 206 FMT 15) advertising `remb` bit/s. rb: {ssrc, fractionLost,
// lost, highestSeq, jitter, lsr, dlsr}; null → no report block.
function buildSenderReport({ ssrc, rtpTs, packets, octets, rb, remb, nowMs = Date.now() }) {
  const parts = [];
  const sr = Buffer.alloc(rb ? 52 : 28);
  sr[0] = 0x80 | (rb ? 1 : 0); sr[1] = 200; sr.writeUInt16BE(sr.length / 4 - 1, 2);
  sr.writeUInt32BE(ssrc >>> 0, 4);
  const [hi, lo] = ntp(nowMs);
  sr.writeUInt32BE(hi, 8); sr.writeUInt32BE(lo, 12);
  sr.writeUInt32BE(rtpTs >>> 0, 16); sr.writeUInt32BE(packets >>> 0, 20); sr.writeUInt32BE(octets >>> 0, 24);
  if (rb) {
    sr.writeUInt32BE(rb.ssrc >>> 0, 28);
    sr.writeUInt32BE(((rb.fractionLost & 0xff) << 24 | Math.min(rb.lost, 0x7fffff)) >>> 0, 32);
    sr.writeUInt32BE(rb.highestSeq >>> 0, 36);
    sr.writeUInt32BE(rb.jitter >>> 0, 40);
    sr.writeUInt32BE(rb.lsr >>> 0, 44);
    sr.writeUInt32BE(rb.dlsr >>> 0, 48);
  }
  parts.push(sr);
  if (remb && rb) {
    const b = Buffer.alloc(24);
    b[0] = 0x8f; b[1] = 206; b.writeUInt16BE(5, 2);
    b.writeUInt32BE(ssrc >>> 0, 4); b.writeUInt32BE(0, 8); b.write('REMB', 12, 'latin1');
    let exp = 0, mantissa = remb;
    while (mantissa > 0x3ffff) { mantissa = Math.floor(mantissa / 2); exp++; }
    b[16] = 1; b[17] = (exp << 2) | (mantissa >> 16); b.writeUInt16BE(mantissa & 0xffff, 18);
    b.writeUInt32BE(rb.ssrc >>> 0, 20);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// Middle 32 bits of the NTP time in an SR (for the LSR field), or null.
function srMiddleNtp(b) {
  for (let off = 0; off + 8 <= b.length;) {
    const pt = b[off + 1], len = (b.readUInt16BE(off + 2) + 1) * 4;
    if (pt === 200 && off + 16 <= b.length) return ((b.readUInt16BE(off + 10) << 16) | b.readUInt16BE(off + 12)) >>> 0;
    off += len;
  }
  return null;
}

// RTCP feedback: PLI (RFC 4585, PT 206 FMT 1).
function buildPli(senderSsrc, mediaSsrc) {
  const b = Buffer.alloc(12);
  b[0] = 0x81; b[1] = 206; b.writeUInt16BE(2, 2);
  b.writeUInt32BE(senderSsrc >>> 0, 4); b.writeUInt32BE(mediaSsrc >>> 0, 8);
  return b;
}

// Does an RTCP compound packet ask for a keyframe (PLI or FIR)?
function rtcpWantsKeyframe(b) {
  for (let off = 0; off + 4 <= b.length;) {
    const fmt = b[off] & 0x1f, pt = b[off + 1], len = (b.readUInt16BE(off + 2) + 1) * 4;
    if (pt === 206 && (fmt === 1 || fmt === 4)) return true;
    if (len <= 0) break;
    off += len;
  }
  return false;
}

function parseRtp(p) {
  if (p.length < 12 || (p[0] >> 6) !== 2) return null;
  let off = 12 + 4 * (p[0] & 0x0f);
  if (p[0] & 0x10) off += 4 + 4 * p.readUInt16BE(off + 2);
  let end = p.length;
  if (p[0] & 0x20) end -= p[p.length - 1];
  return {
    marker: !!(p[1] & 0x80),
    pt: p[1] & 0x7f,
    seq: p.readUInt16BE(2),
    ts: p.readUInt32BE(4),
    ssrc: p.readUInt32BE(8),
    payload: p.subarray(off, end),
  };
}

module.exports = {
  buildEcho, buildPing, buildEndCall, buildStatus, buildInitCall, splitOpus,
  wrapVideo, wrapVideoRtcp, buildSenderReport, srMiddleNtp, splitAnnexB, packetizeH264, packetizeH264Zalo, hasKeyNal, H264Depacketizer, buildPli, rtcpWantsKeyframe, parseInitResponse, parseRelayDatagram, wrapAudio, wrapRtcp, buildRtp, parseRtp,
};

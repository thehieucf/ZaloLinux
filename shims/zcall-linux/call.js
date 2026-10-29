'use strict';
// 1:1 voice calls handled by the Linux engine. Signaling is delegated to Zalo
// (engine → `sendSignal`, Zalo performs the HTTP request, the result comes
// back as `recvSignal`; the partner's actions arrive as `control` pushes);
// media is SRTP over one of the relays both sides registered on.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const os = require('os');
const { RelayPool } = require('./relay');
const { SrtpContext } = require('./srtp');
const P = require('./packets');
const fs = require('fs');
const path = require('path');
const { log, zaloData } = require('./log');

const SIG = {
  REQUEST_CALL: 401, ANSWER: 402, CANCEL: 405, LOG_END: 406, RINGRING: 407, ANSWER_ACK: 408, END: 409, REQUEST: 416,
  CAM_MIC: 12006, // /api/voicecall/conf {calleeId, callId, isOnCam, isOnMic, data}
  SHARE_SCREEN: 12064, // /api/voicecall/requestsharescreen {uidTo, callId, status 1 on / 0 off}
};
// 406 logendcall status, from ZaloCall.exe FUN_007d7840. Zalo's servers build
// the chat's call message from it (without it: incoming shows "missed",
// outgoing shows nothing). Connected calls report a quality bucket
// (argmax of six counters × 10 + flag, 0..51); we report the top bucket.
const LOG_STATUS = {
  connected: 50, callerUnanswered: 0x67, callerBusy: 0x69, callerDeclined: 0x6a, calleeDeclined: 0xa0,
};
// 402 status, from ZaloCall.exe: 0 once the media path is up (FUN_007d8ef0),
// 3 when the user declines or closes the ringing window (UiAnswerCallEvent /
// UiCloseEvent) — the caller shows "declined".
// 1 is what a phone answers within ~150 ms while it is itself dialing us
// (supportCallBusy): busy.
const ANSWER_STATUS_ACCEPT = 0;
const ANSWER_STATUS_BUSY = 1;
const ANSWER_STATUS_DECLINE = 3;
const MEDIA_TIMEOUT_MS = 20000;
const SIGNAL_TIMEOUT_MS = 15000;
const ALERT_TIMEOUT_MS = 60000;
const CALLER_RELAYS = 2; // the PC caller in re/call1.pcap registered on two relays
const REMOTE_END_ACTS = ['end', 'end_call', 'endcall', 'cancel', 'reject', 'busy'];
// What we offer when calling: the codec mobile clients pick for voice.
const VOICE_CODEC = { dynamicFptime: 0, frmPtime: 20, name: 'opus/16000/1', payload: 112 };
// Video: H.264 (extendData `video.codec`, what the phones offer), 90 kHz RTP clock.
const VIDEO_CODEC = { name: 'h264', payload: 97 };
const VIDEO_CLOCK = 90000;
const VIDEO_FRAME_US = 66667; // assumed frame gap across a timestamp jump
// Phones send their pictures as pt 97 (delta frames) and 98 (keyframes), both
// Zalo mode-3 H.264: the receiver learns the frame type from the payload type
// (mode-3 parsing cannot see it), so our keyframes go out as 98 too. Other
// payload types on the video transport (100: unknown, rare) are skipped.
const VIDEO_PICTURE_PTS = [97, 98];
const keyframePt = pt => pt + 1;
const VIDEO_TRACE_PACKETS = 300;
// What we tell the phone it may send us (REMB); zrtc_config maxBitrate is 800 kbit/s.
const VIDEO_REMB_BPS = 800000;
const KEYFRAME_REQUEST_MS = 1000;
// makeCall / 401 `type`: 1 voice, 3 video (ZaloCall.exe zcallinfo +0x5b8).
const CALL_TYPE = { voice: 1, video: 3 };

function parseJson(s, fallback) {
  try { return typeof s === 'string' ? JSON.parse(s) : (s || fallback); } catch (e) { return fallback; }
}

// "opus/16000/1" → { name, clock, channels }
function describeCodec(c) {
  const [name, clock, channels] = String(c.name).split('/');
  return { name: name.toLowerCase(), clock: Number(clock) || 48000, channels: Number(channels) || 1, pt: c.payload };
}

function chooseCodec(offerJson) {
  const offer = parseJson(offerJson, []);
  const opus = (Array.isArray(offer) ? offer : [offer]).filter(c => c && /^opus\//i.test(c.name));
  // Prefer mono 16 kHz (what mobile sends), else whatever opus is offered.
  return opus.find(c => /16000\/1$/.test(c.name)) || opus[0] || null;
}

// Relays of a 401 response: `rtpIP` plus `servers`, an array of
// {rtpaddr, rtcpaddr, rtpIPv6, rtcpIPv6, bonus, spTcp} (strings tolerated).
function parseServers(r) {
  let list = parseJson(r.servers, []);
  if (!Array.isArray(list)) list = [];
  const addrs = [r.rtpIP, ...list.map(s => (typeof s === 'string' ? s : s && (s.rtpaddr || s.rtp)))];
  return [...new Set(addrs.filter(a => typeof a === 'string' && /:\d+$/.test(a)))];
}

class CallSession extends EventEmitter {
  constructor({ engine, myUid }) {
    super();
    this.engine = engine; // { sendSignal(cmd, data), sendUpdate(cmd, data) }
    this.myUid = myUid;
    this.callId = 0;
    this.partnerUid = 0;
    // Signals name the partner by the noised id as a string (ZaloCall.exe reads
    // `uidN` as a string and sends it as callerId/toId); the server accepts the
    // numeric uid too but then does not notify the right devices.
    this.partnerNoisedId = '';
    this.partner = { name: '', avatar: '' };
    this.isVideo = false;
    this.session = '';
    this.srtp = null;
    this.codecEntry = null;
    this.codec = null;
    this.state = 'idle';
    this.relay = null;
    this.busy = false; // told Zalo callState=calling
    this.camOn = true;
    this.micOn = true;
    this.sharing = false; // our video shows the screen instead of the camera
    this.partnerSharing = false;
    this.tx = { seq: crypto.randomInt(0, 65535), ts: crypto.randomInt(0, 2 ** 31), twcc: 1, first: true };
    this.lastMediaAt = 0;
    this.rxStats = { srtp: 0, plain: 0, other: 0, pts: {}, seq: null };
    this.txPackets = 0;
    this.watchdog = null;
    this.startedAt = 0;
    this.video = {
      pt: VIDEO_CODEC.payload, srtp: null, depack: new P.H264Depacketizer(), partnerSsrc: null, ssrc: null,
      seq: crypto.randomInt(0, 65535), tsBase: crypto.randomInt(0, 2 ** 31), lastPli: 0, lastUs: null, clockUs: 0,
      rx: { srtp: 0, plain: 0, bad: 0, frames: 0, keys: 0, pts: {}, keyRequests: 0 }, tx: { packets: 0, frames: 0, keys: 0 },
      // RTCP bookkeeping (RFC 3550 A.3): partner's stream, our stream.
      recv: { base: null, max: 0, cycles: 0, count: 0, expectedPrior: 0, receivedPrior: 0, lsr: 0, lsrAt: 0 },
      sent: { octets: 0, lastTs: 0 },
    };
  }

  _setSession(session) {
    this.session = session;
    this.srtp = SrtpContext.fromSession(session);
    this.video.srtp = SrtpContext.fromSession(session);
  }

  // Partner's video payload type from its extendData (`video.codec`).
  _setVideoCodec(ext) {
    const h264 = ((ext && ext.video && ext.video.codec) || []).find(c => /h264/i.test(c.name));
    if (h264) this.video.pt = h264.payload;
  }

  get info() {
    return { callId: this.callId, state: this.state, direction: this.direction, partner: this.partner,
      isVideo: this.isVideo, codec: this.codec, startedAt: this.startedAt, sharing: this.sharing, partnerSharing: this.partnerSharing };
  }

  _setState(state, extra = {}) {
    this.state = state;
    log('call', `${this.callId} state=${state} ${JSON.stringify(extra)}`);
    this.emit('state', { ...this.info, ...extra });
  }

  _setCodec(entry) {
    this.codecEntry = entry;
    this.codec = entry ? describeCodec(entry) : null;
  }

  _setBusy(busy) {
    if (busy === this.busy) return;
    this.busy = busy;
    this.engine.sendUpdate('callState', { state: busy ? 'calling' : 'free' });
  }

  _newPool(addresses, isCaller) {
    this.relay = new RelayPool(addresses, {
      isCaller, myUid: this.myUid, callId: this.callId, partnerUid: this.partnerUid, session: this.session,
    });
    this.relay.on('rtp', p => this._onRtp(p));
    this.relay.on('video', p => this._onVideo(p));
    this.relay.on('video-rtcp', p => this._onVideoRtcp(p));
    this.relay.on('error', e => { log('call', `relay error: ${e.message}`); this.end('network'); });
    this.relay.on('partner-left', r => log('call', `${this.callId} partner left relay ${r.address}`));
    return this.relay;
  }

  _extendData(chosen) {
    const live = [chosen.address, ...this.relay.relays.filter(r => r.live && r !== chosen).map(r => r.address)];
    return JSON.stringify({
      callType: this.isVideo ? 1 : 0, gccAudio: 0, gccMode: 0, gccSVLR: 0, maxFT: 60, negoVidQual: 0, newZrtc: 1,
      p2p: [], packetMode: 2, platform: 3, sP2P: 0,
      serverAddr: live.map(a => ({ bonus: 0, rtcp: a, rtcpIPv6: '', rtp: a, rtpIPv6: '', tpType: 0 })),
      serverResult: this.relay.results(), spTcp: 0, srtcp: 0, srtpMode: 1, supportCallBusy: 1,
      supportHevcDecode: 0, tpType: 0, video: { codec: this.isVideo ? [{ name: VIDEO_CODEC.name, payload: this.video.pt }] : [] },
    }) + '\n';
  }

  // Media path agreed on `relay`: start talking.
  _startMedia(relay) {
    this.relay.lock(relay);
    this._setBusy(true);
    this.startedAt = Date.now();
    this.lastMediaAt = Date.now();
    this._setState('active');
    if (this.isVideo) this.setMediaState();
    let tick = 0;
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMediaAt > MEDIA_TIMEOUT_MS) this.end('no-media');
      if (this.isVideo) this._sendVideoRtcp();
      if (++tick % 5 === 0) {
        log('media', `rx ${JSON.stringify(this.rxStats)} tx ${this.txPackets}`);
        if (this.isVideo) log('video', `rx ${JSON.stringify(this.video.rx)} tx ${JSON.stringify(this.video.tx)}`);
      }
    }, 1000);
  }

  _onRtp(srtp) {
    const st = this.rxStats;
    let plain = this.srtp.unprotect(srtp);
    if (plain) st.srtp++;
    else {
      // Early media (before the answer) arrives as plain RTP.
      st.plain++;
      plain = srtp;
    }
    const rtp = P.parseRtp(plain);
    if (!rtp || rtp.ssrc !== this.partnerUid) { st.other++; return; }
    st.pts[rtp.pt] = (st.pts[rtp.pt] || 0) + 1;
    st.seq = rtp.seq;
    this.lastMediaAt = Date.now();
    if (!this.loggedFirstRx) { log('media', `first rx pt=${rtp.pt} seq=${rtp.seq} len=${rtp.payload.length}`); this.loggedFirstRx = true; }
    this.emit('audio-in', { pt: rtp.pt, seq: rtp.seq, ts: rtp.ts, payload: rtp.payload });
  }

  _onVideo(srtp) {
    const v = this.video;
    let plain = v.srtp.unprotect(srtp);
    if (plain) v.rx.srtp++;
    else { v.rx.plain++; plain = srtp; }
    const rtp = P.parseRtp(plain);
    if (!rtp) { v.rx.bad++; return; }
    v.rx.pts[rtp.pt] = (v.rx.pts[rtp.pt] || 0) + 1;
    this._traceVideo(rtp, plain.length);
    if (v.partnerSsrc === null) {
      v.partnerSsrc = rtp.ssrc;
      // Mirror the partner's audio→video SSRC relation for our own stream.
      v.ssrc = (this.myUid + (rtp.ssrc - this.partnerUid)) >>> 0;
      log('video', `first rx srtp=${v.rx.srtp > 0} pt=${rtp.pt} ssrc=${rtp.ssrc} (partner uid ${this.partnerUid}) `
        + `marker=${rtp.marker} hdr=${plain.subarray(0, Math.min(plain.length, 24)).toString('hex')} payload=${rtp.payload.subarray(0, 8).toString('hex')}`);
    }
    if (rtp.ssrc !== v.partnerSsrc) { v.rx.bad++; return; }
    this.lastMediaAt = Date.now();
    const rc = v.recv;
    if (rc.base === null) { rc.base = rtp.seq; rc.max = rtp.seq; }
    else if (((rtp.seq - rc.max) & 0xffff) < 0x8000) {
      if (rtp.seq < rc.max) rc.cycles += 0x10000;
      rc.max = rtp.seq;
    }
    rc.count++;
    if (!VIDEO_PICTURE_PTS.includes(rtp.pt) && rtp.pt !== v.pt && rtp.pt !== keyframePt(v.pt)) { v.depack.skip(rtp); return; }
    const au = v.depack.push(rtp);
    if (v.depack.needKeyframe) this._requestKeyframe();
    if (!au) return;
    v.rx.frames++;
    if (v.rx.frames <= 3) log('video', `rx frame ${v.rx.frames} pt=${rtp.pt} key=${au.key} nals=${au.nals.join(',')} head=${au.data.subarray(0, 48).toString('hex')}`);
    if (au.key) {
      v.rx.keys++;
      if (v.rx.keys === 1) log('video', `first keyframe nals=${au.nals.join(',')} bytes=${au.data.length}`);
    }
    this.emit('video-in', { data: au.data, key: au.key, ts: au.ts });
  }

  // First packets of the partner's video, one line each, for protocol work.
  _traceVideo(rtp, size) {
    const v = this.video;
    if ((v.traced = (v.traced || 0) + 1) > VIDEO_TRACE_PACKETS) return;
    const line = `${Date.now() % 100000} pt=${rtp.pt} seq=${rtp.seq} ts=${rtp.ts} m=${rtp.marker ? 1 : 0} len=${size} `
      + `p=${rtp.payload.subarray(0, 12).toString('hex')}\n`;
    try { fs.appendFileSync(path.join(zaloData, 'zcall-video-trace.log'), (v.traced === 1 ? `--- call ${this.callId}\n` : '') + line); } catch (e) { /* best effort */ }
  }

  // Tell the partner our camera/microphone state (what its UI shows).
  setMediaState({ cam = this.camOn, mic = this.micOn } = {}) {
    this.camOn = cam;
    this.micOn = mic;
    if (this.state !== 'active') return;
    this.engine.sendSignal(SIG.CAM_MIC, {
      calleeId: this.partnerNoisedId, callId: this.callId, isOnCam: this.isVideo && cam ? 1 : 0, isOnMic: mic ? 1 : 0, data: '',
    });
  }

  // 1-1 calls share the screen on the normal video stream (ZaloCall.exe: "camera
  // will be turned off during screen sharing"); the signal only tells the
  // partner's UI (sendOnOffSharescreen; the partner gets act share_screen).
  setScreenShare(on) {
    this.sharing = !!on;
    if (this.state !== 'active') return;
    this.engine.sendSignal(SIG.SHARE_SCREEN, { uidTo: this.partnerNoisedId, callId: this.callId, status: on ? 1 : 0 });
  }

  // Partner's in-call toggles we show; true when handled.
  _onMediaControl(c) {
    if (c.act !== 'share_screen') return false;
    const d = c.data || {};
    const params = parseJson(d.params, {});
    this.partnerSharing = Number(params.status !== undefined ? params.status : d.status) === 1;
    this.emit('state', this.info);
    return true;
  }

  _requestKeyframe() {
    const v = this.video;
    if (!this.relay || v.partnerSsrc === null || Date.now() - v.lastPli < KEYFRAME_REQUEST_MS) return;
    v.lastPli = Date.now();
    this.relay.sendVideoRtcp(P.buildPli(v.ssrc || this.myUid, v.partnerSsrc));
  }

  _onVideoRtcp(b) {
    if (!this.loggedVideoRtcp) { log('video', `first rtcp ${b.subarray(0, 16).toString('hex')}`); this.loggedVideoRtcp = true; }
    const lsr = P.srMiddleNtp(b);
    if (lsr !== null) { this.video.recv.lsr = lsr; this.video.recv.lsrAt = Date.now(); }
    if (P.rtcpWantsKeyframe(b)) {
      this.video.rx.keyRequests++;
      this.emit('keyframe-request');
    }
  }

  // Once a second: SR for our video + receiver report and REMB for the
  // partner's, so its bandwidth estimator sees a healthy path.
  _sendVideoRtcp() {
    const v = this.video, rc = v.recv;
    if (!this.relay || !this.isVideo) return;
    let rb = null;
    if (v.partnerSsrc !== null && rc.base !== null) {
      const extMax = rc.cycles + rc.max;
      const expected = extMax - rc.base + 1;
      const expInterval = expected - rc.expectedPrior, recvInterval = rc.count - rc.receivedPrior;
      rc.expectedPrior = expected;
      rc.receivedPrior = rc.count;
      const lostInterval = expInterval - recvInterval;
      rb = {
        ssrc: v.partnerSsrc, fractionLost: expInterval > 0 && lostInterval > 0 ? Math.floor((lostInterval << 8) / expInterval) : 0,
        lost: Math.max(0, expected - rc.count), highestSeq: extMax, jitter: 0,
        lsr: rc.lsr, dlsr: rc.lsrAt ? Math.round((Date.now() - rc.lsrAt) * 65.536) : 0,
      };
    }
    this.relay.sendVideoRtcp(P.buildSenderReport({
      ssrc: v.ssrc === null ? this.myUid : v.ssrc, rtpTs: v.sent.lastTs, packets: v.tx.packets, octets: v.sent.octets,
      rb, remb: VIDEO_REMB_BPS,
    }));
  }

  // Encoded H.264 access unit (Annex B) from the call window.
  sendVideo(data, key, timestampUs) {
    if (this.state !== 'active' || !this.relay || !this.isVideo) return;
    const v = this.video;
    const ssrc = v.ssrc === null ? this.myUid : v.ssrc;
    // Keep the RTP clock continuous when the source (camera ↔ screen) and with
    // it the frame timestamps change.
    const step = v.lastUs === null ? 0 : timestampUs - v.lastUs;
    v.clockUs += step > 0 && step < 1e6 ? step : (v.lastUs === null ? 0 : VIDEO_FRAME_US);
    v.lastUs = timestampUs;
    const ts = (v.tsBase + Math.round(v.clockUs * VIDEO_CLOCK / 1e6)) >>> 0;
    v.sent.lastTs = ts;
    v.sent.octets += data.length;
    // Same shape as the phones' video: Zalo mode-3 fragments, no header extension.
    const payloads = P.packetizeH264Zalo(data);
    payloads.forEach((payload, i) => {
      const rtp = P.buildRtp({ marker: i === payloads.length - 1, pt: key ? keyframePt(v.pt) : v.pt, seq: v.seq, ts, ssrc, payload, ext: false });
      v.seq = (v.seq + 1) & 0xffff;
      this.relay.sendVideoSrtp(v.srtp.protect(rtp));
      v.tx.packets++;
    });
    v.tx.frames++;
    if (key) v.tx.keys++;
  }

  // Encoded Opus frame from the call window; durationUs from WebCodecs.
  sendAudio(payload, durationUs) {
    if (this.state !== 'active' || !this.relay) return;
    const frames = P.splitOpus(payload);
    const each = (durationUs || 20000 * frames.length) / frames.length;
    for (const f of frames) this._sendFrame(f, each);
  }

  _sendFrame(payload, durationUs) {
    const t = this.tx;
    const rtp = P.buildRtp({ marker: t.first, pt: this.codec.pt, seq: t.seq, ts: t.ts, ssrc: this.myUid, twcc: t.twcc, payload });
    t.first = false;
    t.seq = (t.seq + 1) & 0xffff;
    t.twcc = (t.twcc + 1) & 0xffff;
    t.ts = (t.ts + Math.round((durationUs || 20000) * this.codec.clock / 1e6)) >>> 0;
    this.relay.sendSrtp(this.srtp.protect(rtp));
    this.txPackets++;
  }

  // Response to one of our signals (`recvSignal`).
  onSignal(command, data) {
    log('call', `${this.callId} signal response ${command} ${JSON.stringify(data).slice(0, 300)}`);
  }

  hangup() {
    this.end('local-hangup');
  }

  // 406 status for how this call ended, or null when the original sends none.
  _logStatus(reason) {
    if (this.startedAt) return LOG_STATUS.connected;
    if (this.direction === 'in') return reason === 'declined' ? LOG_STATUS.calleeDeclined : null;
    if (!this.relay) return null; // never got a call id
    if (reason === 'busy') return LOG_STATUS.callerBusy;
    if (reason === 'declined-remote') return LOG_STATUS.callerDeclined;
    return LOG_STATUS.callerUnanswered;
  }

  _logEnd(reason) {
    const status = this._logStatus(reason);
    if (status === null) return;
    const duration = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    this.engine.sendSignal(SIG.LOG_END, {
      callId: this.callId, partnerId: this.partnerNoisedId, status, role: this.direction === 'out', duration,
      data: JSON.stringify({ duration, sysInfo: `${os.type()}_${os.release()}_${process.platform}_${process.arch}`, devcInfo: '' }),
    });
  }

  end(reason, { silent = false } = {}) {
    if (this.state === 'ended') return;
    if (this.state === 'active' && !silent) this.engine.sendSignal(SIG.END, { toId: this.partnerNoisedId, callId: this.callId });
    this._logEnd(reason);
    this._setBusy(false);
    clearInterval(this.watchdog);
    clearTimeout(this.timer);
    if (this.relay) this.relay.close();
    this._setState('ended', { reason, duration: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0 });
    this.emit('ended', reason);
  }
}

class IncomingCall extends CallSession {
  constructor({ engine, request, myUid }) {
    super({ engine, myUid });
    this.direction = 'in';
    const d = request.data;
    this.params = parseJson(d.params, {});
    this.callId = Number(d.callId);
    this.partnerUid = Number(d.uidFrom);
    this.partnerNoisedId = String(d.uidN || d.uidFrom);
    this._setSession(d.session || this.params.sessId);
    this.relayAddress = d.rtpAddress || this.params.rtpIP;
    const ext = parseJson(this.params.extendData, {});
    this.relayCandidates = [this.relayAddress,
      ...(ext.serverAddr || []).map(s => s.rtp), ...(ext.serverResult || []).map(s => s.rtp)].filter(Boolean);
    this.partner = { name: this.params.Dname || '', avatar: this.params.avatar || '' };
    this.isVideo = !!(this.params.video && this.params.video.enable && ext.callType === 1);
    this._setVideoCodec(ext);
    this._setCodec(chooseCodec(d.codec) || chooseCodec(this.params.codec));
    this.probing = null;
  }

  ring() {
    log('call', `incoming ${this.callId} from ${this.partnerUid} relay=${this.relayAddress} codec=${JSON.stringify(this.codecEntry)} video=${this.isVideo}`);
    this.engine.sendSignal(SIG.RINGRING, { callerId: this.partnerNoisedId, callId: this.callId });
    this._setState('ringing');
    if (!this.relayCandidates.length) return;
    // Measure the relays while ringing so the answer can carry `serverResult`.
    this._newPool(this.relayCandidates, false);
    this.probing = this.relay.open().then(() => this.relay.probe())
      .catch(e => log('call', `relay probe failed: ${e.message}`));
  }

  async accept() {
    if (this.state !== 'ringing') return;
    if (!this.codec || !this.relay || !this.session) {
      this.end('unsupported');
      return;
    }
    this._setState('connecting');
    await this.probing;
    if (this.state !== 'connecting') return;
    // First relay registered: give the others a moment, then answer.
    this.relay.once('ready', () => setTimeout(() => this._answer(), 300));
    this.relay.join();
  }

  _answer() {
    if (this.state !== 'connecting') return;
    const ready = this.relay.relays.filter(r => r.live);
    // The caller follows the relay named in the answer: prefer the one already
    // carrying its media, then its preferred relay.
    const relay = [this.relay.mediaRelay].find(r => r && r.live)
      || ready.find(r => r.address === this.relayAddress) || ready[0];
    if (!relay) { this.end('network'); return; }
    log('call', `${this.callId} answering via ${relay.address}; probes ${JSON.stringify(this.relay.results().map(r => [r.rtp, r.recv, r.rtt]))}`);
    this.engine.sendSignal(SIG.ANSWER, {
      callerId: this.partnerNoisedId,
      callId: this.callId,
      status: ANSWER_STATUS_ACCEPT,
      codec: JSON.stringify([this.codecEntry]),
      extendData: this._extendData(relay),
      rtcpAddress: relay.address,
      rtpAddress: relay.address,
      session: this.session,
    });
    this._startMedia(relay);
  }

  // Server push for this call (act: request/answer/cancel/end…).
  onControl(c) {
    log('call', `${this.callId} control act=${c.act} status=${c.data && c.data.status}`);
    if (this._onMediaControl(c)) return;
    if (this.state === 'ringing' && (c.act === 'answer' || c.act === 'cancel')) {
      this.end(c.act === 'answer' ? 'answered-elsewhere' : 'cancelled', { silent: true });
    } else if (REMOTE_END_ACTS.includes(c.act)) {
      this.end('remote-hangup', { silent: true });
    }
  }

  hangup() {
    if (this.state === 'ringing' || this.state === 'connecting') this.decline();
    else this.end('local-hangup');
  }

  // Reject the call for every device, like the original "Từ chối".
  decline() {
    if (this.state !== 'ringing' && this.state !== 'connecting') return;
    this._reply(ANSWER_STATUS_DECLINE);
    this.end('declined', { silent: true });
  }

  // We are in another call: tell the caller, like a phone does.
  rejectBusy() {
    log('call', `${this.callId} busy, rejecting call from ${this.partnerUid}`);
    this._reply(ANSWER_STATUS_BUSY);
  }

  _reply(status) {
    this.engine.sendSignal(SIG.ANSWER, {
      callerId: this.partnerNoisedId, callId: this.callId, status,
      codec: JSON.stringify([this.codecEntry]), extendData: '', rtcpAddress: '', rtpAddress: '', session: this.session,
    });
  }
}

// Caller side, as ZaloCall.exe does it: 401 requestcall (the server assigns
// the call id, session and relay list) → probe the relays and register on the
// best ones → 416 request → the callee rings (`ringring`) and answers naming
// the relay to use → 408 answerack, media. 405 cancels before the answer.
class OutgoingCall extends CallSession {
  // partner: makeCall's {id (noised), name, avatar}
  constructor({ engine, myUid, partner, isVideo }) {
    super({ engine, myUid });
    this.direction = 'out';
    this.partnerNoisedId = String(partner.id);
    this.partner = { name: partner.name || '', avatar: partner.avatar || '' };
    this.isVideo = !!isVideo;
    this._setCodec(VOICE_CODEC);
  }

  start() {
    log('call', `outgoing to ${this.partnerNoisedId} (${this.partner.name})`);
    this._setState('dialing');
    this._setBusy(true);
    // The caller picks the call id; the server echoes it as `id` (0 → error 114).
    this.callId = crypto.randomInt(100000000, 2 ** 31 - 1);
    this.engine.sendSignal(SIG.REQUEST_CALL, {
      calleeId: this.partnerNoisedId, callId: this.callId, codec: JSON.stringify([VOICE_CODEC]),
      type: this.isVideo ? CALL_TYPE.video : CALL_TYPE.voice,
    });
    this._expect(SIGNAL_TIMEOUT_MS, 'failed');
  }

  _expect(ms, reason) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      log('call', `${this.callId} timed out in state ${this.state}`);
      if (this.relay) this._cancel();
      this.end(reason, { silent: true });
    }, ms);
  }

  onSignal(command, data) {
    super.onSignal(command, data);
    if (command === SIG.REQUEST_CALL && this.state === 'dialing' && !this.relay) this._onRequestCallResponse(data || {});
  }

  async _onRequestCallResponse(r) {
    log('call', `requestcall response keys=${Object.keys(r).join(',')} servers=${JSON.stringify(r.servers)}`);
    const servers = parseServers(r);
    if (!r.id || !r.sessId || !servers.length) {
      log('call', `requestcall refused: status=${r.status} msg=${r.msg} servers=${JSON.stringify(r.servers)}`);
      this.end(Number(r.status) === 0 || r.status === undefined ? 'failed' : 'busy', { silent: true });
      return;
    }
    this.callId = Number(r.id);
    this._setSession(r.sessId);
    if (r.fromId) this.myUid = Number(r.fromId);
    this.partnerUid = Number(r.toId);
    log('call', `${this.callId} me=${this.myUid} partner=${this.partnerUid} servers ${servers.join(' ')}`);
    this._newPool(servers, true);
    try {
      await this.relay.open();
      await this.relay.probe();
    } catch (e) {
      log('call', `relay probe failed: ${e.message}`);
    }
    if (this.state !== 'dialing') return;
    const ranked = this.relay.relays.filter(x => x.probe.recv)
      .sort((a, b) => b.probe.recv - a.probe.recv || a.rtt - b.rtt);
    const chosen = (ranked.length ? ranked : this.relay.relays).slice(0, CALLER_RELAYS);
    this.relay.once('ready', () => setTimeout(() => this._request(), 300));
    this.relay.join(chosen);
  }

  _request() {
    if (this.state !== 'dialing') return;
    const live = this.relay.relays.filter(x => x.live);
    const best = live.sort((a, b) => (a.rtt || 1e9) - (b.rtt || 1e9))[0];
    log('call', `${this.callId} request via ${live.map(x => x.address).join(' ')}`);
    this.engine.sendSignal(SIG.REQUEST, {
      calleeId: this.partnerNoisedId,
      callId: this.callId,
      codec: JSON.stringify([VOICE_CODEC]),
      extendData: this._extendData(best),
      rtcpAddress: best.address,
      rtpAddress: best.address,
      session: this.session,
    });
    this._expect(ALERT_TIMEOUT_MS, 'no-answer');
  }

  onControl(c) {
    const d = c.data || {};
    const params = parseJson(d.params, {});
    log('call', `${this.callId} control act=${c.act} status=${d.status} params=${JSON.stringify(params).slice(0, 300)}`);
    if (this.state === 'ended' || this._onMediaControl(c)) return;
    if (c.act === 'ring_ring' || c.act === 'ringring') {
      if (this.state === 'dialing') this._setState('alerting');
    } else if (c.act === 'answer') {
      if (this.state === 'dialing' || this.state === 'alerting') this._onAnswer(d, params);
    } else if (REMOTE_END_ACTS.includes(c.act)) {
      const reason = this.state === 'active' ? 'remote-hangup' : (c.act === 'busy' ? 'busy' : 'declined-remote');
      this.end(reason, { silent: true });
    }
  }

  _onAnswer(d, params) {
    const status = Number(d.status !== undefined ? d.status : params.status);
    const address = params.rtpSerIp || params.rtpIP || d.rtpAddress || params.rtpAddress;
    if (status !== ANSWER_STATUS_ACCEPT || !address) {
      this.end(status === ANSWER_STATUS_BUSY ? 'busy' : 'declined-remote', { silent: true });
      return;
    }
    clearTimeout(this.timer);
    const codec = chooseCodec(d.codec) || chooseCodec(params.codec);
    if (codec) this._setCodec(codec);
    const ext = parseJson(params.extendData, {});
    this._setVideoCodec(ext);
    if (this.isVideo && ext.callType === 0) {
      log('call', `${this.callId} callee answered without video`);
      this.isVideo = false;
    }
    this.engine.sendSignal(SIG.ANSWER_ACK, { calleeId: this.partnerNoisedId, callId: this.callId });
    let relay = this.relay.relays.find(x => x.address === address);
    if (!relay) {
      // The callee picked a relay we did not register on: join it now.
      relay = this.relay.add(address);
      log('call', `${this.callId} callee chose unregistered relay ${address}`);
    }
    log('call', `${this.callId} answered via ${address} codec=${JSON.stringify(this.codecEntry)}`);
    if (relay.token) this._startMedia(relay);
    else this.relay.on('ready', r => { if (r === relay && this.state !== 'active' && this.state !== 'ended') this._startMedia(relay); });
  }

  _cancel() {
    this.engine.sendSignal(SIG.CANCEL, { toId: this.partnerNoisedId, callId: this.callId, callType: this.isVideo ? 1 : 0 });
  }

  hangup() {
    if (this.state === 'dialing' || this.state === 'alerting') {
      if (this.relay) this._cancel();
      this.end('local-hangup', { silent: true });
    } else {
      this.end('local-hangup');
    }
  }
}

module.exports = { IncomingCall, OutgoingCall, chooseCodec, describeCodec, parseServers };

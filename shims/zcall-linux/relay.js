'use strict';
// UDP sessions with Zalo relays ("ZRTP servers"), all on ONE local socket like
// the original engine. The caller registers on several relays and drops the
// ones it does not use (EndCall, which the relay forwards to us). The callee
// joins every candidate, probes their RTT for `serverResult`, notes where the
// caller's early media shows up, and names one relay in its answer; the caller
// follows that choice. Only then do we lock onto it and leave the others —
// leaving a relay is forwarded to the partner, who takes it as a rejection.
// Media goes out as [03][token][SRTP], comes back as [04][SRTP].
const dgram = require('dgram');
const { EventEmitter } = require('events');
const P = require('./packets');
const { log } = require('./log');

const INIT_INTERVAL_MS = 300;
const INIT_MAX_TRIES = 20;
const PROBE_COUNT = 10;
const PROBE_INTERVAL_MS = 30;
const PROBE_WINDOW_MS = 1000;
const ECHO_KEEPALIVE_MS = 2000;
const PING_KEEPALIVE_MS = 6000;
const STATUS_INTERVAL_MS = 1000;

function parseHostPort(s) {
  const i = s.lastIndexOf(':');
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
}

class Relay {
  constructor(address, index) {
    this.address = address;
    ({ host: this.host, port: this.port } = parseHostPort(address));
    this.index = index;
    this.token = null;     // set by the InitCall response
    this.dropped = false;  // partner left this relay
    this.probe = { sent: new Map(), recv: 0, rttSum: 0 };
    this.initTries = 0;
  }

  get rtt() { return this.probe.recv ? Math.round(this.probe.rttSum / this.probe.recv) : 0; }
  get live() { return !!this.token && !this.dropped; }
}

class RelayPool extends EventEmitter {
  // init: { isCaller, myUid, callId, partnerUid, session }
  constructor(addresses, init) {
    super();
    this.init = init;
    this.relays = [...new Set(addresses.filter(Boolean))].map((a, i) => new Relay(a, i));
    this.locked = null;
    this.mediaRelay = null; // first relay that carried the partner's media
    this.socket = null;
    this.timers = [];
    this.echoSeq = 0;
    this.statusSeq = 0;
  }

  _every(ms, fn) { this.timers.push(setInterval(fn, ms)); }

  _send(relay, packet) {
    if (this.socket) this.socket.send(packet, relay.port, relay.host);
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      this.socket.on('error', e => this.emit('error', e));
      this.socket.once('error', reject);
      this.socket.bind(0, () => {
        log('relay', `socket :${this.socket.address().port}, candidates ${this.relays.map(r => r.address).join(' ')}`);
        resolve();
      });
    });
  }

  // RTT probe of every candidate (anonymous echoes); resolves after the window.
  probe() {
    let n = 0;
    const tick = () => {
      for (const r of this.relays) {
        const id = (r.index << 16) | n;
        r.probe.sent.set(id, Date.now());
        this._send(r, P.buildEcho(id, String(Date.now() % 100000)));
      }
      if (++n >= PROBE_COUNT) clearInterval(timer);
    };
    const timer = setInterval(tick, PROBE_INTERVAL_MS);
    this.timers.push(timer);
    tick();
    return new Promise(resolve => setTimeout(resolve, PROBE_WINDOW_MS));
  }

  // `serverResult` entries for our extendData.
  results() {
    return this.relays.filter(r => r.probe.recv).map(r => ({
      bonus: 0, recv: r.probe.recv, rtcp: r.address, rtcpIPv6: '', rtp: r.address, rtpIPv6: '',
      rtt: r.rtt, spTcp: 0, tpType: 0,
    }));
  }

  // Add a candidate later (e.g. the relay a callee picked); joined if we are joining.
  add(address) {
    const r = new Relay(address, this.relays.length);
    this.relays.push(r);
    if (this.joining) this.joining.push(r);
    return r;
  }

  // InitCall on `relays` (default: every candidate); emits 'ready' (relay) per response.
  join(relays = this.relays) {
    this.joining = [...relays];
    const packet = P.buildInitCall(this.init);
    const send = () => {
      for (const r of this.joining) {
        if (r.token || r.initTries > INIT_MAX_TRIES) continue;
        if (++r.initTries > INIT_MAX_TRIES) {
          log('relay', `${r.address}: no InitCall response`);
          if (this.joining.every(x => !x.token && x.initTries > INIT_MAX_TRIES)) this.emit('error', new Error('no relay answered InitCall'));
          continue;
        }
        this._send(r, packet);
      }
    };
    log('relay', `InitCall ${this.init.isCaller ? 'caller' : 'callee'} -> ${this.joining.map(r => r.address).join(' ')}`);
    send();
    this._every(INIT_INTERVAL_MS, send);
    this._every(ECHO_KEEPALIVE_MS, () => this._targets().forEach(r => this._send(r, P.buildEcho(0x4e00 + (this.echoSeq++ & 0xff), String(Date.now() % 100000)))));
    this._every(STATUS_INTERVAL_MS, () => {
      const seq = ++this.statusSeq;
      this._targets().forEach(r => this._send(r, P.buildStatus({ myUid: this.init.myUid, token: r.token, seq })));
    });
    this._every(PING_KEEPALIVE_MS, () => this._targets().forEach(r => this._send(r, P.buildPing({ myUid: this.init.myUid, token: r.token, session: this.init.session }))));
  }

  _targets() {
    return this.locked ? [this.locked] : this.relays.filter(r => r.live);
  }

  // Use only `relay` from now on and leave the others.
  lock(relay) {
    if (this.locked) return;
    this.locked = relay;
    log('relay', `using ${relay.address}, leaving the others`);
    for (const r of this.relays) if (r !== relay && r.token) this._leave(r);
    this.emit('locked', relay);
  }

  _leave(relay) {
    log('relay', `EndCall -> ${relay.address}`);
    this._send(relay, P.buildEndCall({ myUid: this.init.myUid, token: relay.token, callId: this.init.callId }));
    relay.dropped = true;
  }

  _onMessage(msg, rinfo) {
    const r = this.relays.find(x => x.host === rinfo.address && x.port === rinfo.port);
    if (!r) return;
    const d = P.parseRelayDatagram(msg);
    switch (d.type) {
      case 'init':
        if (r.token) return;
        r.token = Buffer.from(d.token);
        log('relay', `${r.address} ready token=${r.token.toString('hex')} public=${d.publicAddress}`);
        this.emit('ready', r);
        break;
      case 'echo': {
        const sentAt = r.probe.sent.get(d.id);
        if (sentAt !== undefined) {
          r.probe.sent.delete(d.id);
          r.probe.recv++;
          r.probe.rttSum += Date.now() - sentAt;
        }
        break;
      }
      case 'rtp':
        if (r.dropped || (this.locked && r !== this.locked)) return;
        if (!this.mediaRelay) {
          this.mediaRelay = r;
          log('relay', `first media on ${r.address}`);
        }
        this.emit('rtp', d.data);
        break;
      case 'rtcp':
        if (r === this.locked) this.emit('rtcp', d.data);
        break;
      case 'video':
        if (r.dropped || (this.locked && r !== this.locked)) return;
        this.emit('video', d.data);
        break;
      case 'video-rtcp':
        if (!r.dropped && (!this.locked || r === this.locked)) this.emit('video-rtcp', d.data);
        break;
      case 'end':
        if (d.uid === this.init.partnerUid && !r.dropped) {
          r.dropped = true;
          log('relay', `${r.address}: partner left this relay`);
          if (r === this.locked || this.relays.every(x => !x.live)) this.emit('partner-left', r);
        }
        break;
      case 'signal':
        if (!this.loggedSignal) { log('relay', `partner signal via ${r.address}: ${d.data.subarray(18).toString('hex')}`); this.loggedSignal = true; }
        break;
      default:
        log('relay', `${r.address} other ${d.type} ${d.data.subarray(0, 40).toString('hex')}`);
    }
  }

  sendSrtp(srtp) {
    for (const r of this._targets()) this._send(r, P.wrapAudio(r.token, srtp));
  }

  sendRtcp(rtcp) {
    for (const r of this._targets()) this._send(r, P.wrapRtcp(r.token, rtcp));
  }

  sendVideoSrtp(srtp) {
    for (const r of this._targets()) this._send(r, P.wrapVideo(r.token, srtp));
  }

  sendVideoRtcp(rtcp) {
    for (const r of this._targets()) this._send(r, P.wrapVideoRtcp(r.token, rtcp));
  }

  close() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (!this.socket) return;
    for (const r of this.relays) if (r.live) this._leave(r);
    const s = this.socket;
    this.socket = null;
    // Let the EndCall datagrams leave before closing.
    setTimeout(() => { try { s.close(); } catch (e) { /* already closed */ } }, 200);
  }
}

module.exports = { RelayPool };

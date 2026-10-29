// End-to-end test of the Linux call engine without Zalo or the network:
// a fake Zalo (IPC sockets) delivers an incoming-call `control` offering two
// fake relays on localhost (A preferred). Like the real phone, the partner
// sends early media on relay B as soon as we join, then follows the relay
// named in our answer: it leaves the other one (EndCall forwarded as a
// 02/subcmd-3 response) and keeps replaying its real audio from re/call1.pcap
// (via re/work/call1-*.json) on the chosen one. Checks: probes, callee InitCall
// format, answer signal naming relay B, never leaving relay B, decode/playback
// in the call window, and that the engine's outgoing audio is valid SRTP.
//
// usage: ELECTRON_RUN_AS_NODE=1 runtime/electron/electron tests/engine-e2e.js
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const P = require(path.join(root, 'shims/zcall-linux/packets'));
const { SrtpContext } = require(path.join(root, 'shims/zcall-linux/srtp'));
const cap = require('./fixture');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcall-e2e-'));
const recvPath = path.join(tmp, 'recv'), sendPath = path.join(tmp, 'send');
const key = crypto.randomBytes(16);
const enc = t => { const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16)); return Buffer.concat([c.update(t), c.final()]).toString('hex'); };
const dec = h => { const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16)); return Buffer.concat([d.update(Buffer.from(h, 'hex')), d.final()]).toString(); };

const results = { nativeReady: false, ringring: false, initCall: null, answer: null, probes: 0, rxAudioOut: 0, rxAudioOnA: 0, rxTocs: new Set(), endCallOnB: false };
const relays = {}; // name → { sock, peer, token, onAnswer(chosen) }
const audio = cap.audio['1'].map(h => Buffer.concat([Buffer.from([0x04]), Buffer.from(h, 'hex')]));
const EARLY = 15;
// Early media like the phone's: plain RTP, pt 113, seq far ahead of the SRTP
// stream that follows the answer (which the player must resync to).
const earlyAudio = cap.audio['1'].slice(0, EARLY).map(h => {
  const rtp = Buffer.from(SrtpContext.fromSession(cap.session).unprotect(Buffer.from(h, 'hex')));
  rtp[1] = (rtp[1] & 0x80) | 113;
  rtp.writeUInt16BE((rtp.readUInt16BE(2) + 20000) & 0xffff, 2);
  return Buffer.concat([Buffer.from([0x04]), rtp]);
});
let toEngine = null;
const srtp = SrtpContext.fromSession(cap.session);

// ---- fake relays ----------------------------------------------------------
function fakeRelay(name, token) {
  const sock = dgram.createSocket('udp4');
  const relay = relays[name] = { sock, peer: null, token };
  const toPeer = b => relay.peer && sock.send(b, relay.peer.port, relay.peer.address);
  relay.onAnswer = chosen => {
    if (chosen !== name) {
      // Partner's EndCall as the relay forwards it: 02 01 | 0 | 0 | partnerUid | 0 | 03 00 | 00 | i32 0
      const end = Buffer.alloc(25); end[0] = 0x02; end[1] = 0x01; end.writeUInt32LE(cap.partnerUid, 10); end.writeUInt16LE(3, 18);
      setTimeout(() => toPeer(end), 100);
    } else {
      // A few more early packets still in flight after the answer, then the SRTP stream.
      earlyAudio.slice(-3).forEach((b, i) => setTimeout(() => toPeer(b), 20 * i));
      audio.slice(EARLY).forEach((b, i) => setTimeout(() => toPeer(b), 100 + 20 * i));
    }
  };
  sock.on('message', (msg, rinfo) => {
    const reply = b => sock.send(b, rinfo.port, rinfo.address);
    if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x05) { results.probes++; reply(msg); return; }
    if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x0c && !relay.peer) {
      relay.peer = rinfo;
      results.initCall = results.initCall || { subcmd: msg.readUInt16LE(18), myUid: msg.readUInt32LE(10), callId: msg.readUInt32LE(21), partnerUid: msg.readUInt32LE(25), session: msg.subarray(31).toString() };
      // Response: same header with kind 02, then u32 0, callId, token, "ip|port".
      const addr = Buffer.from(`127.0.0.1|${rinfo.port}`);
      const resp = Buffer.alloc(35 + addr.length);
      msg.copy(resp, 0, 0, 21); resp[0] = 0x02;
      resp.writeUInt32LE(cap.callId, 25); token.copy(resp, 29); resp.writeUInt16LE(addr.length, 33); addr.copy(resp, 35);
      reply(resp);
      // Early media right after we join, on B only.
      if (name === 'B') earlyAudio.forEach((b, i) => setTimeout(() => reply(b), 10 + 20 * i));
      return;
    }
    if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x03 && name === 'B') results.endCallOnB = true;
    if (msg[0] === 0x03 && msg.subarray(1, 5).equals(token)) {
      if (name === 'A') { results.rxAudioOnA++; return; }
      const plain = srtp.unprotect(msg.subarray(5));
      if (plain) { const r = P.parseRtp(plain); results.rxAudioOut++; results.rxTocs.add(r.payload[0]); if ((r.payload[0] & 3) === 3) (results.frames = results.frames || new Set()).add(r.payload[1] & 0x3f); results.txSsrcOk = r.ssrc === cap.myUid; results.txPt = r.pt; }
    }
  });
  return sock;
}
const relayA = fakeRelay('A', Buffer.from('c0ffee0a', 'hex'));
const relayB = fakeRelay('B', Buffer.from('c0ffee0b', 'hex'));

// ---- fake Zalo ------------------------------------------------------------
function control(act) {
  const a = `127.0.0.1:${relayA.address().port}`, b = `127.0.0.1:${relayB.address().port}`;
  const ext = { callType: 0, serverAddr: [{ rtp: a, rtcp: a }], serverResult: [{ rtp: a, rtt: 80, recv: 14 }, { rtp: b, rtt: 84, recv: 12 }] };
  const params = { Dname: 'E2E Partner', avatar: '', sessId: cap.session, codec: '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]', extendData: JSON.stringify(ext), video: { enable: 1 } };
  return { type: 'control', data: { act_type: 'voip', act, data: {
    uidFrom: String(cap.partnerUid), uidN: '1477000000000000001', uidTo: String(cap.myUid), callId: String(cap.callId), status: '0', ts: String(Date.now()),
    codec: '[{"frmPtime":20,"payload":112,"name":"opus\\/16000\\/1","dynamicFptime":0}]',
    session: cap.session, rtpAddress: a, rtcpAddress: a,
    params: JSON.stringify(params),
  } } };
}

net.createServer(sock => {
  let buf = '';
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('$')) >= 0) {
      const msg = JSON.parse(dec(buf.slice(0, i))); buf = buf.slice(i + 1);
      if (msg.command === 'native-ready') { results.nativeReady = true; setTimeout(() => toEngine.write(enc(JSON.stringify(control('request'))) + '$'), 300); }
      if (msg.type === 'sendSignal' && msg.command === 407) results.ringring = msg.data.callerId === '1477000000000000001';
      if (msg.type === 'sendSignal' && msg.command === 402 && msg.data.callId !== cap.callId) results.busyReply = msg.data;
      if (msg.type === 'sendSignal' && msg.command === 406) results.logEnd = msg.data;
      if (msg.type === 'sendSignal' && msg.command === 402 && msg.data.callId === cap.callId) {
        results.answer = msg.data;
        // Another call arrives during this one: the engine must answer it "busy".
        setTimeout(() => {
          const other = control('request');
          other.data.data.callId = String(cap.callId + 7);
          toEngine.write(enc(JSON.stringify(other)) + '$');
        }, 1500);
        const port = Number(msg.data.rtpAddress.split(':')[1]);
        const chosen = port === relayA.address().port ? 'A' : 'B';
        Object.values(relays).forEach(r => r.onAnswer(chosen));
      }
    }
  });
}).listen(recvPath);
net.createServer(sock => { toEngine = sock; sock.on('data', () => {}); }).listen(sendPath);

relayA.bind(0, '127.0.0.1', () => relayB.bind(0, '127.0.0.1', () => {
  const env = { ...process.env, ZCALL_IPC_KEY: key.toString('base64'), ZCALL_AUTOACCEPT_MS: '500', XDG_CONFIG_HOME: tmp };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(path.join(tmp, 'ZaloData'));
  const engine = spawn(process.execPath, ['--no-sandbox', path.join(root, 'app/native/zcall-linux'), recvPath, sendPath], { env, stdio: 'ignore' });
  setTimeout(() => {
    engine.kill('SIGKILL');
    const log = fs.readFileSync(path.join(tmp, 'ZaloData/zcall-linux.log'), 'utf8');
    const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
    check('engine announced native-ready', results.nativeReady);
    check('ringring (407) sent', results.ringring);
    const ic = results.initCall;
    check('callee InitCall', ic && ic.subcmd === 0x0c && ic.myUid === cap.myUid && ic.partnerUid === cap.partnerUid && ic.callId === cap.callId && ic.session === cap.session);
    const a = results.answer;
    check('relays probed', results.probes >= 10, `(${results.probes} echoes)`);
    check('answer (402) signal', a && a.callerId === '1477000000000000001' && a.status === 0 && a.session === cap.session && /opus\/16000\/1/.test(a.codec), a ? JSON.stringify({ ...a, session: '…', extendData: '…' }) : '');
    const ext = a ? JSON.parse(a.extendData) : {};
    check('answer carries serverResult for both relays', (ext.serverResult || []).length === 2, JSON.stringify(ext.serverResult));
    check('answer names relay B (early media)', a && a.rtpAddress === `127.0.0.1:${relayB.address().port}`);
    check('left relay A after answering', log.includes(`EndCall -> 127.0.0.1:${relayA.address().port}`));
    check('never left relay B', /using 127\.0\.0\.1:\d+, leaving/.test(log) && !results.endCallOnB);
    check('incoming SRTP audio decrypted', /media rx \{"srtp":[1-9]/.test(log));
    check('no decoder errors in window', !/decoder error/.test(log));
    const players = [...log.matchAll(/ui player (\{.*\})/g)].map(m => JSON.parse(m[1]));
    const decoded = players.reduce((n, p) => n + p.decoded, 0);
    check('playback kept going after the stream restart', decoded > audio.length - EARLY - 10, `(${decoded} frames decoded, ${JSON.stringify(players)})`);
    check('rx stats logged', /media rx \{"srtp":\d+,"plain":\d+/.test(log), (log.match(/media rx .*/g) || []).pop());
    check('engine sent audio', results.rxAudioOut > 0, `(${results.rxAudioOut} packets, pt ${results.txPt}, ssrc ok ${results.txSsrcOk}, TOCs ${[...results.rxTocs].map(x => x.toString(16)).join(',')}, frames/packet ${[...(results.frames || [1])].join(',')})`);
    check('logendcall (406) not sent before the end', !results.logEnd);
    check('second incoming call answered busy', results.busyReply && results.busyReply.status === 1 && results.busyReply.callId === cap.callId + 7, JSON.stringify(results.busyReply && { ...results.busyReply, session: '…' }));
    check('no audio to abandoned relay A after the switch', results.rxAudioOnA < 10, `(${results.rxAudioOnA} before switch)`);
    const uiErrors = log.split('\n').filter(l => / ui /.test(l));
    if (uiErrors.length) console.log('ui log:\n  ' + uiErrors.join('\n  '));
    process.exit(0);
  }, 10000);
}));

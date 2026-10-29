// End-to-end test of outgoing calls without Zalo or the network. A fake Zalo
// (IPC sockets) asks for a call (`makeCall`), answers our 401 with a call id,
// session and three relays (C never answers), then plays the callee: `ringring`,
// an `answer` naming relay B, the partner's real audio from re/call1.pcap on B,
// and `end_call`. A second call is cancelled while ringing (Zalo's `endCall`).
// Checks: 401/416/408/405 payloads, caller InitCall format, relay choice,
// decode/playback in the call window, and that our audio is valid SRTP on B.
//
// usage: ELECTRON_RUN_AS_NODE=1 runtime/electron/electron tests/outgoing-e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcall-out-'));
const recvPath = path.join(tmp, 'recv'), sendPath = path.join(tmp, 'send');
const key = crypto.randomBytes(16);
const enc = t => { const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16)); return Buffer.concat([c.update(t), c.final()]).toString('hex'); };
const dec = h => { const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16)); return Buffer.concat([d.update(Buffer.from(h, 'hex')), d.final()]).toString(); };

const CALLEE = '1477000000000000001';
const callIds = []; // picked by the engine, from its 401s
const srtp = SrtpContext.fromSession(cap.session);
const audio = cap.audio['1'].map(h => Buffer.concat([Buffer.from([0x04]), Buffer.from(h, 'hex')]));
const signals = {}; // command → [data]
const results = { initCalls: {}, probes: 0, rxAudio: 0, rxAudioOnA: 0, endCallOnA: false, frames: new Set() };
let toEngine = null;
const send = msg => toEngine.write(enc(JSON.stringify(msg)) + '$');
const control = (act, callId, extra = {}) => send({ type: 'control', data: { act_type: 'voip', act, data: {
  uidFrom: String(cap.partnerUid), uidN: CALLEE, callId: String(callId), status: '0', ts: String(Date.now()), codec: '', params: '{}', ...extra,
} } });

// ---- fake relays ----------------------------------------------------------
function fakeRelay(name, token) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const reply = b => sock.send(b, rinfo.port, rinfo.address);
    if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x05) { results.probes++; reply(msg); return; }
    if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x0b) {
      if (!results.initCalls[name]) {
        results.initCalls[name] = { myUid: msg.readUInt32LE(10), callId: msg.readUInt32LE(21), partnerUid: msg.readUInt32LE(25), session: msg.subarray(31).toString() };
        sock.peer = rinfo;
      }
      const addr = Buffer.from(`127.0.0.1|${rinfo.port}`);
      const resp = Buffer.alloc(35 + addr.length);
      msg.copy(resp, 0, 0, 21); resp[0] = 0x02;
      resp.writeUInt32LE(msg.readUInt32LE(21), 25); token.copy(resp, 29); resp.writeUInt16LE(addr.length, 33); addr.copy(resp, 35);
      reply(resp);
      return;
    }
    if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x03 && name === 'A') results.endCallOnA = true;
    if (msg[0] === 0x03 && msg.subarray(1, 5).equals(token)) {
      if (name === 'A') { results.rxAudioOnA++; return; }
      const plain = srtp.unprotect(msg.subarray(5));
      if (plain) {
        const r = P.parseRtp(plain);
        results.rxAudio++; results.txSsrcOk = r.ssrc === cap.myUid; results.txPt = r.pt;
        results.frames.add((r.payload[0] & 3) === 3 ? r.payload[1] & 0x3f : 1);
      }
    }
  });
  sock.replay = () => audio.forEach((b, i) => setTimeout(() => sock.send(b, sock.peer.port, sock.peer.address), 20 * i));
  return sock;
}
const relayA = fakeRelay('A', Buffer.from('c0ffee0a', 'hex'));
const relayB = fakeRelay('B', Buffer.from('c0ffee0b', 'hex'));
const deadC = dgram.createSocket('udp4'); // bound, never answers
const addr = s => `127.0.0.1:${s.address().port}`;

// ---- fake Zalo ------------------------------------------------------------
function onSignal(cmd, data) {
  (signals[cmd] = signals[cmd] || []).push(data);
  const n = signals[cmd].length;
  if (cmd === 401) {
    // Shape of a real 401 response: id = the caller's call id, servers as objects, rtpIP first.
    callIds.push(data.callId);
    const server = s => ({ rtcpaddr: addr(s), rtpaddr: addr(s), rtpIPv6: '', rtcpIPv6: '', bonus: 0, spTcp: 1 });
    setTimeout(() => send({ type: 'recvSignal', command: 401, data: {
      fromId: cap.myUid, toId: cap.partnerUid, id: data.callId, protocol: 3, status: 0, msg: '', sessId: cap.session,
      rtpIP: addr(deadC), rtcpIP: addr(deadC), servers: [server(deadC), server(relayA), server(relayB)], zrtc_config: {},
    } }), 100);
  } else if (cmd === 416 && n === 1) {
    send({ type: 'recvSignal', command: 416, data: {} });
    setTimeout(() => control('ring_ring', callIds[0]), 200);
    setTimeout(() => control('answer', callIds[0], {
      status: '0', codec: '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]',
      params: JSON.stringify({ rtpSerIp: addr(relayB), rtpIP: addr(relayB), status: 0, extendData: '' }),
    }), 1200);
  } else if (cmd === 408) {
    setTimeout(() => relayB.replay(), 100);
    setTimeout(() => control('end_call', callIds[0]), 6500);
  } else if (cmd === 416 && n === 2) {
    setTimeout(() => control('ring_ring', callIds[1]), 200);
    setTimeout(() => send({ type: 'request', command: 'endCall', data: null }), 800);
    // Third call: the callee is busy (answers status 1 at once).
    setTimeout(() => send({ type: 'request', command: 'makeCall', data: { partner: [{ id: CALLEE, name: 'E2E Callee', avatar: '' }], type: 1 } }), 2500);
  } else if (cmd === 416 && n === 3) {
    setTimeout(() => control('answer', callIds[2], {
      status: '1', codec: '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]',
      params: JSON.stringify({ rtpSerIp: addr(relayB), rtpIP: addr(relayB) }),
    }), 150);
  }
}

net.createServer(sock => {
  let buf = '';
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('$')) >= 0) {
      const msg = JSON.parse(dec(buf.slice(0, i))); buf = buf.slice(i + 1);
      if (msg.command === 'native-ready') {
        setTimeout(() => {
          send({ type: 'update', command: 'init', data: { local: { id: String(cap.myUid), name: 'Me' } } });
          send({ type: 'request', command: 'makeCall', data: { partner: [{ id: CALLEE, name: 'E2E Callee', avatar: '' }], type: 1 } });
        }, 300);
      }
      if (msg.type === 'sendSignal') onSignal(msg.command, msg.data);
      if (msg.type === 'update' && msg.command === 'callState') (results.callStates = results.callStates || []).push(msg.data.state);
    }
  });
}).listen(recvPath);
net.createServer(sock => { toEngine = sock; sock.on('data', () => {}); }).listen(sendPath);

let bound = 0;
for (const s of [relayA, relayB, deadC]) s.bind(0, '127.0.0.1', () => { if (++bound === 3) run(); });

function run() {
  const env = { ...process.env, ZCALL_IPC_KEY: key.toString('base64'), XDG_CONFIG_HOME: tmp };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(path.join(tmp, 'ZaloData'));
  const engine = spawn(process.execPath, ['--no-sandbox', path.join(root, 'app/native/zcall-linux'), recvPath, sendPath], { env, stdio: 'ignore' });
  // Second call once the first one is over.
  setTimeout(() => send({ type: 'request', command: 'makeCall', data: { partner: [{ id: CALLEE, name: 'E2E Callee', avatar: '' }], type: 1 } }), 12000);
  setTimeout(() => {
    engine.kill('SIGKILL');
    const log = fs.readFileSync(path.join(tmp, 'ZaloData/zcall-linux.log'), 'utf8');
    const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
    const s401 = (signals[401] || [])[0];
    check('requestcall (401)', s401 && s401.calleeId === CALLEE && s401.callId > 0 && /opus\/16000\/1/.test(s401.codec) && s401.type === 1, JSON.stringify(s401));
    check('relays probed', results.probes >= 20, `(${results.probes} echoes)`);
    const ia = results.initCalls.A, ib = results.initCalls.B;
    check('caller InitCall on A and B', ia && ib && [ia, ib].every(x => x.myUid === cap.myUid && x.partnerUid === cap.partnerUid && x.callId === callIds[0] && x.session === cap.session));
    const s416 = (signals[416] || [])[0];
    const ext = s416 ? JSON.parse(s416.extendData) : {};
    check('request (416)', s416 && s416.calleeId === CALLEE && s416.callId === callIds[0] && s416.session === cap.session
      && [addr(relayA), addr(relayB)].includes(s416.rtpAddress) && ext.serverAddr.length === 2 && !ext.serverAddr.some(x => x.rtp === addr(deadC)),
    s416 ? JSON.stringify({ ...s416, session: '…', extendData: ext.serverAddr.map(x => x.rtp) }) : '');
    check('callee ringing shown', /state=alerting/.test(log));
    const s408 = (signals[408] || [])[0];
    check('answerack (408)', s408 && s408.calleeId === CALLEE && s408.callId === callIds[0], JSON.stringify(s408));
    check('left relay A after the answer', results.endCallOnA);
    check('incoming audio played', /ui player \{"in":[1-9]/.test(log), (log.match(/ui player .*/g) || []).join(' | '));
    check('no decoder errors in window', !/decoder error/.test(log));
    check('sent SRTP audio on B only', results.rxAudio > 50 && results.txSsrcOk && results.txPt === 112 && results.rxAudioOnA === 0,
      `(${results.rxAudio} packets on B, ${results.rxAudioOnA} on A, frames/packet ${[...results.frames]})`);
    check('remote end_call ends without 409', /state=ended \{"reason":"remote-hangup"/.test(log) && !(signals[409] || []).length);
    const s405 = (signals[405] || [])[0];
    check('second call cancelled while ringing (405)', s405 && s405.toId === CALLEE && s405.callId === callIds[1] && callIds[1] !== callIds[0], JSON.stringify(s405));
    check('busy callee ends the third call', new RegExp(`${callIds[2]} state=ended \\{"reason":"busy"`).test(log) && (signals[408] || []).length === 1);
    const logs = (signals[406] || []).map(x => [x.callId === callIds[0] ? 1 : x.callId === callIds[1] ? 2 : 3, x.status, x.role, x.partnerId === CALLEE, JSON.parse(x.data).duration === x.duration]);
    check('logendcall (406) for all three calls', JSON.stringify(logs) === JSON.stringify([[1, 50, true, true, true], [2, 0x67, true, true, true], [3, 0x69, true, true, true]]), JSON.stringify(logs));
    check('callState calling/free reported', JSON.stringify(results.callStates) === '["calling","free","calling","free","calling","free"]', JSON.stringify(results.callStates));
    process.exit(0);
  }, 19000);
}

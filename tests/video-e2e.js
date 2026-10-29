// End-to-end test of video calls without Zalo, a camera or the network. The
// engine runs with Chromium's fake camera/microphone. A fake Zalo delivers an
// incoming *video* call; one fake relay checks the engine's H.264 stream
// (SRTP, RTP pt 97 without extension, Zalo mode-3 fragments, SPS/PPS/IDR in
// keyframes) and loops it back as
// the partner's video (new SSRC, re-encrypted) so the call window has to
// decode and draw it; it also sends a PLI and expects an extra keyframe.
// Midway the window shares a stand-in screen (ZCALL_TEST_SCREEN_MS) on the
// same stream and stops again: 12064 on/off, new SPS, back to the camera.
//
// usage: ELECTRON_RUN_AS_NODE=1 runtime/electron/electron tests/video-e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcall-video-'));
const recvPath = path.join(tmp, 'recv'), sendPath = path.join(tmp, 'send');
const key = crypto.randomBytes(16);
const enc = t => { const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16)); return Buffer.concat([c.update(t), c.final()]).toString('hex'); };
const dec = h => { const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16)); return Buffer.concat([d.update(Buffer.from(h, 'hex')), d.final()]).toString(); };

const PARTNER_VIDEO_SSRC = (cap.partnerUid + 1) >>> 0; // the engine should mirror this offset
const rxSrtp = SrtpContext.fromSession(cap.session);
const txSrtp = SrtpContext.fromSession(cap.session);
const token = Buffer.from('c0ffee0a', 'hex');
const r = { answer: null, packets: 0, frames: 0, keyframes: [], badNals: 0, maxPayload: 0, ssrcs: new Set(), pts: new Set(), plied: false, keysAfterPli: 0, withExt: 0 };
const depack = new P.H264Depacketizer();
const camMic = [];
const share = [];
const spsSeen = new Set();
let toEngine = null;
let peer = null;

const relay = dgram.createSocket('udp4');
relay.on('message', (msg, rinfo) => {
  const reply = b => relay.send(b, rinfo.port, rinfo.address);
  if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x05) { reply(msg); return; }
  if (msg[0] === 0x01 && msg.readUInt16LE(18) === 0x0c && !peer) {
    peer = rinfo;
    const addr = Buffer.from(`127.0.0.1|${rinfo.port}`);
    const resp = Buffer.alloc(35 + addr.length);
    msg.copy(resp, 0, 0, 21); resp[0] = 0x02;
    resp.writeUInt32LE(cap.callId, 25); token.copy(resp, 29); resp.writeUInt16LE(addr.length, 33); addr.copy(resp, 35);
    reply(resp);
    return;
  }
  if (msg[0] === 0x0f && msg.subarray(1, 5).equals(token)) {
    const b = msg.subarray(5);
    if (b[1] === 200) r.sr = { rc: b[0] & 0x1f, remb: b.includes(Buffer.from('REMB')) };
    return;
  }
  if (msg[0] === 0x0d && msg.subarray(1, 5).equals(token)) {
    const plain = rxSrtp.unprotect(msg.subarray(5));
    if (!plain) return;
    const rtp = P.parseRtp(plain);
    r.packets++; r.ssrcs.add(rtp.ssrc); r.pts.add(rtp.pt);
    if (r.lastTs !== undefined) { const d = (rtp.ts - r.lastTs) | 0; if (d < 0 || d > 90000) r.tsJumps = (r.tsJumps || 0) + 1; }
    r.lastTs = rtp.ts;
    if (plain[0] & 0x10) r.withExt++;
    r.maxPayload = Math.max(r.maxPayload, rtp.payload.length);
    const raw = rtp.payload[0] === 0 && rtp.payload[1] === 0;
    if (!raw && (rtp.payload[0] !== 0x1c || (rtp.payload[1] & 0x1f) !== 0)) r.badNals++;
    (r.framePts = r.framePts || new Set()).add(rtp.pt);
    const au = depack.push(rtp);
    if (rtp.marker) {
      if (au) r.keyPtOk = (r.keyPtOk !== false) && (au.key ? !r.framePts.has(97) : !r.framePts.has(98));
      r.framePts = new Set();
    }
    if (au) {
      r.frames++;
      if (au.key) { r.keyframes.push(au.nals.join(',')); if (r.plied) r.keysAfterPli++; }
      for (const nal of P.splitAnnexB(au.data)) if ((nal[0] & 0x1f) === 7) spsSeen.add(nal.toString('hex'));
    }
    // Loop it back as the partner's video.
    const back = Buffer.from(plain);
    back.writeUInt32BE(PARTNER_VIDEO_SSRC, 8);
    reply(Buffer.concat([Buffer.from([0x0e]), txSrtp.protect(back)]));
    // After a while ask for a keyframe like a receiver that lost packets.
    if (r.frames === 20 && !r.plied) {
      r.plied = true;
      reply(Buffer.concat([Buffer.from([0x0f, 0, 0, 0, 0]), P.buildPli(PARTNER_VIDEO_SSRC, rtp.ssrc)]));
    }
  }
});

function control() {
  const a = `127.0.0.1:${relay.address().port}`;
  const ext = { callType: 1, serverAddr: [{ rtp: a, rtcp: a }], video: { codec: [{ name: 'h264', payload: 97 }] } };
  const params = { Dname: 'E2E Video', avatar: '', sessId: cap.session, extendData: JSON.stringify(ext), video: { enable: 1 },
    codec: '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]' };
  return { type: 'control', data: { act_type: 'voip', act: 'request', data: {
    uidFrom: String(cap.partnerUid), uidN: '1477000000000000001', uidTo: String(cap.myUid), callId: String(cap.callId), status: '0',
    ts: String(Date.now()), codec: '[{"frmPtime":20,"payload":112,"name":"opus\\/16000\\/1","dynamicFptime":0}]',
    session: cap.session, rtpAddress: a, rtcpAddress: a, params: JSON.stringify(params),
  } } };
}

net.createServer(sock => {
  let buf = '';
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('$')) >= 0) {
      const msg = JSON.parse(dec(buf.slice(0, i))); buf = buf.slice(i + 1);
      if (msg.command === 'native-ready') setTimeout(() => toEngine.write(enc(JSON.stringify(control())) + '$'), 300);
      if (msg.type === 'sendSignal' && msg.command === 402) r.answer = msg.data;
      if (msg.type === 'sendSignal' && msg.command === 12006) camMic.push(msg.data);
      if (msg.type === 'sendSignal' && msg.command === 12064) share.push(msg.data);
    }
  });
}).listen(recvPath);
net.createServer(sock => { toEngine = sock; sock.on('data', () => {}); }).listen(sendPath);

relay.bind(0, '127.0.0.1', () => {
  const env = { ...process.env, ZCALL_IPC_KEY: key.toString('base64'), ZCALL_AUTOACCEPT_MS: '300', ZCALL_TEST_SCREEN_MS: '3000', XDG_CONFIG_HOME: tmp };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(path.join(tmp, 'ZaloData'));
  const engine = spawn(process.execPath, ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    path.join(root, 'app/native/zcall-linux'), recvPath, sendPath], { env, stdio: 'ignore' });
  setTimeout(() => {
    engine.kill('SIGKILL');
    const log = fs.readFileSync(path.join(tmp, 'ZaloData/zcall-linux.log'), 'utf8');
    const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
    const ext = r.answer ? JSON.parse(r.answer.extendData) : {};
    check('answer offers video', ext.callType === 1 && JSON.stringify(ext.video) === '{"codec":[{"name":"h264","payload":97}]}', JSON.stringify(ext.video));
    check('camera + encoder started', /ui camera /.test(log) && /ui video encoder \d+ x \d+/.test(log), (log.match(/ui video encoder .*/) || [''])[0]);
    check('video sent as SRTP pt 97 (delta) / 98 (key), no RTP extension', r.packets > 50 && r.pts.size === 2 && r.pts.has(97) && r.pts.has(98) && r.keyPtOk && r.withExt === 0, `(${r.packets} packets, ${r.frames} frames)`);
    check('every keyframe is one SPS + PPS + IDR', r.keyframes.length && r.keyframes.every(k => /^7,8,5$/.test(k)), JSON.stringify(r.keyframes));
    check('RTP timestamps continuous across source switches', !r.tsJumps, `(${r.tsJumps || 0} jumps)`);
    check('video RTCP: SR with report block + REMB', r.sr && r.sr.rc === 1 && r.sr.remb, JSON.stringify(r.sr));
    check('only Zalo mode-3 packets (raw or fragments), within MTU', r.badNals === 0 && r.maxPayload <= 1102, `(max payload ${r.maxPayload})`);
    check('camera/mic state sent (12006)', camMic.length && camMic[0].isOnCam === 1 && camMic[0].isOnMic === 1 && camMic[0].calleeId === '1477000000000000001', JSON.stringify(camMic));
    check('our video SSRC mirrors the partner offset', r.ssrcs.has((cap.myUid + 1) >>> 0), JSON.stringify([...r.ssrcs]));
    check('PLI answered with a keyframe', r.keysAfterPli >= 1, `(${r.keysAfterPli} keyframes after PLI)`);
    check('engine saw partner video', /video first rx srtp=true pt=9[78]/.test(log) && /video first keyframe nals=7,8,5/.test(log));
    check('window decoded and drew it', /ui video size \d+ x \d+/.test(log) && /ui video player \{"in":\d+,"decoded":[1-9]/.test(log),
      (log.match(/ui video (size|player) .*/g) || []).join(' | '));
    check('screen share signalled on/off (12064)', share.length === 2 && share[0].status === 1 && share[1].status === 0
      && share[0].uidTo === '1477000000000000001' && share[0].callId === cap.callId, JSON.stringify(share));
    const encoders = (log.match(/ui video encoder \d+ x \d+/g) || []).map(l => l.replace('ui video encoder ', ''));
    check('encoder switched to the screen and back', encoders.join('|') === '640 x 480|1280 x 718|640 x 480', JSON.stringify(encoders));
    check('screen keyframes carry their own SPS', spsSeen.size >= 2, `(${spsSeen.size} distinct SPS)`);
    check('window decoded the shared screen', /ui video size 1280 x 718/.test(log));
    const errors = log.split('\n').filter(l => /video decoder error|video decode |video encoder error|camera error/.test(l));
    check('no video errors', !errors.length, errors.slice(0, 3).join(' | '));
    process.exit(0);
  }, 10000);
});

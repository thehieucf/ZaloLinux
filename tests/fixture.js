// Synthetic stand-in for a captured call, so the tests need no private
// capture: ids, a session string shaped like the server's (base64url, 154
// chars; its first 30 bytes are the SRTP master key) and the partner's audio
// as SRTP packets like a phone's: 40 × 20 ms Opus at 16 kHz, pt 112, with the
// one-word header extension.
const crypto = require('crypto');
const P = require('../shims/zcall-linux/packets');
const { SrtpContext } = require('../shims/zcall-linux/srtp');

const session = crypto.randomBytes(116).toString('base64url').slice(0, 154);
const myUid = 288000001;
const partnerUid = 312000002;
const callId = 105000003;
const OPUS_SILENCE = Buffer.from('f8fffe', 'hex'); // one 20 ms CELT frame

const srtp = SrtpContext.fromSession(session);
const packets = Array.from({ length: 40 }, (_, i) => srtp.protect(P.buildRtp({
  marker: i === 0, pt: 112, seq: 1000 + i, ts: 160000 + i * 320, ssrc: partnerUid, twcc: i + 1, payload: OPUS_SILENCE,
})).toString('hex'));

module.exports = { session, myUid, partnerUid, callId, audio: { 1: packets } };

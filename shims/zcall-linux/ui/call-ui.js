'use strict';
// Call window: UI state + audio. Incoming Opus frames are decoded with
// WebCodecs and scheduled on Web Audio; the microphone (Chromium AEC/NS/AGC)
// is encoded to Opus and handed to the main process for RTP/SRTP.
const $ = id => document.getElementById(id);
const log = (...a) => window.zcall.log(a.join(' '));

const REASONS = {
  'local-hangup': 'Cuộc gọi đã kết thúc', 'remote-hangup': 'Người kia đã cúp máy',
  'answered-elsewhere': 'Đã trả lời trên thiết bị khác', cancelled: 'Cuộc gọi nhỡ',
  declined: 'Đã từ chối', network: 'Không kết nối được', 'no-media': 'Mất kết nối',
  unsupported: 'Cuộc gọi không được hỗ trợ', 'declined-remote': 'Người nhận đã từ chối',
  'no-answer': 'Không có người trả lời', busy: 'Người nhận đang bận', failed: 'Không thực hiện được cuộc gọi',
};

// ---- playback -------------------------------------------------------------

class Player {
  constructor(codec) {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.clock = codec.clock;
    this.channels = codec.channels;
    this.next = 0;
    this.lastSeq = null;
    this.lastPt = null;
    this.stale = 0;
    this.stats = { in: 0, dropped: 0, decoded: 0, peak: 0 };
    this.statsTimer = setInterval(() => {
      log('player', JSON.stringify(this.stats));
      this.stats.peak = 0;
    }, 5000);
    this.decoder = new AudioDecoder({ output: d => this.play(d), error: e => log('decoder error', e.message) });
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: this.channels });
  }

  push(frame) {
    this.stats.in++;
    // The caller restarts its stream (new seq, new payload type) when the
    // answer switches it from early media to the negotiated codec: resync.
    if (frame.pt !== this.lastPt) { this.lastPt = frame.pt; this.lastSeq = null; }
    if (this.lastSeq !== null) {
      const delta = (frame.seq - this.lastSeq) & 0xffff;
      if (delta === 0 || delta > 0x8000) { // duplicate or late
        this.stats.dropped++;
        if (++this.stale < 10) return;
      }
    }
    this.stale = 0;
    this.lastSeq = frame.seq;
    this.decoder.decode(new EncodedAudioChunk({
      type: 'key', timestamp: Math.round(frame.ts * 1e6 / this.clock), data: frame.payload,
    }));
  }

  play(ad) {
    const n = ad.numberOfFrames;
    const mono = new Float32Array(n);
    if (ad.format === 'f32-planar') {
      ad.copyTo(mono, { planeIndex: 0 });
    } else if (ad.format === 'f32') {
      const all = new Float32Array(n * ad.numberOfChannels);
      ad.copyTo(all, { planeIndex: 0 });
      for (let i = 0; i < n; i++) mono[i] = all[i * ad.numberOfChannels];
    } else { // s16 / s16-planar
      const all = new Int16Array(n * (ad.format === 's16' ? ad.numberOfChannels : 1));
      ad.copyTo(all, { planeIndex: 0 });
      const step = ad.format === 's16' ? ad.numberOfChannels : 1;
      for (let i = 0; i < n; i++) mono[i] = all[i * step] / 32768;
    }
    this.stats.decoded++;
    for (let i = 0; i < n; i += 16) this.stats.peak = Math.max(this.stats.peak, Math.abs(mono[i]));
    const buf = this.ctx.createBuffer(1, n, ad.sampleRate);
    buf.copyToChannel(mono, 0);
    ad.close();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    // ~80 ms jitter buffer; resync after underrun or excessive drift.
    if (this.next < now + 0.02 || this.next > now + 0.4) this.next = now + 0.08;
    src.start(this.next);
    this.next += buf.duration;
  }

  close() {
    clearInterval(this.statsTimer);
    try { this.decoder.close(); } catch (e) { /* closed */ }
    this.ctx.close();
  }
}

// ---- capture --------------------------------------------------------------

class Microphone {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.track = this.stream.getAudioTracks()[0];
    log('mic', this.track.label);
    const reader = new MediaStreamTrackProcessor({ track: this.track }).readable.getReader();
    this.running = true;
    while (this.running) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!this.encoder) {
        this.encoder = new AudioEncoder({
          output: chunk => {
            const b = new Uint8Array(chunk.byteLength);
            chunk.copyTo(b);
            window.zcall.sendAudio(b, chunk.duration);
          },
          error: e => log('encoder error', e.message),
        });
        // Zalo negotiates 20 ms frames (frmPtime); Chromium's default is 60 ms.
        const config = { codec: 'opus', sampleRate: value.sampleRate, numberOfChannels: value.numberOfChannels, bitrate: 24000 };
        const framed = { ...config, opus: { frameDuration: 20000 } };
        this.encoder.configure((await AudioEncoder.isConfigSupported(framed)).supported ? framed : config);
        log('encoder', value.sampleRate, 'Hz', value.numberOfChannels, 'ch');
      }
      this.encoder.encode(value);
      value.close();
    }
  }

  setMuted(m) { if (this.track) this.track.enabled = !m; }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    try { this.encoder && this.encoder.close(); } catch (e) { /* closed */ }
  }
}

// ---- video ----------------------------------------------------------------

const hex2 = n => n.toString(16).padStart(2, '0');

// SPS (NAL type 7) of an Annex B access unit → "avc1.PPCCLL".
function avcCodecString(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      return `avc1.${hex2(data[i + 4])}${hex2(data[i + 5])}${hex2(data[i + 6])}`;
    }
  }
  return 'avc1.42e01f';
}

// Partner's H.264 access units → WebCodecs → <canvas>.
class VideoPlayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.decoder = null;
    this.stats = { in: 0, decoded: 0, errors: 0 };
    this.statsTimer = setInterval(() => log('video player', JSON.stringify(this.stats)), 5000);
  }

  push(f) {
    this.stats.in++;
    if (!this.decoder) {
      if (!f.key) return;
      const codec = avcCodecString(f.data);
      this.decoder = new VideoDecoder({
        output: frame => this.draw(frame),
        error: e => { this.stats.errors++; log('video decoder error', e.message); this.decoder = null; window.zcall.needKeyframe(); },
      });
      this.decoder.configure({ codec, optimizeForLatency: true });
      log('video decoder', codec);
    }
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: Math.round(f.ts * 1000 / 90), data: f.data }));
    } catch (e) {
      this.stats.errors++;
      log('video decode', e.message);
      this.decoder = null;
      window.zcall.needKeyframe();
    }
  }

  draw(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      log('video size', w, 'x', h);
    }
    this.g.drawImage(frame, 0, 0, w, h);
    frame.close();
    if (!this.stats.decoded++) {
      this.canvas.hidden = false;
      document.body.classList.add('has-video');
    }
  }

  close() {
    clearInterval(this.statsTimer);
    try { this.decoder && this.decoder.close(); } catch (e) { /* closed */ }
    this.canvas.hidden = true;
    document.body.classList.remove('has-video');
  }
}

// Camera or screen → H.264 (OpenH264, constrained baseline, Annex B) → main
// process. Screen sharing swaps the source of the same stream and encoder.
const KEYFRAME_INTERVAL_US = 2e6;
const CAMERA_PROFILE = { bitrate: 600000, framerate: 15 };
const SCREEN_PROFILE = { bitrate: 1000000, framerate: 10, maxWidth: 1280, maxHeight: 720 }; // Zalo's top bwProfile: 720p

class Camera {
  constructor(preview) {
    this.preview = preview;
    this.forceKey = true;
    this.gen = 0;
    this.onScreenEnded = null;
  }

  async start() {
    this.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } },
    });
    this.track = this.cameraStream.getVideoTracks()[0];
    log('camera', this.track.label);
    this.running = true;
    this.use(this.cameraStream, CAMERA_PROFILE);
  }

  async shareScreen() {
    const id = await window.zcall.screenSource();
    if (!id) throw new Error('no screen source');
    const p = SCREEN_PROFILE;
    this.screenStream = id === 'test' ? testScreenStream(p) : await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: p.maxWidth, maxHeight: p.maxHeight, maxFrameRate: p.framerate } },
    });
    const track = this.screenStream.getVideoTracks()[0];
    log('screen', track.label);
    // Stopped from outside (portal / compositor): back to the camera.
    track.onended = () => { if (this.onScreenEnded) this.onScreenEnded(); };
    this.use(this.screenStream, p);
  }

  stopScreen() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    if (this.running) this.use(this.cameraStream, CAMERA_PROFILE);
  }

  // Encode this stream's frames until another source replaces it.
  async use(stream, profile) {
    const gen = ++this.gen;
    this.profile = profile;
    this.forceKey = true;
    this.preview.srcObject = stream;
    this.preview.classList.toggle('screen', profile === SCREEN_PROFILE);
    this.preview.hidden = false;
    const reader = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] }).readable.getReader();
    let lastKey = -Infinity;
    while (this.running && gen === this.gen) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      if (gen !== this.gen || !this.running) { frame.close(); break; }
      this.configure(frame);
      // Drop frames rather than queue latency when the encoder falls behind.
      if (this.encoder.encodeQueueSize > 2) { frame.close(); continue; }
      const key = this.forceKey || frame.timestamp - lastKey >= KEYFRAME_INTERVAL_US;
      if (key) { this.forceKey = false; lastKey = frame.timestamp; }
      this.encoder.encode(frame, { keyFrame: key });
      frame.close();
    }
    reader.cancel().catch(() => {});
  }

  // A new encoder per source size: reconfiguring OpenH264 keeps the old SPS
  // and sends every SPS id in each keyframe, while Zalo phones send just one.
  configure(frame) {
    const width = frame.displayWidth & ~1, height = frame.displayHeight & ~1;
    const config = `${width}x${height}/${this.profile.bitrate}`;
    if (this.config === config) return;
    try { this.encoder && this.encoder.close(); } catch (e) { /* closed */ }
    this.encoder = new VideoEncoder({
      output: chunk => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        window.zcall.sendVideo(b, chunk.type === 'key', chunk.timestamp);
      },
      error: e => log('video encoder error', e.message),
    });
    this.encoder.configure({
      codec: 'avc1.42e01f', width, height, bitrate: this.profile.bitrate, framerate: this.profile.framerate,
      latencyMode: 'realtime', avc: { format: 'annexb' },
    });
    this.config = config;
    this.forceKey = true;
    log('video encoder', width, 'x', height, this.profile.bitrate);
  }

  requestKeyframe() { this.forceKey = true; }

  setOff(off) { if (this.track) this.track.enabled = !off; }

  stop() {
    this.running = false;
    for (const s of [this.cameraStream, this.screenStream]) if (s) s.getTracks().forEach(t => t.stop());
    try { this.encoder && this.encoder.close(); } catch (e) { /* closed */ }
    this.preview.hidden = true;
  }
}

// Stand-in screen for tests (ZCALL_TEST_SCREEN_MS): a changing 1280×718 canvas.
function testScreenStream(p) {
  const c = Object.assign(document.createElement('canvas'), { width: p.maxWidth, height: 718 });
  const g = c.getContext('2d');
  let n = 0;
  const timer = setInterval(() => {
    g.fillStyle = `hsl(${(n += 7) % 360} 60% 50%)`;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    g.fillRect(n % c.width, 300, 80, 80);
  }, 1000 / p.framerate);
  const stream = c.captureStream(p.framerate);
  stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
  return stream;
}

// ---- ringtone -------------------------------------------------------------

class Ringtone {
  start() {
    this.ctx = new AudioContext();
    const ring = () => {
      const t = this.ctx.currentTime;
      for (const [f, at] of [[880, 0], [660, 0.18], [880, 0.6], [660, 0.78]]) {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(0.18, t + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
        o.connect(g).connect(this.ctx.destination);
        o.start(t + at); o.stop(t + at + 0.17);
      }
    };
    ring();
    this.timer = setInterval(ring, 2500);
  }

  stop() {
    clearInterval(this.timer);
    if (this.ctx) this.ctx.close();
    this.ctx = null;
  }
}

// Caller-side tone while the callee rings: 425 Hz, 1 s on / 3 s off.
class Ringback {
  start() {
    this.ctx = new AudioContext();
    const beep = () => {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.value = 425;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.03);
      g.gain.setValueAtTime(0.08, t + 0.97);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1);
      o.connect(g).connect(this.ctx.destination);
      o.start(t); o.stop(t + 1.01);
    };
    beep();
    this.timer = setInterval(beep, 4000);
  }

  stop() {
    clearInterval(this.timer);
    if (this.ctx) this.ctx.close();
    this.ctx = null;
  }
}

// ---- state ----------------------------------------------------------------

let player = null;
let mic = null;
let videoPlayer = null;
let camera = null;
const ringtone = new Ringtone();
const ringback = new Ringback();
let timer = null;
let current = null;
let sharing = false;

function fmt(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function render(s) {
  document.body.dataset.state = s.state;
  $('name').textContent = s.partner.name || 'Zalo';
  if (s.partner.avatar && $('avatar').src !== s.partner.avatar) $('avatar').src = s.partner.avatar;
  $('ringing-actions').hidden = s.state !== 'ringing';
  $('call-actions').hidden = !['connecting', 'active', 'dialing', 'alerting'].includes(s.state);
  const status = $('status');
  clearInterval(timer);
  $('camera-action').hidden = !s.isVideo;
  $('share-action').hidden = !s.isVideo;
  if (s.state === 'ringing') status.textContent = s.isVideo ? 'Cuộc gọi video đến…' : 'Cuộc gọi thoại đến…';
  else if (s.state === 'connecting') status.textContent = 'Đang kết nối…';
  else if (s.state === 'dialing') status.textContent = s.isVideo ? 'Đang gọi video…' : 'Đang gọi…';
  else if (s.state === 'alerting') status.textContent = 'Đang đổ chuông…';
  else if (s.state === 'active') {
    const note = s.partnerSharing ? ' · Đang xem màn hình đối phương' : sharing ? ' · Đang chia sẻ màn hình' : '';
    const tick = () => { status.innerHTML = `<span class="timer">${fmt(Math.floor((Date.now() - s.startedAt) / 1000))}</span>${note}`; };
    tick();
    timer = setInterval(tick, 1000);
  } else if (s.state === 'ended') status.textContent = REASONS[s.reason] || 'Cuộc gọi đã kết thúc';
}

window.zcall.onState(s => {
  const prev = current && current.state;
  current = s;
  render(s);
  if (s.state === 'ringing' && prev !== 'ringing') ringtone.start();
  if (s.state !== 'ringing') ringtone.stop();
  if (s.state === 'alerting' && prev !== 'alerting') ringback.start();
  if (s.state !== 'alerting') ringback.stop();
  if (s.state === 'active' && prev !== 'active') {
    player = new Player(s.codec);
    mic = new Microphone();
    mic.start().catch(e => log('mic error', e.message));
    if (s.isVideo) {
      videoPlayer = new VideoPlayer($('remote'));
      camera = new Camera($('local'));
      camera.onScreenEnded = () => setSharing(false);
      camera.start().catch(e => log('camera error', e.message));
    }
  }
  if (s.state === 'ended') {
    if (mic) mic.stop();
    if (player) player.close();
    if (camera) camera.stop();
    if (videoPlayer) videoPlayer.close();
    mic = player = camera = videoPlayer = null;
    sharing = false;
  }
});

window.zcall.onAudio(f => { if (player) player.push(f); });
window.zcall.onVideo(f => { if (videoPlayer) videoPlayer.push(f); });
window.zcall.onKeyframeRequest(() => { if (camera) camera.requestKeyframe(); });
window.zcall.onTestShare(() => $('share').click());

$('accept').onclick = () => window.zcall.accept();
$('decline').onclick = () => window.zcall.decline();
$('hangup').onclick = () => window.zcall.hangup();
$('camera').onclick = () => {
  const off = $('camera').getAttribute('aria-pressed') !== 'true';
  $('camera').setAttribute('aria-pressed', String(off));
  if (camera) camera.setOff(off);
  window.zcall.setMediaState({ cam: !off });
};
$('mute').onclick = () => {
  const on = $('mute').getAttribute('aria-pressed') !== 'true';
  $('mute').setAttribute('aria-pressed', String(on));
  if (mic) mic.setMuted(on);
  if (current && current.isVideo) window.zcall.setMediaState({ mic: !on });
};
$('share').onclick = async () => {
  if (!camera) return;
  if (sharing) { setSharing(false); return; }
  try {
    await camera.shareScreen();
  } catch (e) {
    log('screen error', e.message); // picker cancelled or no portal
    return;
  }
  setSharing(true);
};

function setSharing(on) {
  if (!on && camera) camera.stopScreen();
  if (sharing === on) return;
  sharing = on;
  $('share').setAttribute('aria-pressed', String(on));
  window.zcall.setScreenShare(on);
  if (current) render(current);
}

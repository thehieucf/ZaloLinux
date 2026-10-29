'use strict';
// Linux call engine for Zalo PC — replaces ZaloCall.exe / ZaloHelper.app.
// Zalo's main process (patched in tools/patch.py) spawns this Electron app as
// `electron --no-sandbox <thisDir> <recvPath> <sendPath>` with the IPC AES key
// in ZCALL_IPC_KEY. Protocol notes: re/NOTES.md.
const path = require('path');
const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const { ZaloIpc } = require('./ipc');
const { IncomingCall, OutgoingCall } = require('./call');
const { log, zaloData } = require('./log');

const [recvPath, sendPath] = process.argv.slice(-2);
app.setName('Zalo Call');
app.setPath('userData', path.join(zaloData, 'zcall-linux'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Screen sharing on Wayland goes through PipeWire + xdg-desktop-portal (the
// portal shows its own picker); X11 capture would only see XWayland windows.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

let ipc = null;
let call = null;
let win = null;
let local = null; // our own {id, name, avatar} from Zalo's init data

function sendToZalo(msg) {
  log('>>', msg);
  ipc.send(msg);
}

const engine = {
  sendSignal: (command, data) => sendToZalo({ type: 'sendSignal', command, data }),
  sendUpdate: (command, data) => sendToZalo({ type: 'update', command, data }),
};

function toWindow(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function openCallWindow(isVideo) {
  const w = win = new BrowserWindow({
    width: isVideo ? 480 : 360, height: isVideo ? 720 : 520, resizable: !!isVideo, alwaysOnTop: !isVideo, show: false,
    title: 'Zalo Call', backgroundColor: '#0b1b33', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), contextIsolation: true },
  });
  w.loadFile(path.join(__dirname, 'ui', 'call.html'));
  w.once('ready-to-show', () => { w.show(); w.focus(); });
  w.webContents.on('did-finish-load', () => { if (call && win === w) toWindow('call:state', call.info); });
  w.on('close', () => {
    if (win === w && inCall()) call.hangup();
  });
  w.on('closed', () => { if (win === w) win = null; });
}

function inCall() {
  return call && call.state !== 'ended';
}

function attach(c) {
  call = c;
  c.on('state', info => toWindow('call:state', info));
  c.on('audio-in', frame => toWindow('call:audio', frame));
  c.on('video-in', frame => toWindow('call:video', frame));
  c.on('keyframe-request', () => toWindow('call:keyframe'));
  c.on('ended', () => setTimeout(() => { if (call === c && win && !win.isDestroyed()) win.destroy(); }, 1500));
  if (win && !win.isDestroyed()) win.destroy();
  openCallWindow(c.isVideo);
  // Test hook: share a stand-in screen once the call is up, then stop.
  const testMs = Number(process.env.ZCALL_TEST_SCREEN_MS);
  if (testMs && c.isVideo) {
    const onState = info => {
      if (info.state !== 'active') return;
      c.off('state', onState);
      [testMs, testMs + 2500].forEach(ms => setTimeout(() => toWindow('call:test-share'), ms));
    };
    c.on('state', onState);
  }
}

function startOutgoingCall(data) {
  const partner = data && data.partner && data.partner[0];
  if (!partner || !partner.id) return log('call', 'makeCall without a partner');
  if (inCall()) {
    if (win && !win.isDestroyed()) win.focus();
    return log('call', 'busy, ignoring makeCall');
  }
  // makeCall type: 1 voice, 3 video (5/6: group calls, not supported).
  attach(new OutgoingCall({ engine, myUid: Number(local && local.id) || 0, partner, isVideo: data.type === 3 }));
  call.start();
}

function startIncomingCall(control) {
  const d = control.data || {};
  if (inCall()) {
    if (Number(d.callId) !== call.callId) new IncomingCall({ engine, request: control, myUid: Number(d.uidTo) }).rejectBusy();
    return;
  }
  attach(new IncomingCall({ engine, request: control, myUid: Number(d.uidTo) }));
  call.ring();
  // Debug/test hook: answer automatically after the given delay (ms).
  if (process.env.ZCALL_AUTOACCEPT_MS) setTimeout(() => call.accept(), Number(process.env.ZCALL_AUTOACCEPT_MS));
}

function onControl(c) {
  if (!c || c.act_type !== 'voip') return;
  const callId = Number(c.data && c.data.callId);
  if (c.act === 'request') startIncomingCall(c);
  else if (call && call.callId === callId) call.onControl(c);
}

function onZaloMessage(msg) {
  const quiet = msg.type === 'update' && ['init', 'updateLocal'].includes(msg.command);
  log('<<', quiet ? `${msg.type} ${msg.command}` : msg);
  switch (msg.type) {
    case 'control': onControl(msg.data); break;
    case 'recvSignal': if (inCall()) call.onSignal(msg.command, msg.data); break;
    case 'update':
      if (msg.command === 'init' && msg.data && msg.data.local) local = msg.data.local;
      break;
    case 'request':
      if (msg.command === 'makeCall') startOutgoingCall(msg.data);
      else if (msg.command === 'endCall' && inCall()) call.hangup();
      break;
    default: break;
  }
}

ipcMain.on('call:accept', () => call && call.accept());
ipcMain.on('call:decline', () => call && call.decline && call.decline());
ipcMain.on('call:hangup', () => call && call.hangup());
ipcMain.on('call:audio-out', (_e, { payload, durationUs }) => call && call.sendAudio(Buffer.from(payload), durationUs));
ipcMain.on('call:video-out', (_e, { data, key, timestamp }) => call && call.sendVideo(Buffer.from(data), key, timestamp));
ipcMain.on('call:need-keyframe', () => call && call._requestKeyframe && call._requestKeyframe());
ipcMain.on('call:media-state', (_e, state) => call && call.setMediaState(state));
ipcMain.on('call:share-screen', (_e, on) => call && call.setScreenShare(on));
ipcMain.handle('call:screen-source', async () => {
  if (process.env.ZCALL_TEST_SCREEN_MS) return 'test';
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  log('call', `screen sources ${JSON.stringify(sources.map(s => s.id))}`);
  return sources.length ? sources[0].id : null;
});
ipcMain.on('call:log', (_e, text) => log('ui', text));

// Keep running without windows: the engine lives as long as Zalo does.
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  if (!recvPath || !sendPath || !process.env.ZCALL_IPC_KEY) {
    log('!!', `bad invocation: ${process.argv.join(' ')} key=${!!process.env.ZCALL_IPC_KEY}`);
    app.exit(2);
    return;
  }
  ipc = new ZaloIpc(recvPath, sendPath, process.env.ZCALL_IPC_KEY);
  ipc.on('ready', () => {
    log('--', `connected pid=${process.pid} electron=${process.versions.electron}`);
    sendToZalo({ type: 'update', command: 'native-ready', data: {} });
  });
  ipc.on('message', onZaloMessage);
  ipc.on('error', e => log('!!', e.stack || String(e)));
  ipc.on('close', () => { log('--', 'Zalo closed the IPC socket, exiting'); app.exit(0); });
  ipc.connect();
});

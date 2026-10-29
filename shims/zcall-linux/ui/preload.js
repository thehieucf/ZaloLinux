'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zcall', {
  onState: cb => ipcRenderer.on('call:state', (_e, s) => cb(s)),
  onAudio: cb => ipcRenderer.on('call:audio', (_e, f) => cb(f)),
  onVideo: cb => ipcRenderer.on('call:video', (_e, f) => cb(f)),
  onKeyframeRequest: cb => ipcRenderer.on('call:keyframe', () => cb()),
  onTestShare: cb => ipcRenderer.on('call:test-share', () => cb()),
  accept: () => ipcRenderer.send('call:accept'),
  decline: () => ipcRenderer.send('call:decline'),
  hangup: () => ipcRenderer.send('call:hangup'),
  sendAudio: (payload, durationUs) => ipcRenderer.send('call:audio-out', { payload, durationUs }),
  sendVideo: (data, key, timestamp) => ipcRenderer.send('call:video-out', { data, key, timestamp }),
  needKeyframe: () => ipcRenderer.send('call:need-keyframe'),
  setMediaState: state => ipcRenderer.send('call:media-state', state),
  screenSource: () => ipcRenderer.invoke('call:screen-source'),
  setScreenShare: on => ipcRenderer.send('call:share-screen', on),
  log: text => ipcRenderer.send('call:log', String(text)),
});

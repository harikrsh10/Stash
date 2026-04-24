// src/preload.js — safe bridge between renderer and node APIs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getHistory: () => ipcRenderer.invoke('history:get'),
  getPaused: () => ipcRenderer.invoke('paused:get'),
  setPaused: (v) => ipcRenderer.invoke('paused:set', v),
  write: (entry) => ipcRenderer.invoke('clip:write', entry),
  delete: (id) => ipcRenderer.invoke('clip:delete', id),
  clear: () => ipcRenderer.invoke('clip:clear'),
  pin: (id) => ipcRenderer.invoke('clip:pin', id),
  unpin: (id) => ipcRenderer.invoke('clip:unpin', id),
  hide: () => ipcRenderer.invoke('window:hide'),
  startDrag: (entry) => ipcRenderer.send('ondragstart', entry),
  onNewClip: (cb) => ipcRenderer.on('clip:new', (_e, entry) => cb(entry)),
  onPromoted: (cb) => ipcRenderer.on('clip:promoted', (_e, entry) => cb(entry)),
  onSkipped: (cb) => ipcRenderer.on('clip:skipped', (_e, info) => cb(info)),
  onPauseChanged: (cb) => ipcRenderer.on('paused:changed', (_e, v) => cb(v)),
  onHistoryCleared: (cb) => ipcRenderer.on('history:cleared', () => cb()),
  onStateUpdated: (cb) => ipcRenderer.on('state:updated', (_e, state) => cb(state)),
});

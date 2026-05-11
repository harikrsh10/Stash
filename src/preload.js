// src/preload.js — safe bridge between renderer and node APIs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // history / pinned
  getHistory: () => ipcRenderer.invoke('history:get'),
  write: (entry) => ipcRenderer.invoke('clip:write', entry),
  delete: (id) => ipcRenderer.invoke('clip:delete', id),
  clear: () => ipcRenderer.invoke('clip:clear'),
  pin: (id) => ipcRenderer.invoke('clip:pin', id),
  unpin: (id) => ipcRenderer.invoke('clip:unpin', id),

  // drawer-specific
  hide: () => ipcRenderer.invoke('window:hide'),
  startDrag: (entry) => ipcRenderer.send('ondragstart', entry),
  drawerDragStart: () => ipcRenderer.send('drawer:dragStart'),
  drawerDragEnd: () => ipcRenderer.send('drawer:dragEnd'),

  // dock-specific
  dockPick: (entry) => ipcRenderer.invoke('dock:pick', entry),
  dockHide: () => ipcRenderer.invoke('dock:hide'),
  dockOpenMain: () => ipcRenderer.invoke('dock:openMain'),
  dockDragStart: () => ipcRenderer.send('dock:dragStart'),
  dockDragEnd: () => ipcRenderer.send('dock:dragEnd'),
  onDockItems: (cb) => ipcRenderer.on('dock:items', (_e, items) => cb(items)),

  // pause / settings
  getPaused: () => ipcRenderer.invoke('paused:get'),
  setPaused: (v) => ipcRenderer.invoke('paused:set', v),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // listeners
  onNewClip: (cb) => ipcRenderer.on('clip:new', (_e, entry) => cb(entry)),
  onPromoted: (cb) => ipcRenderer.on('clip:promoted', (_e, entry) => cb(entry)),
  onSkipped: (cb) => ipcRenderer.on('clip:skipped', (_e, info) => cb(info)),
  onPauseChanged: (cb) => ipcRenderer.on('paused:changed', (_e, v) => cb(v)),
  onHistoryCleared: (cb) => ipcRenderer.on('history:cleared', () => cb()),
  onStateUpdated: (cb) => ipcRenderer.on('state:updated', (_e, state) => cb(state)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),

  // updates
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
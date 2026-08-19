// src/preload.js — safe bridge between renderer and node APIs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // history / pinned
  getHistory: () => ipcRenderer.invoke('history:get'),
  // plain: true forces text only, dropping any formatting the clip kept
  write: (entry, plain) => ipcRenderer.invoke('clip:write', entry, plain),
  delete: (id) => ipcRenderer.invoke('clip:delete', id),
  clear: () => ipcRenderer.invoke('clip:clear'),
  pin: (id) => ipcRenderer.invoke('clip:pin', id),
  unpin: (id) => ipcRenderer.invoke('clip:unpin', id),
  markPrompt: (id) => ipcRenderer.invoke('clip:prompt', id),
  unmarkPrompt: (id) => ipcRenderer.invoke('clip:unprompt', id),
  updatePrompt: (id, patch) => ipcRenderer.invoke('prompt:update', id, patch),
  // give a clip a title of your own; an empty name restores the derived one
  renameClip: (id, name) => ipcRenderer.invoke('clip:rename', id, name),

  // sessions
  createSession: (name) => ipcRenderer.invoke('sessions:create', name),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', id, name),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  setActiveSession: (id) => ipcRenderer.invoke('sessions:setActive', id),
  addToSession: (clipId, sessionId) => ipcRenderer.invoke('session:add', clipId, sessionId),
  removeFromSession: (clipId, sessionId) => ipcRenderer.invoke('session:remove', clipId, sessionId),

  // manual order — `ids` is the new order of the rows the drawer was showing
  reorderPinned: (ids) => ipcRenderer.invoke('order:pinned', ids),
  reorderSession: (sessionId, ids) => ipcRenderer.invoke('order:session', sessionId, ids),

  // OCR
  ocr: (id) => ipcRenderer.invoke('ocr:run', id),
  // colours out of the same image, through the same inspector
  palette: (id) => ipcRenderer.invoke('palette:run', id),
  expandWindow: (v) => ipcRenderer.invoke('window:expand', v),
  createPrompt: (content) => ipcRenderer.invoke('prompt:create', content),
  onOcrProgress: (cb) => ipcRenderer.on('ocr:progress', (_e, m) => cb(m)),

  // drawer-specific
  hide: () => ipcRenderer.invoke('window:hide'),
  startDrag: (entry) => ipcRenderer.send('ondragstart', entry),
  startDragMulti: (entries, iconDataUrl) => ipcRenderer.send('ondragstart:multi', entries, iconDataUrl),
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
  getAppearance: () => ipcRenderer.invoke('appearance:get'),
  setAppearance: (choice) => ipcRenderer.invoke('appearance:set', choice),

  // listeners
  // `collected` is the session's own copy when a session took the clip too
  onNewClip: (cb) => ipcRenderer.on('clip:new', (_e, entry, collected) => cb(entry, collected)),
  onPromoted: (cb) => ipcRenderer.on('clip:promoted', (_e, entry, collected) => cb(entry, collected)),
  onSkipped: (cb) => ipcRenderer.on('clip:skipped', (_e, info) => cb(info)),
  onPauseChanged: (cb) => ipcRenderer.on('paused:changed', (_e, v) => cb(v)),
  onHistoryCleared: (cb) => ipcRenderer.on('history:cleared', () => cb()),
  onStateUpdated: (cb) => ipcRenderer.on('state:updated', (_e, state) => cb(state)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onAppearanceChanged: (cb) => ipcRenderer.on('appearance:changed', (_e, s) => cb(s)),

  // updates
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // restart into the version already downloaded in the background
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:get'),
});
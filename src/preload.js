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
  createPrompt: (content) => ipcRenderer.invoke('prompt:create', content),
  onOcrProgress: (cb) => ipcRenderer.on('ocr:progress', (_e, m) => cb(m)),

  // drawer-specific
  hide: () => ipcRenderer.invoke('window:hide'),
  // let clicks fall through the empty half of the window to whatever is behind
  setClickThrough: (on) => ipcRenderer.invoke('window:clickThrough', on),
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
  // the keys in force, what to print on a key cap, and whether we hold them
  getShortcuts: () => ipcRenderer.invoke('shortcuts:get'),
  // returns { ok, reason? } — a key another app already has is refused and the
  // previous one put back, rather than leaving no shortcut at all
  setShortcuts: (patch) => ipcRenderer.invoke('shortcuts:set', patch),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getAppearance: () => ipcRenderer.invoke('appearance:get'),
  setAppearance: (choice) => ipcRenderer.invoke('appearance:set', choice),

  // listeners
  // `collected` is the session's own copy when a session took the clip too
  onNewClip: (cb) => ipcRenderer.on('clip:new', (_e, entry, collected) => cb(entry, collected)),
  onPromoted: (cb) => ipcRenderer.on('clip:promoted', (_e, entry, collected) => cb(entry, collected)),
  // a picture's text has been read, and search can now reach it
  onClipIndexed: (cb) => ipcRenderer.on('clip:indexed', (_e, id, text) => cb(id, text)),
  // we worked out which app a clip was copied out of
  onClipSourced: (cb) => ipcRenderer.on('clip:sourced', (_e, id, app, icon) => cb(id, app, icon)),
  onSkipped: (cb) => ipcRenderer.on('clip:skipped', (_e, info) => cb(info)),
  // this clip pastes rather than drags, and has been put on the clipboard
  onPasteInstead: (cb) => ipcRenderer.on('clip:pasteInstead', (_e, info) => cb(info)),
  onPauseChanged: (cb) => ipcRenderer.on('paused:changed', (_e, v) => cb(v)),
  // whether anyone can actually see the drawer, which blur alone does not say
  onWindowShown: (cb) => ipcRenderer.on('window:shown', () => cb()),
  onWindowHidden: (cb) => ipcRenderer.on('window:hidden', () => cb()),
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

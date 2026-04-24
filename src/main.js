// src/main.js — Stash main process
// Handles: window lifecycle, global hotkey, tray, clipboard polling, native drag-out
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const isDev = process.argv.includes('--dev');
const HISTORY_LIMIT = 100;
const POLL_INTERVAL = 600;
const TMP_DIR = path.join(os.tmpdir(), 'stash-drag');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

let mainWindow = null;
let tray = null;
let lastSig = '';
let history = [];
let pinned = []; // separate array; pinned items don't age out and persist to disk
let pollTimer = null;
let isPaused = false;
let pinnedStorePath = null; // set once app is ready (needs app.getPath)

// Single instance — second launch just toggles the existing window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => toggleWindow());
}

// ---------- window ----------
function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const drawerW = 340;

  mainWindow = new BrowserWindow({
    width: drawerW,
    height: screenH,
    x: screenW - drawerW,
    y: 0,
    frame: false,
    transparent: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));

  mainWindow.on('blur', () => {
    if (!isDev) mainWindow.hide();
  });

  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ---------- tray ----------
function createTray() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  let icon;

  if (process.platform === 'darwin') {
    // macOS: use template icon (black on transparent, OS handles theming)
    const iconPath = path.join(assetsDir, 'trayTemplate.png');
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
      icon.setTemplateImage(true);
    }
  } else if (process.platform === 'win32') {
    // Windows: use the white icon, sized for the taskbar tray.
    // 16px is the base size but we pass a larger one and let Windows scale
    // down cleanly for HiDPI displays.
    const iconPath = path.join(assetsDir, 'tray.png');
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
    }
  } else {
    // Linux: white icon works on most dark panels; distros vary
    const iconPath = path.join(assetsDir, 'tray.png');
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
    }
  }

  if (!icon || icon.isEmpty()) {
    console.warn('tray icon asset missing, falling back to empty');
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Stash — clipboard history (⌘⇧V)');
  refreshTrayMenu();

  tray.on('click', () => toggleWindow());

  // On Windows, double-click is also common for tray icons
  if (process.platform === 'win32') {
    tray.on('double-click', () => toggleWindow());
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const visible = mainWindow && mainWindow.isVisible();
  const menu = Menu.buildFromTemplate([
    {
      label: visible ? 'Hide Stash' : 'Show Stash',
      accelerator: 'CommandOrControl+Shift+V',
      click: toggleWindow,
    },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume clipboard capture' : 'Pause clipboard capture',
      click: () => setPaused(!isPaused),
    },
    {
      label: `${history.length} clip${history.length === 1 ? '' : 's'}${pinned.length ? ` · ${pinned.length} pinned` : ''}${isPaused ? ' (paused)' : ''}`,
      enabled: false,
    },
    {
      label: 'Clear history (pinned items kept)',
      enabled: history.length > 0,
      click: () => {
        history.forEach(h => {
          if (h.filepath && fs.existsSync(h.filepath)) {
            try { fs.unlinkSync(h.filepath); } catch (_) {}
          }
        });
        history = [];
        if (mainWindow) mainWindow.webContents.send('history:cleared');
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit Stash', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
  if (process.platform === 'darwin') {
    tray.setTitle(isPaused ? ' paused' : '');
  }
}

function setPaused(paused) {
  isPaused = paused;
  refreshTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('paused:changed', isPaused);
  }
}

// ---------- helpers ----------
function hash(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

function sniffType(text) {
  if (!text) return 'text';
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return 'url';
  const codeHints = /[{};]|=>|function |const |import |def |SELECT |class |^\s*<[a-z]/m;
  if (codeHints.test(t) && t.length < 2000) return 'code';
  return 'text';
}

function looksSecret(text) {
  if (!text) return false;
  const t = text.trim();
  if (/\s/.test(t)) return false;
  if (/^\d{6,8}$/.test(t)) return true;
  if (t.length < 8) return false;
  if (t.length > 500) return false;

  const prefixPatterns = [
    /^sk-[A-Za-z0-9_-]{20,}$/,
    /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    /^ghp_[A-Za-z0-9]{30,}$/,
    /^gho_[A-Za-z0-9]{30,}$/,
    /^ghs_[A-Za-z0-9]{30,}$/,
    /^github_pat_[A-Za-z0-9_]{40,}$/,
    /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
    /^AKIA[0-9A-Z]{16}$/,
    /^AIza[0-9A-Za-z_-]{35}$/,
    /^AIzaSy[0-9A-Za-z_-]{33}$/,
    /^rk_(live|test)_[A-Za-z0-9]{20,}$/,
    /^(pk|sk)_(live|test)_[A-Za-z0-9]{20,}$/,
    /^dop_v1_[a-f0-9]{64}$/,
    /^hf_[A-Za-z0-9]{30,}$/,
    /^appl_[A-Za-z0-9]{20,}$/,
  ];
  if (prefixPatterns.some(re => re.test(t))) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return true;
  if (/^[A-Za-z0-9+/]{40}$/.test(t) &&
      /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t)) return true;
  if (/^[A-Za-z0-9_+/=-]{32,80}$/.test(t)) {
    const hasLower = /[a-z]/.test(t);
    const hasUpper = /[A-Z]/.test(t);
    const hasDigit = /\d/.test(t);
    const classes = [hasLower, hasUpper, hasDigit].filter(Boolean).length;
    if (classes >= 2) return true;
  }
  const digitsOnly = t.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(digitsOnly) && luhnCheck(digitsOnly)) return true;
  return false;
}

function luhnCheck(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---------- pin persistence ----------
// Pinned items are the ONLY thing Stash writes to disk. Everything else is
// memory-only. This keeps the privacy story clean: if you didn't explicitly
// pin it, it's gone on quit.
function loadPinned() {
  if (!pinnedStorePath) return;
  try {
    if (!fs.existsSync(pinnedStorePath)) return;
    const raw = fs.readFileSync(pinnedStorePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;
    // Filter out any img entries whose temp file no longer exists
    pinned = data.filter(entry => {
      if (entry.type === 'img' && entry.filepath) {
        return fs.existsSync(entry.filepath);
      }
      return true;
    });
    console.log(`[Stash] loaded ${pinned.length} pinned items`);
  } catch (err) {
    console.error('[Stash] failed to load pinned:', err);
    pinned = [];
  }
}

function savePinned() {
  if (!pinnedStorePath) return;
  try {
    // Strip dataUrl from saved entries — it's huge and we can regenerate on demand
    const serializable = pinned.map(p => {
      const copy = { ...p };
      delete copy._new;
      delete copy._promoted;
      // keep dataUrl for images so they render without re-reading the file
      return copy;
    });
    fs.writeFileSync(pinnedStorePath, JSON.stringify(serializable, null, 2), 'utf8');
  } catch (err) {
    console.error('[Stash] failed to save pinned:', err);
  }
}

// For pinned images, we need to copy the temp file to a permanent location
// so it survives tmpdir cleanup.
function makeImagePermanent(entry) {
  if (entry.type !== 'img' || !entry.filepath) return entry;
  const permDir = path.join(path.dirname(pinnedStorePath), 'pinned-images');
  if (!fs.existsSync(permDir)) fs.mkdirSync(permDir, { recursive: true });
  const permPath = path.join(permDir, path.basename(entry.filepath));
  if (entry.filepath !== permPath && fs.existsSync(entry.filepath)) {
    try {
      fs.copyFileSync(entry.filepath, permPath);
      entry.filepath = permPath;
    } catch (err) {
      console.error('[Stash] failed to persist image:', err);
    }
  }
  return entry;
}

function pinItem(id) {
  // could be in history or already pinned (no-op in latter case)
  if (pinned.some(p => p.id === id)) return false;
  const idx = history.findIndex(h => h.id === id);
  if (idx === -1) return false;
  let entry = history[idx];
  entry = makeImagePermanent(entry);
  entry.pinnedAt = Date.now();
  pinned.unshift(entry);
  // also remove from history so it's not duplicated in the UI
  history.splice(idx, 1);
  savePinned();
  refreshTrayMenu();
  return true;
}

function unpinItem(id) {
  const idx = pinned.findIndex(p => p.id === id);
  if (idx === -1) return false;
  const [removed] = pinned.splice(idx, 1);
  // move it back to history (at the top, as if just copied)
  delete removed.pinnedAt;
  removed.ts = Date.now();
  history.unshift(removed);
  savePinned();
  refreshTrayMenu();
  return true;
}

// ---------- clipboard watcher ----------
function pollClipboard() {
  if (isPaused) return;
  try {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const png = img.toPNG();
      if (png && png.length > 0) {
        const sig = 'img:' + hash(png);
        if (sig === lastSig) return;

        const size = img.getSize();
        const text = clipboard.readText();
        const isTinyIncidental = size.width < 16 && size.height < 16;

        if (!(text && isTinyIncidental)) {
          lastSig = sig;

          // If user re-copies a pinned image, just bump it in pinned
          const pinnedIdx = pinned.findIndex(p => p.id === sig);
          if (pinnedIdx > -1) {
            const existing = pinned.splice(pinnedIdx, 1)[0];
            existing.pinnedAt = Date.now();
            pinned.unshift(existing);
            savePinned();
            broadcastPromote(existing);
            return;
          }

          // Promote-on-recopy for images in history
          const existingIdx = history.findIndex(h => h.id === sig);
          if (existingIdx > -1) {
            const existing = history.splice(existingIdx, 1)[0];
            existing.ts = Date.now();
            history.unshift(existing);
            broadcastPromote(existing);
            return;
          }

          const filename = `clip-${Date.now()}.png`;
          const filepath = path.join(TMP_DIR, filename);
          fs.writeFileSync(filepath, png);

          addEntry({
            id: sig,
            type: 'img',
            content: filename,
            filepath,
            dataUrl: img.resize({ width: 240 }).toDataURL(),
            meta: `${size.width}×${size.height}`,
            ts: Date.now(),
          });
          return;
        }
      }
    }

    const text = clipboard.readText();
    if (!text) return;
    const sig = 'txt:' + hash(Buffer.from(text));
    if (sig === lastSig) return;
    lastSig = sig;

    if (looksSecret(text)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clip:skipped', { reason: 'secret' });
      }
      return;
    }

    // If the user re-copies something they've pinned, just bump its pinnedAt
    // so it rises to the top of the pinned section — don't duplicate into history.
    const pinnedIdx = pinned.findIndex(p => p.id === sig);
    if (pinnedIdx > -1) {
      const existing = pinned.splice(pinnedIdx, 1)[0];
      existing.pinnedAt = Date.now();
      pinned.unshift(existing);
      savePinned();
      broadcastPromote(existing);
      return;
    }

    // Promote-on-recopy for text (history)
    const existingIdx = history.findIndex(h => h.id === sig);
    if (existingIdx > -1) {
      const existing = history.splice(existingIdx, 1)[0];
      existing.ts = Date.now();
      history.unshift(existing);
      broadcastPromote(existing);
      return;
    }

    addEntry({
      id: sig,
      type: sniffType(text),
      content: text,
      ts: Date.now(),
    });
  } catch (err) {
    console.error('poll error:', err);
  }
}

function broadcastPromote(entry) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clip:promoted', entry);
  }
  refreshTrayMenu();
}

function addEntry(entry) {
  history = history.filter(h => h.id !== entry.id);
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) {
    const dropped = history.splice(HISTORY_LIMIT);
    dropped.forEach(d => {
      if (d.filepath && fs.existsSync(d.filepath)) {
        try { fs.unlinkSync(d.filepath); } catch (_) {}
      }
    });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clip:new', entry);
  }
  refreshTrayMenu();
}

// ---------- ipc ----------
ipcMain.handle('history:get', () => ({ history, pinned }));
ipcMain.handle('paused:get', () => isPaused);
ipcMain.handle('paused:set', (_e, v) => { setPaused(!!v); return isPaused; });

ipcMain.handle('clip:pin', (_e, id) => {
  const ok = pinItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned });
  }
  return ok;
});

ipcMain.handle('clip:unpin', (_e, id) => {
  const ok = unpinItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned });
  }
  return ok;
});

ipcMain.handle('clip:write', (_e, entry) => {
  lastSig = entry.id;
  if (entry.type === 'img' && entry.filepath && fs.existsSync(entry.filepath)) {
    clipboard.writeImage(nativeImage.createFromPath(entry.filepath));
  } else {
    clipboard.writeText(entry.content);
  }
  // promote on intentional re-use — check pinned first, then history
  const pinnedIdx = pinned.findIndex(p => p.id === entry.id);
  if (pinnedIdx > 0) {
    const existing = pinned.splice(pinnedIdx, 1)[0];
    existing.pinnedAt = Date.now();
    pinned.unshift(existing);
    savePinned();
    broadcastPromote(existing);
    return true;
  }
  const idx = history.findIndex(h => h.id === entry.id);
  if (idx > 0) {
    const existing = history.splice(idx, 1)[0];
    existing.ts = Date.now();
    history.unshift(existing);
    broadcastPromote(existing);
  }
  return true;
});

ipcMain.handle('clip:delete', (_e, id) => {
  // try pinned first
  const pinnedIdx = pinned.findIndex(p => p.id === id);
  if (pinnedIdx > -1) {
    const [removed] = pinned.splice(pinnedIdx, 1);
    if (removed.filepath && fs.existsSync(removed.filepath)) {
      try { fs.unlinkSync(removed.filepath); } catch (_) {}
    }
    savePinned();
    refreshTrayMenu();
    return true;
  }
  const idx = history.findIndex(h => h.id === id);
  if (idx === -1) return false;
  const [removed] = history.splice(idx, 1);
  if (removed.filepath && fs.existsSync(removed.filepath)) {
    try { fs.unlinkSync(removed.filepath); } catch (_) {}
  }
  refreshTrayMenu();
  return true;
});

ipcMain.handle('clip:clear', () => {
  // Only clear history, never pinned. Pinned is explicit user commitment.
  history.forEach(h => {
    if (h.filepath && fs.existsSync(h.filepath)) {
      try { fs.unlinkSync(h.filepath); } catch (_) {}
    }
  });
  history = [];
  refreshTrayMenu();
  return true;
});

ipcMain.handle('window:hide', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('ondragstart', (event, entry) => {
  let filepath, iconPath;
  if (entry.type === 'img' && entry.filepath) {
    filepath = entry.filepath;
    iconPath = entry.filepath;
  } else {
    const safe = (entry.content || '').slice(0, 40).replace(/[^\w-]+/g, '_') || 'clip';
    filepath = path.join(TMP_DIR, `${safe}-${Date.now()}.txt`);
    fs.writeFileSync(filepath, entry.content);
    iconPath = filepath;
  }
  try {
    const img = nativeImage.createFromPath(iconPath);
    event.sender.startDrag({
      file: filepath,
      icon: img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 64 }),
    });
  } catch (err) {
    console.error('startDrag failed:', err);
  }
});

// ---------- lifecycle ----------
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Set up persistence path (now that app is ready)
  pinnedStorePath = path.join(app.getPath('userData'), 'pinned.json');
  loadPinned();

  createWindow();
  createTray();

  console.log('[Stash] tray created:', tray ? 'yes' : 'no');
  console.log('[Stash] platform:', process.platform);
  console.log('[Stash] assets dir:', path.join(__dirname, '..', 'assets'));
  console.log('[Stash] pinned store:', pinnedStorePath);

  const registered = globalShortcut.register('CommandOrControl+Shift+V', toggleWindow);
  if (!registered) console.warn('[Stash] hotkey registration failed');
  else console.log('[Stash] hotkey registered: Ctrl+Shift+V');

  pollTimer = setInterval(pollClipboard, POLL_INTERVAL);
  pollClipboard();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // keep running — menu-bar style
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (pollTimer) clearInterval(pollTimer);
  // Clean up temp drag files, but leave pinned-images directory alone
  const pinnedImagePaths = new Set(pinned.filter(p => p.filepath).map(p => p.filepath));
  try {
    fs.readdirSync(TMP_DIR).forEach(f => {
      const fp = path.join(TMP_DIR, f);
      if (!pinnedImagePaths.has(fp)) {
        try { fs.unlinkSync(fp); } catch (_) {}
      }
    });
  } catch (_) {}
});

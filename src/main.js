// src/main.js — Stash main process
// Handles: window lifecycle, global hotkey, tray, clipboard polling, native drag-out
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, nativeImage, nativeTheme, screen, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const isDev = process.argv.includes('--dev');
const HISTORY_LIMIT = 100;
const POLL_INTERVAL = 600;
const TMP_DIR = path.join(os.tmpdir(), 'stash-drag');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

let mainWindow = null;
let dockWindow = null;
let tray = null;
let lastSig = '';
let history = [];
let pinned = []; // separate array; pinned items don't age out and persist to disk
let pollTimer = null;
let isPaused = false;
let pausedClipboardSigs = new Set();
let pinnedStorePath = null; // set once app is ready (needs app.getPath)
let settingsStorePath = null;
let collectionStatsStorePath = null;

// Drawer drag state — set by IPC from the renderer. Used by the blur handler
// to suppress hide-on-blur while the OS is driving a drag operation.
// Mirrors the dock's dragInProgress pattern (see further down).
let drawerDragInProgress = false;
let drawerDragSafetyTimer = null;

// User settings (persisted to disk)
let settings = {
  autoPasteFromDock: false, // default off — no permission prompt on first launch
  watchScreenshots: true,   // macOS only — see the watcher for why this one is on
  activeSessionId: null,    // capture into this session; null means ordinary copying
  appearance: 'system',     // system | dark | light
};

// Setting themeSource is what flips prefers-color-scheme inside the windows, so
// the stylesheets need no theme class of their own — and native bits like
// scrollbars and menus follow at the same time.
function applyAppearance() {
  const choice = ['system', 'dark', 'light'].includes(settings.appearance) ? settings.appearance : 'system';
  nativeTheme.themeSource = choice;
  const dark = choice === 'system' ? nativeTheme.shouldUseDarkColors : choice === 'dark';
  // without this the window paints its old ground for a frame when it opens
  const bg = dark ? '#0a0a0a' : '#fcfcfd';
  [mainWindow, dockWindow].forEach(w => {
    if (w && !w.isDestroyed()) w.setBackgroundColor(bg);
  });
  // the drawer has its own switch, so it has to hear about changes made from
  // the tray — and about the system flipping underneath a 'system' choice
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('appearance:changed', { choice, dark });
  }
}

function setAppearance(choice) {
  if (!['system', 'dark', 'light'].includes(choice)) return false;
  settings.appearance = choice;
  saveSettings();
  applyAppearance();
  refreshTrayMenu();
  return true;
}

// ---------- sessions ----------
// A session is a named folder that fills itself: while one is active, whatever
// you copy joins it. Sessions and their clips survive restarts, so a session
// keeps its own copy of an entry rather than sharing the one in history —
// history is memory-only, capped, and deletes the temp file of anything that
// ages out, which would otherwise gut the session it belonged to.
let sessions = [];      // [{ id, name, createdAt }]
let sessionClips = [];  // entries carrying sessionId
let sessionStorePath = null;
let collectionStats = {
  totalCaptures: 0,
  activeCollectionCaptures: 0,
  collectionsCreated: 0,
  activeStops: 0,
  activeChanges: 0,
};
let activeCollectionRunCaptures = {};

// Single instance — second launch just toggles the existing window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => toggleWindow());
}

// ---------- window ----------
// The drawer is a fixed-width strip on the right edge. Inspecting an image
// widens the window leftwards so the picture has room, then puts it back.
// 340 of panel plus the 78px rail, so the list keeps the width it always had
const DRAWER_W = 466;
const INSPECTOR_W = 520;

// Which screen the drawer belongs on.
//
// While it is up, that is whichever screen it is already on: expanding for the
// inspector must not teleport it back to the built-in display, which is what
// made a drawer dragged onto a second monitor snap home the moment you opened
// or closed a panel.
//
// When it is coming up fresh it is the screen the pointer is on, so the hotkey
// summons it to wherever you are working. The dock window has always behaved
// this way; the drawer was pinned to the primary display.
function drawerDisplay(preferCursor) {
  if (!preferCursor && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    const b = mainWindow.getBounds();
    return screen.getDisplayNearestPoint({
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2),
    });
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// Full height of whatever screen it lands on, welded to that screen edge, so
// a tall monitor gets a tall drawer rather than a laptop-sized one.
function drawerBounds(display, expanded) {
  const { workArea } = display;
  const width = expanded ? DRAWER_W + INSPECTOR_W : DRAWER_W;
  return {
    // grow to the left so the drawer stays welded to the screen edge
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height: workArea.height,
  };
}

// Asking whether the inspector is out, from the width alone.
//
// It cannot be an exact comparison against DRAWER_W: a display running at a
// fractional scale hands back a window a pixel or two wider than the one that
// was asked for -- 466 comes back as 468 -- so "wider than DRAWER_W" reported
// expanded for a drawer that was not, and the next summon opened it at the
// full width with nothing in the inspector half. Halfway between the two
// widths is the only threshold rounding cannot reach.
function isDrawerExpanded() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.getBounds().width > DRAWER_W + INSPECTOR_W / 2;
}

function setWindowExpanded(expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setBounds(drawerBounds(drawerDisplay(false), expanded));
  return true;
}

function createWindow() {
  const first = drawerBounds(drawerDisplay(true), false);

  mainWindow = new BrowserWindow({
    width: first.width,
    height: first.height,
    x: first.x,
    y: first.y,
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

  // Hide on blur — UNLESS a drag is in progress. When the user drags a clip
  // out of the drawer, the OS takes focus to drive the drag, which fires
  // blur on our window. Hiding mid-drag both cancels the drag and forces
  // the user to re-open the drawer with the shortcut for every item.
  mainWindow.on('blur', () => {
    if (isDev) return;
    if (drawerDragInProgress) return;
    mainWindow.hide();
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
    // Summon it to the screen the pointer is on, at that screen's height, and
    // always narrow: hiding closes the inspector, so coming back wide would
    // only show empty space where it used to be.
    mainWindow.setBounds(drawerBounds(drawerDisplay(true), false));
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
  // prompts share the pinned array, so they'd otherwise inflate the pinned count
  const promptCount = pinned.filter(p => p.isPrompt).length;
  const pinCount = pinned.length - promptCount;
  const activeSession = sessions.find(s => s.id === settings.activeSessionId);
  const menu = Menu.buildFromTemplate([
    {
      label: visible ? 'Hide Stash' : 'Show Stash',
      accelerator: 'CommandOrControl+Shift+V',
      click: toggleWindow,
    },
    {
      label: 'Quick dock',
      accelerator: 'CommandOrControl+Shift+Space',
      click: toggleDock,
    },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume clipboard capture' : 'Pause clipboard capture',
      click: () => setPaused(!isPaused),
    },
    // capturing into a session is easy to forget about, so say so where the
    // pause state is already shown
    ...(activeSession ? [{
      label: `Collecting into collection "${activeSession.name}"`,
      click: () => {
        setActiveSession(null);
      },
      toolTip: 'click to stop collecting',
    }] : []),
    {
      label: 'Appearance',
      submenu: ['system', 'light', 'dark'].map(choice => ({
        label: choice === 'system' ? 'Match the system' : choice[0].toUpperCase() + choice.slice(1),
        type: 'radio',
        checked: (settings.appearance || 'system') === choice,
        click: () => setAppearance(choice),
      })),
    },
    {
      label: 'Auto-paste from dock',
      type: 'checkbox',
      checked: settings.autoPasteFromDock,
      click: (item) => {
        settings.autoPasteFromDock = item.checked;
        saveSettings();
        if (settings.autoPasteFromDock && process.platform === 'darwin') {
          // Trigger the permission prompt by attempting a no-op
          // (user needs to grant Accessibility in System Settings)
        }
      },
    },
    // macOS only: on Windows the screenshot gesture already reaches the
    // clipboard, so there is nothing here to fix and no toggle to explain.
    ...(process.platform === 'darwin' ? [{
      label: 'Keep screenshots I take',
      type: 'checkbox',
      checked: settings.watchScreenshots,
      click: (item) => {
        settings.watchScreenshots = item.checked;
        saveSettings();
        // Switching it back on re-asks macOS for the folder if the permission
        // was refused earlier, so the prompt lands on the click that wanted it.
        if (settings.watchScreenshots) startScreenshotWatcher();
        else stopScreenshotWatcher();
      },
    }] : []),
    {
      label: `${history.length} clip${history.length === 1 ? '' : 's'}${pinCount ? ` · ${pinCount} pinned` : ''}${promptCount ? ` · ${promptCount} prompt${promptCount === 1 ? '' : 's'}` : ''}${isPaused ? ' (paused)' : ''}`,
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
  if (isPaused !== paused) {
    if (paused) pausedClipboardSigs = new Set();
    rememberPausedClipboard();
  }
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

function currentClipboardSigs() {
  const sigs = [];

  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const png = img.toPNG();
    if (png && png.length > 0) {
      const size = img.getSize();
      const text = clipboard.readText();
      const isTinyIncidental = size.width < 16 && size.height < 16;
      if (!(text && isTinyIncidental)) sigs.push('img:' + hash(png));
    }
  }

  const text = clipboard.readText();
  if (text) sigs.push('txt:' + hash(Buffer.from(text)));
  return sigs;
}

function rememberPausedClipboard() {
  try {
    const sigs = currentClipboardSigs();
    sigs.forEach(sig => pausedClipboardSigs.add(sig));
    if (sigs.length) lastSig = sigs[0];
  } catch (err) {
    console.warn('[Stash] failed to sync clipboard signature:', err.message);
  }
}

function shouldIgnorePausedClipboard() {
  if (pausedClipboardSigs.size === 0) return false;

  try {
    const sigs = currentClipboardSigs();
    if (sigs.length === 0) {
      pausedClipboardSigs.clear();
      return false;
    }

    const stillPausedContent = sigs.some(sig => pausedClipboardSigs.has(sig));
    if (!stillPausedContent) {
      pausedClipboardSigs.clear();
      return false;
    }

    // Treat every format currently on the clipboard as already seen. This is
    // important on Windows, where one copy can expose both image and text data.
    sigs.forEach(sig => pausedClipboardSigs.add(sig));
    lastSig = sigs[0];
    return true;
  } catch (err) {
    console.warn('[Stash] failed to check paused clipboard signature:', err.message);
    return false;
  }
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
  if (/^\d{6,8}$/.test(t)) return true;
  const digitsOnly = t.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(digitsOnly) && luhnCheck(digitsOnly)) return true;
  if (/\s/.test(t)) return false;
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

// ---------- prompts ----------
// Marking a clip as a prompt is what makes it permanent — there is no separate
// pin step. Prompts ride in the same persistent store as pinned clips (same
// file, same save path, already proven) and are told apart by `isPrompt`, so a
// prompt survives quit, restart and reboot the moment it's marked. The drawer
// shows them as their own section, so the two never read as the same thing.
function promptItem(id) {
  const existing = pinned.find(p => p.id === id);
  if (existing) {
    if (existing.isPrompt) return false;
    existing.isPrompt = true;
    existing.promptedAt = Date.now();
    savePinned();
    refreshTrayMenu();
    return true;
  }
  const idx = history.findIndex(h => h.id === id);
  if (idx === -1) return false;
  let entry = history[idx];
  entry = makeImagePermanent(entry);
  entry.isPrompt = true;
  entry.promptedAt = Date.now();
  entry.pinnedAt = Date.now();
  pinned.unshift(entry);
  history.splice(idx, 1);
  savePinned();
  refreshTrayMenu();
  return true;
}

// Tags are user-authored, so they get cleaned before they're stored: trimmed,
// whitespace-collapsed, deduped case-insensitively, and capped in both length
// and count so a stray paste can't turn into a wall of chips in the filter row.
const TAG_MAX_LEN = 24;
const TAG_MAX_COUNT = 8;
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, TAG_MAX_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= TAG_MAX_COUNT) break;
  }
  return out;
}

// Prompts are a library, so they're editable in place — a typo gets fixed
// rather than re-copied. Only prompts can be edited; ordinary clips stay a
// faithful record of what was on the clipboard.
function updatePrompt(id, patch) {
  const entry = pinned.find(p => p.id === id && p.isPrompt);
  if (!entry || !patch || typeof patch !== 'object') return false;
  if (typeof patch.content === 'string') {
    // refuse to empty a prompt — that's a delete, and there's a button for it
    if (!patch.content.trim()) return false;
    if (entry.content !== patch.content) {
      // the styled copies describe the old words; keeping them would paste
      // something the editor no longer shows
      delete entry.html;
      delete entry.rtf;
    }
    entry.content = patch.content;
  }
  if (patch.tags !== undefined) entry.tags = normalizeTags(patch.tags);
  entry.updatedAt = Date.now();
  savePinned();
  return true;
}

// Unmarking drops the clip back into ordinary history, mirroring unpin — it
// stops being permanent, which is the whole point of taking the mark off.
function unpromptItem(id) {
  const idx = pinned.findIndex(p => p.id === id && p.isPrompt);
  if (idx === -1) return false;
  const [removed] = pinned.splice(idx, 1);
  delete removed.isPrompt;
  delete removed.promptedAt;
  delete removed.pinnedAt;
  removed.ts = Date.now();
  history.unshift(removed);
  savePinned();
  refreshTrayMenu();
  return true;
}

function loadSessions() {
  if (!sessionStorePath) return;
  try {
    if (!fs.existsSync(sessionStorePath)) return;
    const data = JSON.parse(fs.readFileSync(sessionStorePath, 'utf8'));
    sessions = Array.isArray(data.sessions) ? data.sessions : [];
    // drop image clips whose file has gone, same as the pinned store does
    sessionClips = (Array.isArray(data.clips) ? data.clips : []).filter(c => {
      if (c.type === 'img' && c.filepath) return fs.existsSync(c.filepath);
      return true;
    });
    console.log(`[Stash] loaded ${sessions.length} sessions, ${sessionClips.length} session clips`);
  } catch (err) {
    console.error('[Stash] failed to load sessions:', err);
    sessions = [];
    sessionClips = [];
  }
}

function saveSessions() {
  if (!sessionStorePath) return;
  try {
    const clips = sessionClips.map(c => {
      const copy = { ...c };
      delete copy._new;
      delete copy._promoted;
      return copy;
    });
    fs.writeFileSync(sessionStorePath, JSON.stringify({ sessions, clips }, null, 2), 'utf8');
  } catch (err) {
    console.error('[Stash] failed to save sessions:', err);
  }
}

function sessionState() {
  return {
    sessions,
    sessionClips,
    activeSessionId: settings.activeSessionId || null,
    collectionStats: collectionStatsSnapshot(),
  };
}

function loadCollectionStats() {
  if (!collectionStatsStorePath) return;
  try {
    if (!fs.existsSync(collectionStatsStorePath)) return;
    const data = JSON.parse(fs.readFileSync(collectionStatsStorePath, 'utf8'));
    collectionStats = {
      ...collectionStats,
      ...Object.fromEntries(Object.entries(data || {})
        .filter(([, v]) => Number.isFinite(v))),
    };
  } catch (err) {
    console.error('[Stash] failed to load collection stats:', err);
  }
}

function saveCollectionStats() {
  if (!collectionStatsStorePath) return;
  try {
    fs.writeFileSync(collectionStatsStorePath, JSON.stringify(collectionStats, null, 2), 'utf8');
  } catch (err) {
    console.error('[Stash] failed to save collection stats:', err);
  }
}

function collectionStatsSnapshot() {
  const activeId = settings.activeSessionId || null;
  const clipsPerSession = new Map();
  sessionClips.forEach(c => clipsPerSession.set(c.sessionId, (clipsPerSession.get(c.sessionId) || 0) + 1));
  const underfedCollections = sessions.filter(s => (clipsPerSession.get(s.id) || 0) < 3).length;
  const total = collectionStats.totalCaptures || 0;
  return {
    ...collectionStats,
    activeCaptureRate: total ? collectionStats.activeCollectionCaptures / total : 0,
    activeCollectionRunCaptures: activeId ? (activeCollectionRunCaptures[activeId] || 0) : 0,
    totalCollections: sessions.length,
    underfedCollections,
  };
}

function recordCaptureStats(collected) {
  collectionStats.totalCaptures += 1;
  if (collected && collected.sessionId) {
    collectionStats.activeCollectionCaptures += 1;
    activeCollectionRunCaptures[collected.sessionId] = (activeCollectionRunCaptures[collected.sessionId] || 0) + 1;
  }
  saveCollectionStats();
}

function inSession(clipId, sessionId) {
  return sessionClips.some(c => c.id === clipId && c.sessionId === sessionId);
}

// Take a session's own copy: history may drop this entry and delete its temp
// file, so images are moved somewhere permanent first.
function addToSession(entry, sessionId) {
  if (!sessions.some(s => s.id === sessionId)) return false;
  if (inSession(entry.id, sessionId)) return false;
  const copy = makeImagePermanent({ ...entry });
  delete copy._new;
  delete copy._promoted;
  copy.sessionId = sessionId;
  copy.addedAt = Date.now();
  sessionClips.unshift(copy);
  saveSessions();
  return true;
}

function removeFromSession(clipId, sessionId) {
  const idx = sessionClips.findIndex(c => c.id === clipId && c.sessionId === sessionId);
  if (idx === -1) return false;
  const [gone] = sessionClips.splice(idx, 1);
  dropSessionImage(gone);
  saveSessions();
  return true;
}

// An image file is only safe to delete once nothing else points at it — the
// same picture can sit in two sessions, or be pinned as well.
function dropSessionImage(clip) {
  if (!clip || clip.type !== 'img' || !clip.filepath) return;
  const stillUsed = sessionClips.some(c => c.filepath === clip.filepath)
    || pinned.some(p => p.filepath === clip.filepath);
  if (stillUsed) return;
  try {
    if (fs.existsSync(clip.filepath)) fs.unlinkSync(clip.filepath);
  } catch (_) { /* a leftover file is better than a crash */ }
}

// ---------- settings persistence ----------
function loadSettings() {
  if (!settingsStorePath) return;
  try {
    if (!fs.existsSync(settingsStorePath)) return;
    const raw = fs.readFileSync(settingsStorePath, 'utf8');
    const data = JSON.parse(raw);
    settings = { ...settings, ...data };
  } catch (err) {
    console.error('[Stash] failed to load settings:', err);
  }
}

function saveSettings() {
  if (!settingsStorePath) return;
  try {
    fs.writeFileSync(settingsStorePath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[Stash] failed to save settings:', err);
  }
}

function setActiveSession(id) {
  const prev = settings.activeSessionId || null;
  const next = id && sessions.some(s => s.id === id) ? id : null;
  settings.activeSessionId = next;
  if (prev !== next) {
    if (next) collectionStats.activeChanges += 1;
    else collectionStats.activeStops += 1;
    saveCollectionStats();
  }
  saveSettings();
  refreshTrayMenu();
  broadcastState();
  return next;
}

// ---------- auto-paste (platform-specific) ----------
// Attempts to simulate Cmd+V / Ctrl+V in whatever app was focused before the dock opened.
// On macOS this requires Accessibility permission (granted once in System Settings).
// On Windows we use PowerShell's SendKeys. Both fail silently if blocked — the clip is
// already on the clipboard either way, so the user can always paste manually.
function tryAutoPaste() {
  const { exec } = require('child_process');
  if (process.platform === 'darwin') {
    // Small delay so the dock window has finished hiding and focus has returned
    // to the previous app. 80ms is enough on most systems.
    setTimeout(() => {
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
        (err) => { if (err) console.warn('[Stash] auto-paste failed:', err.message); });
    }, 80);
  } else if (process.platform === 'win32') {
    setTimeout(() => {
      exec(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
        (err) => { if (err) console.warn('[Stash] auto-paste failed:', err.message); });
    }, 80);
  }
}

// ---------- dock window ----------
// A small popover showing the last ~5 items, appearing at the cursor position.
// Separate from the main drawer — optimized for speed, not browsing.

// Track whether a drag is in progress inside the dock — we suppress blur-hide
// during drag, otherwise the OS drag operation gets cancelled mid-flight.
let dockDragInProgress = false;
let dockDragSafetyTimer = null;

function createDockWindow() {
  dockWindow = new BrowserWindow({
    width: 340,
    height: 460,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  dockWindow.loadFile(path.join(__dirname, 'dock.html'));

  // Hide on blur — UNLESS a drag is in progress (otherwise drag gets cancelled)
  dockWindow.on('blur', () => {
    if (isDev) return;
    if (dockDragInProgress) return;
    dockWindow.hide();
  });

  // If the window is closed (rather than hidden), recreate it so the hotkey
  // keeps working. This was the likely cause of "hotkey stops working after a while"
  // — some paths (e.g. accidental Cmd+W if focus went weird) could close the window
  // without destroying the reference.
  dockWindow.on('closed', () => {
    console.log('[Stash] dock window closed — will recreate on next toggle');
    dockWindow = null;
  });
}

function ensureDockWindow() {
  if (!dockWindow || dockWindow.isDestroyed()) {
    console.log('[Stash] recreating dock window');
    createDockWindow();
  }
  return dockWindow;
}

function toggleDock() {
  const win = ensureDockWindow();
  if (!win) {
    console.warn('[Stash] toggleDock: no window available');
    return;
  }

  if (win.isVisible()) {
    win.hide();
    return;
  }

  // Position near the cursor, but keep the window fully on-screen.
  // On multi-monitor setups, getCursorScreenPoint returns global coordinates
  // and getDisplayNearestPoint finds the correct display's work area.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea;
  const winW = 340;
  const winH = 460;

  // Anchor so the cursor sits near the top-left of the popover, offset slightly
  let x = cursor.x + 12;
  let y = cursor.y + 12;

  // Keep inside display bounds (flip to the other side of cursor if overflow)
  if (x + winW > workArea.x + workArea.width) x = cursor.x - winW - 12;
  if (y + winH > workArea.y + workArea.height) y = cursor.y - winH - 12;
  if (x < workArea.x) x = workArea.x + 8;
  if (y < workArea.y) y = workArea.y + 8;

  // Extra safety: clamp to the actual display even if our math went wrong
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - winW));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - winH));

  console.log(`[Stash] showing dock at (${Math.round(x)}, ${Math.round(y)}) on display ${display.id}`);

  win.setPosition(Math.round(x), Math.round(y));
  win.show();
  win.focus();

  // Send fresh data (dock shows latest 5, pinned first if any)
  refreshDock();
}

function refreshDock() {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  // Send pinned and recent as separate arrays so the renderer can render
  // them as two distinct sections (pinned collapsible, recent capped at 10).
  dockWindow.webContents.send('dock:items', {
    pinned: pinned.slice(),
    recent: history.slice(0, 10),
  });
}

// ---------- clipboard watcher ----------
// ---------- macOS screenshots ----------
// On Windows the usual screenshot gesture puts the picture straight on the
// clipboard, so Stash sees it like any other copy. On macOS the default
// (⌘⇧3 / ⌘⇧4 / ⌘⇧5) writes a file and never touches the clipboard — you have
// to remember to hold Ctrl as well. So the screenshots people actually take
// are the ones Stash never sees. Watching where macOS puts them closes that
// gap without asking anyone to change a habit.
//
// On by default, unlike auto-paste. The two look similar — both macOS-only,
// both needing a permission — but they are not the same bargain. Auto-paste
// changes what happens when you click something; this only decides whether a
// screenshot you already took is somewhere you can find it, which is what the
// app does with everything else you copy. Leaving it off meant the default
// experience on a Mac was the broken one, and the feature existed only for
// people who went looking for it.
//
// The cost is a permission prompt near first launch. The Info.plist string
// says plainly what it is for, and refusing it costs nothing: the watcher
// fails to read the folder, logs, and the rest of the app carries on.

let screenshotWatcher = null;
const seenShots = new Set();
const SHOT_EXT = /\.(png|jpg|jpeg|gif|tiff|heic|pdf)$/i;

// Where macOS drops screenshots, and what it calls them — both are settable by
// the user through `defaults`, so read rather than assume. An unset key exits
// non-zero, which is the signal to use the documented default.
function screenshotLocation() {
  const readPref = (key, fallback) => {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('defaults', ['read', 'com.apple.screencapture', key],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const value = (out || '').trim();
      return value || fallback;
    } catch (_) {
      return fallback;
    }
  };
  const dir = readPref('location', path.join(os.homedir(), 'Desktop'));
  return {
    dir: dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir,
    prefix: readPref('name', 'Screenshot'),
  };
}

// macOS writes the file only once its floating thumbnail has finished, and
// writes it in one go rather than growing it — but a watcher can still see the
// entry before the bytes land. Wait for the size to hold steady before reading,
// or we hash a half-written PNG and store a broken clip.
function whenFileSettles(filepath, done) {
  let last = -1;
  let tries = 0;
  const tick = () => {
    let size;
    try {
      size = fs.statSync(filepath).size;
    } catch (_) {
      return; // vanished again — a preview file, or the user undid the shot
    }
    if (size > 0 && size === last) return done();
    if (++tries > 40) return; // ~8s; something else is writing this file
    last = size;
    setTimeout(tick, 200);
  };
  setTimeout(tick, 200);
}

function handleNewScreenshot(dir, filename) {
  if (!filename || !SHOT_EXT.test(filename)) return;
  const filepath = path.join(dir, filename);
  if (seenShots.has(filepath)) return;
  seenShots.add(filepath);

  whenFileSettles(filepath, () => {
    // Pausing capture has to mean pausing all of it, not just the clipboard.
    if (isPaused) return;
    try {
      const png = nativeImage.createFromPath(filepath).toPNG();
      if (png && png.length) ingestImage(png);
    } catch (err) {
      console.error('[Stash] could not read screenshot:', err.message);
    }
  });
}

function stopScreenshotWatcher() {
  if (!screenshotWatcher) return;
  try { screenshotWatcher.close(); } catch (_) {}
  screenshotWatcher = null;
  seenShots.clear();
}

function startScreenshotWatcher() {
  stopScreenshotWatcher();
  if (process.platform !== 'darwin' || !settings.watchScreenshots) return;

  const { dir, prefix } = screenshotLocation();
  if (!fs.existsSync(dir)) {
    console.warn('[Stash] screenshot folder not found:', dir);
    return;
  }

  // Everything already sitting there predates this watcher. Without this the
  // first event would drag in whatever the folder happens to contain.
  try {
    fs.readdirSync(dir).forEach(f => seenShots.add(path.join(dir, f)));
  } catch (err) {
    console.error('[Stash] cannot read screenshot folder:', err.message);
    return;
  }

  try {
    screenshotWatcher = fs.watch(dir, (_event, filename) => {
      if (!filename) return;
      // Only files macOS named as a screenshot — not everything that lands on
      // a Desktop that people also use as a working folder.
      if (prefix && !filename.startsWith(prefix)) return;
      handleNewScreenshot(dir, filename);
    });
    console.log(`[Stash] watching for screenshots in ${dir}`);
  } catch (err) {
    console.error('[Stash] could not watch screenshot folder:', err.message);
  }
}

// One picture, one path in. The clipboard poller and the macOS screenshot
// watcher both land here, so a screenshot behaves exactly like a copied image —
// same de-duplication, same promote-on-recopy, same session collection.
// Returns the clip's signature, or null if the buffer wasn't an image.
function ingestImage(png) {
  if (!png || !png.length) return null;
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) return null;

  const sig = 'img:' + hash(png);

  // If the same picture is already pinned, just bump it rather than making a
  // second copy of it in history.
  const pinnedIdx = pinned.findIndex(p => p.id === sig);
  if (pinnedIdx > -1) {
    const existing = pinned.splice(pinnedIdx, 1)[0];
    existing.pinnedAt = Date.now();
    pinned.unshift(existing);
    savePinned();
    // seeing it again counts as copying it, so a live session takes it too
    broadcastPromote(existing, collectIfActive(existing));
    return sig;
  }

  const existingIdx = history.findIndex(h => h.id === sig);
  if (existingIdx > -1) {
    const existing = history.splice(existingIdx, 1)[0];
    existing.ts = Date.now();
    history.unshift(existing);
    broadcastPromote(existing, collectIfActive(existing));
    return sig;
  }

  const size = img.getSize();
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
  return sig;
}

function pollClipboard() {
  if (isPaused) {
    rememberPausedClipboard();
    return;
  }
  if (shouldIgnorePausedClipboard()) return;

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
          ingestImage(png);
          return;
        }
      }
    }

    const text = clipboard.readText();
    if (!text) return;
    const styled = readStyled();
    // Formatting is part of what was copied: the same sentence in bold and in
    // italic are different clips, and hashing only the plain text made the
    // second one look like a re-copy of the first and silently lose its styling.
    const sig = 'txt:' + hash(Buffer.from(text + (styled.html || '') + (styled.rtf || '')));
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
      // copying it again counts as copying it, so a live session takes it too
      broadcastPromote(existing, collectIfActive(existing));
      return;
    }

    // Promote-on-recopy for text (history)
    const existingIdx = history.findIndex(h => h.id === sig);
    if (existingIdx > -1) {
      const existing = history.splice(existingIdx, 1)[0];
      existing.ts = Date.now();
      history.unshift(existing);
      // copying it again counts as copying it, so a live session takes it too
      broadcastPromote(existing, collectIfActive(existing));
      return;
    }

    addEntry({
      id: sig,
      type: sniffType(text),
      content: text,
      ts: Date.now(),
      ...styled,
    });
  } catch (err) {
    console.error('poll error:', err);
  }
}

// ---------- styled text ----------
// Word, Excel and most web pages put tens or hundreds of kilobytes of HTML on
// the clipboard for a single paragraph — style blocks, base64 images, editor
// scaffolding. Pinned clips, prompts and sessions all persist to disk and never
// shrink, so anything past the cap is dropped and the clip stays plain rather
// than quietly turning the store into a formatting archive.
const STYLED_MAX = 256 * 1024;

function readStyled() {
  const out = {};
  try {
    const html = clipboard.readHTML();
    if (html && html.length <= STYLED_MAX) out.html = html;
    else if (html) console.log(`[Stash] dropped ${(html.length / 1024).toFixed(0)}KB of HTML — over the cap`);
  } catch (_) { /* a clipboard without HTML is the normal case */ }
  try {
    // RTF is what native macOS apps and Office read back most faithfully
    const rtf = clipboard.readRTF();
    if (rtf && rtf.length <= STYLED_MAX) out.rtf = rtf;
  } catch (_) {}
  return out;
}

// Put a clip back on the clipboard with whatever flavours it kept. `plain`
// forces text only, which is the paste-without-formatting path.
function writeClip(entry, plain) {
  if (entry.type === 'img' && entry.filepath && fs.existsSync(entry.filepath)) {
    clipboard.writeImage(nativeImage.createFromPath(entry.filepath));
    return;
  }
  if (!plain && (entry.html || entry.rtf)) {
    const payload = { text: entry.content };
    if (entry.html) payload.html = entry.html;
    if (entry.rtf) payload.rtf = entry.rtf;
    clipboard.write(payload);
    return;
  }
  clipboard.writeText(entry.content);
}

// An active session collects whatever is copied, before history's cap can age
// the entry out from under it. Returns the session's own copy so it can travel
// with the notification: the drawer keeps its own list of session clips, and
// telling it only about the history entry left the session looking empty until
// something else forced a full state broadcast.
function collectIfActive(entry) {
  const id = settings.activeSessionId;
  if (!id || !sessions.some(s => s.id === id)) return null;
  return addToSession(entry, id) ? sessionClips[0] : null;
}

function broadcastPromote(entry, collected) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clip:promoted', entry, collected || null);
  }
  refreshTrayMenu();
}

function addEntry(entry) {
  const collected = collectIfActive(entry);
  if (typeof recordCaptureStats === 'function') recordCaptureStats(collected);

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
    mainWindow.webContents.send('clip:new', entry, collected);
  }
  if (dockWindow && dockWindow.isVisible()) refreshDock();
  refreshTrayMenu();
}

// ---------- ipc ----------
ipcMain.handle('history:get', () => ({ history, pinned, ...sessionState() }));

ipcMain.handle('appearance:get', () => ({
  choice: settings.appearance || 'system',
  dark: nativeTheme.shouldUseDarkColors,
}));
ipcMain.handle('appearance:set', (_e, choice) => setAppearance(choice));

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
}

ipcMain.handle('sessions:create', (_e, name) => {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) return false;
  const session = {
    id: crypto.randomUUID ? crypto.randomUUID() : 'ses-' + Date.now(),
    name: clean,
    createdAt: Date.now(),
  };
  sessions.unshift(session);
  // creating one is how you start collecting into it
  settings.activeSessionId = session.id;
  collectionStats.collectionsCreated += 1;
  collectionStats.activeChanges += 1;
  saveSessions();
  saveSettings();
  saveCollectionStats();
  refreshTrayMenu();
  broadcastState();
  return session.id;
});

ipcMain.handle('sessions:rename', (_e, id, name) => {
  const session = sessions.find(s => s.id === id);
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!session || !clean) return false;
  session.name = clean;
  saveSessions();
  refreshTrayMenu();
  broadcastState();
  return true;
});

ipcMain.handle('sessions:delete', (_e, id) => {
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return false;
  sessions.splice(idx, 1);
  const orphans = sessionClips.filter(c => c.sessionId === id);
  sessionClips = sessionClips.filter(c => c.sessionId !== id);
  orphans.forEach(dropSessionImage);
  if (settings.activeSessionId === id) {
    settings.activeSessionId = null;
    saveSettings();
  }
  saveSessions();
  refreshTrayMenu();
  broadcastState();
  return true;
});

ipcMain.handle('sessions:setActive', (_e, id) => {
  return setActiveSession(id);
});

ipcMain.handle('collections:stats', () => collectionStatsSnapshot());

// add or remove a clip that already exists, from anywhere in the drawer
ipcMain.handle('session:add', (_e, clipId, sessionId) => {
  const entry = [...history, ...pinned, ...sessionClips].find(c => c.id === clipId);
  if (!entry) return false;
  const ok = addToSession(entry, sessionId);
  if (ok) broadcastState();
  return ok;
});

ipcMain.handle('session:remove', (_e, clipId, sessionId) => {
  const ok = removeFromSession(clipId, sessionId);
  if (ok) broadcastState();
  return ok;
});

// ---------- manual order ----------
// `ids` is the new relative order of some subset of `list` — the rows the
// drawer was actually showing. The drawer filters (search, tags, prompts vs
// pinned), so the subset is rarely the whole array: the ids are reassigned to
// the slots they already occupy between them, which leaves everything filtered
// out sitting exactly where it was. Anything unknown is ignored rather than
// dropped, so a stale drag can't delete a clip.
function reorderWithin(list, ids) {
  const wanted = ids.filter(id => list.some(c => c.id === id));
  if (wanted.length < 2) return false;
  const slots = [];
  const held = new Set(wanted);
  list.forEach((c, i) => { if (held.has(c.id)) slots.push(i); });
  const byId = new Map(list.map(c => [c.id, c]));
  const before = slots.map(i => list[i].id).join();
  wanted.forEach((id, k) => { list[slots[k]] = byId.get(id); });
  return before !== wanted.join();
}

ipcMain.handle('order:pinned', (_e, ids) => {
  if (!Array.isArray(ids)) return false;
  const moved = reorderWithin(pinned, ids);
  if (moved) { savePinned(); broadcastState(); }
  return moved;
});

ipcMain.handle('order:session', (_e, sessionId, ids) => {
  if (!Array.isArray(ids) || !sessions.some(s => s.id === sessionId)) return false;
  // a session's clips share one array with every other session's, so the ids
  // are matched against that session's slots only
  const moved = reorderWithin(sessionClips, ids);
  if (moved) { saveSessions(); broadcastState(); }
  return moved;
});
ipcMain.handle('paused:get', () => isPaused);
ipcMain.handle('paused:set', (_e, v) => { setPaused(!!v); return isPaused; });

ipcMain.handle('clip:pin', (_e, id) => {
  const ok = pinItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
  return ok;
});

ipcMain.handle('clip:unpin', (_e, id) => {
  const ok = unpinItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
  return ok;
});

ipcMain.handle('clip:prompt', (_e, id) => {
  const ok = promptItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
  return ok;
});

// A clip's headline is derived from what it is: an image says how big it is, a
// snippet shows its first line. That works while you can still remember copying
// it, and stops working for exactly the things worth keeping — a pinned
// screenshot called "1000x1500" tells you nothing a week later.
//
// A name, when set, replaces that headline. The derived label isn't thrown
// away: it moves down to the meta line, so nothing that was visible before is
// lost. Clearing the name puts things back as they were.
//
// The same clip id can sit in history, in pinned, and in any number of
// sessions at once. Renaming one copy and not the others would show the same
// picture under two different names in one drawer, so every copy is updated.
function renameClip(id, name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 120) : '';
  let touched = false;
  let inPinned = false;
  let inSessions = false;

  const apply = (entry) => {
    if (clean) entry.name = clean;
    else delete entry.name;   // an empty name is a reset, not a blank title
    touched = true;
  };

  history.forEach(h => { if (h.id === id) apply(h); });
  pinned.forEach(p => { if (p.id === id) { apply(p); inPinned = true; } });
  sessionClips.forEach(s => { if (s.id === id) { apply(s); inSessions = true; } });

  // Only the kept things are written down; ordinary history is memory-only, so
  // a name on an unpinned clip lives exactly as long as the clip does.
  if (inPinned) savePinned();
  if (inSessions) saveSessions();
  return touched;
}

ipcMain.handle('clip:rename', (_e, id, name) => {
  const ok = renameClip(id, name);
  if (ok) {
    refreshTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
    }
    if (dockWindow && dockWindow.isVisible()) refreshDock();
  }
  return ok;
});

ipcMain.handle('prompt:update', (_e, id, patch) => {
  const ok = updatePrompt(id, patch);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
  return ok;
});

ipcMain.handle('clip:unprompt', (_e, id) => {
  const ok = unpromptItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
  return ok;
});

// Dock selection: copy the item, hide the dock, optionally auto-paste
ipcMain.handle('dock:pick', (_e, entry) => {
  lastSig = entry.id;
  writeClip(entry);
  if (dockWindow) dockWindow.hide();
  if (settings.autoPasteFromDock) tryAutoPaste();
  return true;
});

ipcMain.handle('dock:hide', () => {
  if (dockWindow) dockWindow.hide();
});

ipcMain.handle('dock:openMain', () => {
  if (dockWindow) dockWindow.hide();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// Dock drag state — renderer tells us when a drag starts/ends so we can
// suppress blur-hide during the drag.
ipcMain.on('dock:dragStart', () => {
  dockDragInProgress = true;
  // Safety timer: if dragEnd never fires (drag cancelled in some weird way),
  // clear the flag after 8 seconds so the dock isn't stuck open.
  if (dockDragSafetyTimer) clearTimeout(dockDragSafetyTimer);
  dockDragSafetyTimer = setTimeout(() => {
    dockDragInProgress = false;
    if (dockWindow && dockWindow.isVisible()) dockWindow.hide();
  }, 8000);
});

ipcMain.on('dock:dragEnd', () => {
  dockDragInProgress = false;
  if (dockDragSafetyTimer) { clearTimeout(dockDragSafetyTimer); dockDragSafetyTimer = null; }
  // After the drag completes, hide the dock (as if user had clicked an item)
  if (dockWindow && dockWindow.isVisible()) dockWindow.hide();
});

// Drawer drag state — renderer tells us when a drag starts/ends so blur-hide
// is suppressed during the OS drag. UNLIKE the dock, we do NOT hide the drawer
// on dragEnd: the drawer is the browsing surface and users frequently drag
// several items in a row. Closing it after each drop forced them to re-trigger
// the hotkey for every clip.
ipcMain.on('drawer:dragStart', () => {
  drawerDragInProgress = true;
  // Safety timer: if dragEnd never fires (drag cancelled in some weird way,
  // window unfocused for a long time, etc.), clear the flag after 8s so the
  // drawer can hide normally again on the next blur.
  if (drawerDragSafetyTimer) clearTimeout(drawerDragSafetyTimer);
  drawerDragSafetyTimer = setTimeout(() => {
    drawerDragInProgress = false;
  }, 8000);
});

ipcMain.on('drawer:dragEnd', () => {
  drawerDragInProgress = false;
  if (drawerDragSafetyTimer) { clearTimeout(drawerDragSafetyTimer); drawerDragSafetyTimer = null; }
  // Intentionally do NOT hide the drawer here — keep it open so the user
  // can drag additional items without re-opening with ⌘⇧V every time.
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  return settings;
});

ipcMain.handle('clip:write', (_e, entry, plain) => {
  lastSig = entry.id;
  writeClip(entry, plain);
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

// Delete means gone from Stash, not gone from the list you happen to be
// looking at. A clip can sit in history, in pinned, and in any number of
// sessions at once — removing one copy and unlinking the picture left the
// others pointing at a file that no longer existed.
//
// Taking a clip out of a single session is a different act, and has its own
// door: the session button on the row.
ipcMain.handle('clip:delete', (_e, id) => {
  const paths = new Set();
  let found = false;
  const take = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].id !== id) continue;
      if (arr[i].filepath) paths.add(arr[i].filepath);
      arr.splice(i, 1);
      found = true;
    }
  };

  const hadPinned = pinned.some(p => p.id === id);
  const hadSession = sessionClips.some(s => s.id === id);
  take(history);
  take(pinned);
  take(sessionClips);
  if (!found) return false;

  // The same picture can back several clips, so a file only goes once nothing
  // at all still points at it.
  const remaining = [...history, ...pinned, ...sessionClips];
  for (const fp of paths) {
    if (remaining.some(c => c.filepath === fp)) continue;
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) { /* a leftover beats a crash */ }
  }

  if (hadPinned) savePinned();
  if (hadSession) saveSessions();
  refreshTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
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

// Put a clip on disk so the OS drag can carry it. Images already have a real
// file; everything else becomes a .txt. `index` disambiguates a multi-drag of
// clips that would otherwise land on the same name in the same millisecond.
function materializeForDrag(entry, index = 0) {
  if (entry.type === 'img' && entry.filepath) return entry.filepath;
  const safe = (entry.content || '').slice(0, 40).replace(/[^\w-]+/g, '_') || 'clip';
  const filepath = path.join(TMP_DIR, `${safe}-${Date.now()}-${index}.txt`);
  fs.writeFileSync(filepath, entry.content);
  return filepath;
}

// The drag cursor can only show one thumbnail, so use the first file that
// actually renders as an image — a text-only drag falls back to empty, which
// is what the single-file path has always done.
function dragIcon(paths) {
  for (const p of paths) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img.resize({ width: 64 });
  }
  return nativeImage.createEmpty();
}

ipcMain.on('ondragstart', (event, entry) => {
  try {
    const filepath = materializeForDrag(entry);
    event.sender.startDrag({ file: filepath, icon: dragIcon([filepath]) });
  } catch (err) {
    console.error('startDrag failed:', err);
  }
});

// Multi-select drag — one gesture, N files. Electron's `files` (plural) hands
// the target a real multi-file drop, which is what Figma's canvas and AI chat
// inputs expect; they treat it exactly like a multi-file pick from Explorer.
ipcMain.on('ondragstart:multi', (event, entries, iconDataUrl) => {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const files = [];
  entries.forEach((entry, i) => {
    try {
      files.push(materializeForDrag(entry, i));
    } catch (err) {
      // one bad clip shouldn't sink the whole drag
      console.error('skipping clip in multi-drag:', err);
    }
  });
  if (files.length === 0) return;

  // The renderer rasterizes the visible stack and sends it over, so the drag
  // cursor is the deck the user just built. Fall back to the old first-image
  // icon if that didn't arrive in time.
  let icon = null;
  if (typeof iconDataUrl === 'string' && iconDataUrl.startsWith('data:image/')) {
    try {
      const img = nativeImage.createFromDataURL(iconDataUrl);
      if (!img.isEmpty()) icon = img;
    } catch (err) {
      console.error('stack icon decode failed:', err);
    }
  }

  try {
    event.sender.startDrag({ files, icon: icon || dragIcon(files) });
  } catch (err) {
    console.error('multi startDrag failed:', err);
  }
});

// ---------- OCR ----------
// Pulling text out of a screenshot is only useful if the result comes back as
// separate pieces. A dashboard has a dozen unrelated labels in it; handing back
// one blob of text just moves the problem. So we take the words the engine
// finds and cluster them into visual blocks, the way a person reads the image.
//
// The OS engines do the reading. A bundled wasm engine was tried first and read
// 6 of 26 words on a dark marketing screenshot where Windows read 22 — small,
// letter-spaced or low-contrast text defeated it, and no amount of upscaling,
// inverting or thresholding moved that number.

// Both engines are asked for words with boxes; everything downstream — the
// column splitting and block clustering — is engine-agnostic and unchanged.
//
// Windows OCR is driven through PowerShell because the API is WinRT, which has
// no Node binding. The script is written to a temp file rather than passed as a
// command line: it is long, and quoting it through two shells is a trap.
const WIN_OCR_PS = `
$ErrorActionPreference = 'Stop'
$img = $args[0]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Foundation, ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $t.Wait(60000)
  $t.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($img)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output '{"error":"no OCR language is installed"}'; exit 0 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$words = New-Object System.Collections.ArrayList
$li = 0
foreach ($line in $result.Lines) {
  foreach ($w in $line.Words) {
    $r = $w.BoundingRect
    $null = $words.Add([pscustomobject]@{
      text = $w.Text
      line = $li
      x0 = [int]$r.X; y0 = [int]$r.Y
      x1 = [int]($r.X + $r.Width); y1 = [int]($r.Y + $r.Height)
    })
  }
  $li = $li + 1
}
[pscustomobject]@{ width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; words = $words } |
  ConvertTo-Json -Depth 4 -Compress
`;

let winOcrScriptPath = null;
function winOcrScript() {
  if (!winOcrScriptPath) {
    winOcrScriptPath = path.join(TMP_DIR, 'stash-win-ocr.ps1');
    fs.writeFileSync(winOcrScriptPath, WIN_OCR_PS, 'utf8');
  }
  return winOcrScriptPath;
}

// Reads text out of an image using whatever the operating system provides.
// Resolves to { width, height, words: [{ text, x0, y0, x1, y1 }] }.
function runNativeOcr(filePath) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winOcrScript(), filePath];
    } else if (process.platform === 'darwin') {
      cmd = path.join(process.resourcesPath || path.join(__dirname, '..', 'build'), 'stash-ocr');
      args = [filePath];
    } else {
      reject(new Error('text extraction needs macOS or Windows'));
      return;
    }

    // a page of dense text is a lot of JSON, so the default buffer is not enough
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().trim().slice(0, 200)));
      let parsed;
      try {
        parsed = JSON.parse((stdout || '').toString().trim());
      } catch (_) {
        return reject(new Error('could not read the OCR result'));
      }
      if (parsed.error) return reject(new Error(parsed.error));
      // one word comes back as an object, not an array, from ConvertTo-Json
      const words = Array.isArray(parsed.words) ? parsed.words : (parsed.words ? [parsed.words] : []);
      resolve({ width: parsed.width, height: parsed.height, words });
    });
  });
}

// Normalize whatever the engine returned into flat words with boxes.
// Words, not lines: an engine will happily run a line straight across three
// side-by-side cards, and once it has done that the columns can't be pulled
// apart again. Starting from words lets us decide where a line really ends.
function wordsFrom(data) {
  const out = [];
  (data.words || []).forEach((w) => {
    const text = (w.text || '').trim();
    if (!text) return;
    const nums = [w.x0, w.y0, w.x1, w.y1];
    if (nums.some(n => typeof n !== 'number' || !isFinite(n))) return;
    if (w.x1 <= w.x0 || w.y1 <= w.y0) return;
    out.push({
      text,
      // which line the engine put this word on, if it said
      line: typeof w.line === 'number' ? w.line : -1,
      x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1,
    });
  });
  return out;
}

// Words -> runs. Group words sharing a baseline, then cut a run wherever the
// horizontal gap is far wider than ordinary word spacing — that gap is a column
// boundary, a table cell edge, or the space between two unrelated labels.
function runsFromWords(words) {
  if (!words.length) return [];

  // Prefer the engine's own line grouping. It knows that a run of widely
  // letter-spaced capitals is one line; rebuilding that from geometry means
  // guessing whether a gap is tracking or a word break, and heavily tracked
  // marketing type sits right on that boundary.
  const rows = [];
  const engineLines = new Map();
  const hasLines = words.some(w => w.line >= 0);

  if (hasLines) {
    for (const w of words) {
      if (!engineLines.has(w.line)) engineLines.set(w.line, { words: [] });
      engineLines.get(w.line).words.push(w);
    }
    rows.push(...engineLines.values());
  } else {
    // no line information: fall back to grouping by baseline. Every threshold
    // is relative to the words being compared, never to a figure for the image
    // as a whole — a screenshot routinely carries a 70px headline and a 12px
    // caption, and one global measure fits neither.
    for (const w of [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)) {
      const mid = (w.y0 + w.y1) / 2;
      const h = w.y1 - w.y0;
      const row = rows.find(r => Math.abs(r.mid - mid) < Math.max(h, r.h) * 0.6);
      if (row) {
        row.words.push(w);
        row.mid = (row.mid * (row.words.length - 1) + mid) / row.words.length;
        row.h = Math.max(row.h, h);
      } else {
        rows.push({ mid, h, words: [w] });
      }
    }
  }

  // Split a line only where the gap is far too wide to be spacing of any kind —
  // that is a column edge or two unrelated labels sharing a baseline. The engine
  // already decided the ordinary word breaks, so this stays conservative.
  const splitFactor = hasLines ? 2.2 : 1.2;
  const runs = [];
  for (const row of rows) {
    const sorted = row.words.sort((a, b) => a.x0 - b.x0);
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x0 - sorted[i - 1].x1;
      const localH = Math.max(sorted[i].y1 - sorted[i].y0, sorted[i - 1].y1 - sorted[i - 1].y0);
      if (gap > localH * splitFactor) {
        runs.push(current);
        current = [];
      }
      current.push(sorted[i]);
    }
    runs.push(current);
  }

  return runs.filter(r => r.length).map(r => ({
    text: r.map(w => w.text).join(' '),
    x0: Math.min(...r.map(w => w.x0)),
    y0: Math.min(...r.map(w => w.y0)),
    x1: Math.max(...r.map(w => w.x1)),
    y1: Math.max(...r.map(w => w.y1)),
  }));
}

// Group lines into blocks: a line joins the block above it when it sits close
// enough vertically and shares horizontal space with it. Everything else starts
// a new block. Gaps are measured against the median line height, so the same
// rule works on a dense table and on a poster.
function clusterLines(lines) {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  const heights = sorted.map(l => l.y1 - l.y0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 12;

  const groups = [];
  for (const line of sorted) {
    const lineH = line.y1 - line.y0;
    let target = null;
    for (const g of groups) {
      const gap = line.y0 - g.y1;
      if (gap < 0) continue;
      // Measure the gap against the taller of the two pieces rather than one
      // global median: a 40px stat sits further from its 15px label than two
      // lines of body copy sit from each other, and both are still one block.
      if (gap > Math.max(lineH, g.lastH) * 0.95) continue;
      const overlap = Math.min(line.x1, g.x1) - Math.max(line.x0, g.x0);
      const narrower = Math.min(line.x1 - line.x0, g.x1 - g.x0) || 1;
      // also local: what counts as "the same left edge" scales with the text
      const alignedLeft = Math.abs(line.x0 - g.x0) < Math.max(lineH, g.lastH) * 0.6;
      if (overlap / narrower > 0.15 || alignedLeft) { target = g; break; }
    }
    if (target) {
      target.lines.push(line);
      target.x0 = Math.min(target.x0, line.x0);
      target.y0 = Math.min(target.y0, line.y0);
      target.x1 = Math.max(target.x1, line.x1);
      target.y1 = Math.max(target.y1, line.y1);
      target.lastH = lineH;
    } else {
      groups.push({ lines: [line], x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, lastH: lineH });
    }
  }

  return groups
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map((g, i) => ({
      id: 'blk' + i,
      text: g.lines.map(l => l.text).join('\n'),
      lineCount: g.lines.length,
      bbox: { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 },
    }));
}

// ---------- colours out of an image ----------
// The same bargain as the text side: a picture goes in, a small set of things
// you can act on comes out.
//
// Not "count the most common pixel values" — a screenshot is thousands of
// near-identical shades of one background, so counting raw values returns
// eight versions of grey and calls it a palette. Median cut splits colour
// space itself, so each swatch stands for a region of the image rather than
// an exact value that happened to repeat.

// Electron hands back BGRA. Striding over the buffer keeps a 4000×3000 photo
// to the same work as a small screenshot — proportions between colours survive
// sampling long before the sample gets this coarse.
function samplePixels(bitmap, maxSamples) {
  const total = Math.floor(bitmap.length / 4);
  const step = Math.max(1, Math.floor(total / (maxSamples || 20000)));
  const out = [];
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if (bitmap[o + 3] < 128) continue; // a transparent pixel isn't a colour
    out.push([bitmap[o + 2], bitmap[o + 1], bitmap[o]]);
  }
  return out;
}

// Collapse to unique colours before splitting anything. A UI screenshot is a
// handful of exact values repeated thousands of times, and a sampled photo is
// at most a few thousand entries — either way this is far smaller than the
// pixel list, and it lets a split be weighted by how much of the picture each
// colour actually covers.
function histogramOf(pixels) {
  const counts = new Map();
  for (const p of pixels) {
    const key = (p[0] << 16) | (p[1] << 8) | p[2];
    const hit = counts.get(key);
    if (hit) hit.count++;
    else counts.set(key, { r: p[0], g: p[1], b: p[2], count: 1 });
  }
  return [...counts.values()];
}

// Repeatedly take the box of colours with the widest spread and cut it in two
// along that spread's own axis. Each box settles onto one region of colour.
function medianCut(entries, want) {
  if (!entries.length) return [];
  const CH = ['r', 'g', 'b'];
  const boxes = [entries];
  while (boxes.length < want) {
    let target = -1, axis = 'r', widest = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      for (const ch of CH) {
        let lo = 255, hi = 0;
        for (let p = 0; p < box.length; p++) {
          const v = box[p][ch];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > widest) { widest = hi - lo; target = i; axis = ch; }
      }
    }
    // every remaining box is a single colour — splitting further buys nothing
    if (target < 0 || widest <= 0) break;

    // Cut where half the *pixels* lie, not half the distinct colours. Splitting
    // by colour count lets one stray pixel weigh as much as the background.
    const sorted = boxes[target].slice().sort((a, b) => a[axis] - b[axis]);
    const total = sorted.reduce((n, e) => n + e.count, 0);
    // Stop one short of the end: both sides have to keep at least one colour,
    // or the "split" hands everything back to one side and the box never
    // divides — two colours in, one swatch out.
    const last = sorted.length - 2;
    let acc = 0, cut = 0;
    for (; cut < last; cut++) {
      acc += sorted[cut].count;
      if (acc * 2 >= total) break;
    }
    boxes.splice(target, 1, sorted.slice(0, cut + 1), sorted.slice(cut + 1));
  }
  return boxes.filter(b => b.length);
}

function hexOf(r, g, b) {
  return '#' + [r, g, b]
    .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('').toUpperCase();
}

// Rec. 601 weighting, so the renderer knows whether to print the hex over the
// swatch in ink or in white. Green reads far brighter than blue at the same value.
function luminanceOf(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// HSL saturation — how much colour a value carries, independent of how dark it
// is. #0A0A0A and #1A1A1A both score 0; a vivid red scores 1.
function saturationOf(r, g, b) {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  if (mx === mn) return 0;
  const l = (mx + mn) / 2;
  return l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}

// Hue in degrees, or -1 for a grey. Used to stop a palette coming back as six
// versions of the same red while the greens and blues in the picture go unlisted.
function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  if (!d) return -1;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// Shortest way round the colour wheel. Greys have no hue to crowd, so they
// never block anything.
function hueGap(a, b) {
  if (a.hue < 0 || b.hue < 0) return 360;
  const d = Math.abs(a.hue - b.hue);
  return Math.min(d, 360 - d);
}

// Boxes either side of a cut can land on colours nobody would call different.
// Merging them keeps the list to colours worth showing separately, and hands
// the merged share to the more populous of the pair rather than averaging the
// two into a colour that appears nowhere in the picture.
function extractPalette(pixels, want) {
  const target = want || 8;

  // Cut far past the number of swatches we mean to show. A poster that is 90%
  // dark background and 10% vivid tiles spends every early cut carving up the
  // background, so stopping at eight boxes returns eight greys and none of the
  // colour anyone opened the panel to find. Over-segmenting gives the small
  // vivid regions boxes of their own; picking between them comes after.
  const boxes = medianCut(histogramOf(pixels), Math.max(32, target * 6));
  const total = pixels.length || 1;

  const swatches = boxes.map(box => {
    // The swatch is the colour that actually dominates the box, never the
    // average of it. Averaging a box that still straddles two clusters reports
    // a colour that appears nowhere in the picture — red and blue together
    // come back as purple, and a designer copies a hex the image never had.
    let best = box[0], count = 0;
    for (const e of box) {
      count += e.count;
      if (e.count > best.count) best = e;
    }
    return { r: best.r, g: best.g, b: best.b, count };
  }).sort((a, b) => b.count - a.count);

  const kept = [];
  for (const s of swatches) {
    const near = kept.find(k => {
      const dr = k.r - s.r, dg = k.g - s.g, db = k.b - s.b;
      return dr * dr + dg * dg + db * db < 700; // ~26 apart in RGB
    });
    if (near) { near.count += s.count; continue; }
    kept.push(s);
  }

  // Coverage alone picks the background every time. What makes a picture
  // recognisable is usually the small saturated part of it, so rank on three
  // things: how much of the image it is, how much colour it carries, and how
  // near mid-tone it sits. The quarter-power flattens coverage enough that a
  // 1% vivid tile can beat a 30% grey, while still keeping a large flat colour
  // ahead of a stray pixel. Without the mid-tone term a muddy dark brown wins
  // over a bright green, because saturation alone can't tell them apart.
  for (const s of kept) {
    s.share = s.count / total;
    s.sat = saturationOf(s.r, s.g, s.b);
    s.hue = hueOf(s.r, s.g, s.b);
    s.luma = luminanceOf(s.r, s.g, s.b);
    const punch = Math.max(0.15, 1 - Math.abs(s.luma - 0.5) * 1.6);
    s.score = Math.pow(s.share, 0.22) * (0.15 + s.sat) * punch;
  }

  // Whatever the image is mostly made of always earns its place — a palette
  // that omits the background isn't the palette of that image either. The
  // second ground colour joins it only if it covers enough to be one.
  const FLOOR = 0.0005;
  const byShare = [...kept].sort((a, b) => b.share - a.share);
  const chosen = byShare.slice(0, 1);
  if (byShare[1] && byShare[1].share >= FLOOR) chosen.push(byShare[1]);

  // Then fill on score, refusing anything that would read as a colour already
  // on the list. Same hue *and* much the same lightness is a duplicate — but
  // same hue at a different lightness is not, or a photo shot in one colour
  // would come back as two swatches instead of the ramp it actually is.
  //
  // Anything under a twentieth of a percent is edge antialiasing rather than a
  // colour the picture is made of. Padding the list out with those gives eight
  // swatches where three read "0%" and none of them are in the image to the
  // eye — five true colours is the better answer.
  const ranked = [...kept].sort((a, b) => b.score - a.score);
  for (const s of ranked) {
    if (chosen.length >= target) break;
    if (chosen.includes(s) || s.share < FLOOR) continue;
    const duplicate = s.sat > 0.18 && chosen.some(c =>
      c.sat > 0.18 && hueGap(s, c) < 30 && Math.abs(s.luma - c.luma) < 0.15);
    if (!duplicate) chosen.push(s);
  }

  // Shown most-of-the-image first, so the percentages read in order.
  return chosen.sort((a, b) => b.share - a.share).map(s => ({
    hex: hexOf(s.r, s.g, s.b),
    rgb: [Math.round(s.r), Math.round(s.g), Math.round(s.b)],
    share: s.share,
    light: luminanceOf(s.r, s.g, s.b) > 0.55,
  }));
}

ipcMain.handle('window:expand', (_e, expanded) => setWindowExpanded(!!expanded));

// "Add to prompt" from extracted text — the text was never a clip of its own,
// so there's nothing to promote; make one directly.
ipcMain.handle('prompt:create', (_e, content) => {
  if (typeof content !== 'string' || !content.trim()) return false;
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    type: sniffType(content),
    content,
    ts: Date.now(),
    isPrompt: true,
    promptedAt: Date.now(),
    pinnedAt: Date.now(),
  };
  pinned.unshift(entry);
  savePinned();
  refreshTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, ...sessionState() });
  }
  return true;
});

// A clip can be in history, kept as a pin or a prompt, or sitting in a session
// — and after a restart a session's clips are the only place it still exists.
// Looking in only two of the three is why reading a session's image reported
// the file as missing when it was on disk the whole time.
//
// The same id can appear twice: history's copy points at a temp file that gets
// cleaned up, while the session's copy was moved somewhere permanent. Prefer
// whichever still has its picture.
function findClip(id) {
  const matches = [...history, ...pinned, ...sessionClips].filter(c => c.id === id);
  if (!matches.length) return null;
  return matches.find(c => c.type !== 'img' || (c.filepath && fs.existsSync(c.filepath)))
    || matches[0];
}

// Both readers want the same thing: an image whose file is still there. They
// also want to say which of the two went wrong, rather than blaming the disk
// for a clip that was never found.
function imageClipFor(id) {
  const entry = findClip(id);
  if (!entry) return { error: 'that clip is no longer in Stash' };
  if (entry.type !== 'img') return { error: 'that clip is not an image' };
  if (!entry.filepath || !fs.existsSync(entry.filepath)) {
    return { error: 'that image is no longer on disk' };
  }
  return { entry };
}

ipcMain.handle('ocr:run', async (_e, id) => {
  const found = imageClipFor(id);
  if (found.error) return { ok: false, error: found.error };
  const entry = found.entry;
  const send = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ocr:progress', msg);
  };
  try {
    send({ status: 'recognizing text', progress: 0.2 });
    const data = await runNativeOcr(entry.filepath);
    const blocks = clusterLines(runsFromWords(wordsFrom(data)));
    // The renderer draws boxes over the picture, so it must show the very image
    // OCR read — not entry.dataUrl, which is a 240px preview thumbnail. Box
    // coordinates are in the full image's pixel space, so against the thumbnail
    // they land far outside it. Send the file itself plus the size the
    // coordinates belong to, and let the renderer scale from that.
    const size = nativeImage.createFromPath(entry.filepath).getSize();
    return {
      ok: true,
      blocks,
      raw: blocks.map(b => b.text).join('\n\n'),
      imageUrl: pathToFileURL(entry.filepath).href,
      width: data.width || size.width,
      height: data.height || size.height,
    };
  } catch (err) {
    console.error('[Stash] OCR failed:', err);
    return { ok: false, error: err.message || 'could not read that image' };
  }
});

ipcMain.handle('palette:run', async (_e, id) => {
  const found = imageClipFor(id);
  if (found.error) return { ok: false, error: found.error };
  const entry = found.entry;
  try {
    // Same as OCR: the renderer shows the full image, not entry.dataUrl, which
    // is only a 240px preview.
    const img = nativeImage.createFromPath(entry.filepath);
    const size = img.getSize();
    const colors = extractPalette(samplePixels(img.toBitmap(), 24000), 8);
    if (!colors.length) {
      return { ok: false, error: 'could not read any colour out of that image' };
    }
    return {
      ok: true,
      colors,
      imageUrl: pathToFileURL(entry.filepath).href,
      width: size.width,
      height: size.height,
    };
  } catch (err) {
    console.error('[Stash] palette failed:', err);
    return { ok: false, error: err.message || 'could not read that image' };
  }
});

// ---------- updates ----------
// Stash used to check GitHub's API for a newer tag and, if it found one, send
// the user to the releases page to fetch 90MB by hand. Most people never came
// back from that trip.
//
// electron-updater does the whole thing in the background: it reads the update
// feed electron-builder publishes alongside each release, downloads the new
// version while you carry on working, and swaps it in on the next quit. The
// only thing asked of the user is the restart.
//
// macOS updates through Squirrel, which needs the app to be signed — it is —
// and needs a zip in the release next to the dmg, which the build config now
// produces. Windows updates through NSIS and can fetch only the changed blocks
// rather than the whole installer.

const { autoUpdater } = require('electron-updater');
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// The updater has no business restarting the app underneath someone mid-copy.
// Download quietly, then let them choose the moment.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

let updateState = null; // null | {status, version}

function sendUpdateState(state) {
  updateState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:available', state);
  }
}

autoUpdater.on('update-available', (info) => {
  console.log(`[Stash] update available: ${app.getVersion()} -> ${info.version}`);
  sendUpdateState({ status: 'downloading', version: info.version });
});

autoUpdater.on('download-progress', (p) => {
  // Only the percentage is worth showing; the badge is small.
  sendUpdateState({
    status: 'downloading',
    version: (updateState && updateState.version) || '',
    percent: Math.round(p.percent || 0),
  });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`[Stash] update ready: ${info.version}`);
  sendUpdateState({ status: 'ready', version: info.version });
});

autoUpdater.on('update-not-available', () => {
  console.log(`[Stash] up to date (${app.getVersion()})`);
});

autoUpdater.on('error', (err) => {
  // Offline, rate-limited, or a release without an update feed. Nothing the
  // user can act on, so the badge stays hidden and the app carries on.
  console.log('[Stash] update check failed:', (err && err.message) || err);
});

function checkForUpdate() {
  // A dev run has no update feed to read and no installed copy to replace.
  if (isDev || !app.isPackaged) {
    console.log('[Stash] dev build — skipping update check');
    return;
  }
  autoUpdater.checkForUpdates().catch(() => { /* handled by the error event */ });
}

// The renderer asks for this when someone clicks the badge. Quitting is the
// install: Squirrel and NSIS both swap the files in as the app exits.
ipcMain.handle('update:install', () => {
  if (!updateState || updateState.status !== 'ready') return false;
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});

// So a window opened after the download still learns about it.
ipcMain.handle('update:get', () => updateState);

// Renderer asks us to open a URL in the user's default browser.
ipcMain.handle('shell:openExternal', (_e, url) => {
  // Defensive: only allow opening github.com URLs from this IPC, so a
  // compromised renderer can't trick us into opening arbitrary links.
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com' || u.hostname.endsWith('.github.com')) {
      shell.openExternal(url);
    }
  } catch (_) { /* invalid URL — ignore */ }
});

// ---------- lifecycle ----------
function registerShortcuts() {
  // Always unregister first to be safe — prevents accidental duplicate handlers
  try { globalShortcut.unregisterAll(); } catch (_) {}

  const drawerReg = globalShortcut.register('CommandOrControl+Shift+V', toggleWindow);
  const dockReg = globalShortcut.register('CommandOrControl+Shift+Space', toggleDock);

  console.log(`[Stash] shortcuts registered — drawer: ${drawerReg}, dock: ${dockReg}`);
  if (!drawerReg) console.warn('[Stash] drawer hotkey registration failed (conflict?)');
  if (!dockReg) console.warn('[Stash] dock hotkey registration failed (conflict?)');
  return drawerReg && dockReg;
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Set up persistence paths (now that app is ready)
  pinnedStorePath = path.join(app.getPath('userData'), 'pinned.json');
  settingsStorePath = path.join(app.getPath('userData'), 'settings.json');
  sessionStorePath = path.join(app.getPath('userData'), 'sessions.json');
  collectionStatsStorePath = path.join(app.getPath('userData'), 'collection-stats.json');
  loadPinned();
  loadSettings();
  loadSessions();
  loadCollectionStats();
  // a session deleted outside the app shouldn't leave capture pointing at it
  if (settings.activeSessionId && !sessions.some(s => s.id === settings.activeSessionId)) {
    settings.activeSessionId = null;
  }

  applyAppearance();
  createWindow();
  createDockWindow();
  createTray();
  applyAppearance(); // again, now that the windows exist and can be repainted

  // following the system means following it as it changes, not only at launch
  nativeTheme.on('updated', () => {
    if ((settings.appearance || 'system') === 'system') applyAppearance();
  });

  console.log('[Stash] tray created:', tray ? 'yes' : 'no');
  console.log('[Stash] platform:', process.platform);
  console.log('[Stash] assets dir:', path.join(__dirname, '..', 'assets'));
  console.log('[Stash] pinned store:', pinnedStorePath);
  console.log('[Stash] session store:', sessionStorePath);
  console.log('[Stash] settings store:', settingsStorePath);
  console.log('[Stash] collection stats store:', collectionStatsStorePath);

  registerShortcuts();

  // Only actually watches when the setting is on, so a fresh install asks
  // macOS for nothing.
  startScreenshotWatcher();

  // Update check — wait a few seconds so the window is ready to receive the
  // IPC message, then run again every 6 hours while the app is alive.
  setTimeout(checkForUpdate, 5000);
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);

  // macOS occasionally releases global shortcuts after certain system events
  // (screen lock, display sleep, user switching). Re-register when the app
  // regains focus, as a belt-and-suspenders safety.
  app.on('browser-window-focus', () => {
    if (!globalShortcut.isRegistered('CommandOrControl+Shift+V') ||
        !globalShortcut.isRegistered('CommandOrControl+Shift+Space')) {
      console.log('[Stash] a shortcut was dropped — re-registering');
      registerShortcuts();
    }
  });

  // System sleep/wake and display changes are the main culprits for dropped
  // shortcuts. Re-register after every resume.
  powerMonitor.on('resume', () => {
    console.log('[Stash] system resumed — re-registering shortcuts');
    registerShortcuts();
  });
  powerMonitor.on('unlock-screen', () => {
    console.log('[Stash] screen unlocked — re-registering shortcuts');
    registerShortcuts();
  });
  // Unplugging the screen the drawer is welded to would otherwise leave it
  // parked off the edge of everything. Re-seat it on whatever remains, and
  // pick up a resolution change on the screen it is already on.
  function reseatDrawer() {
    registerShortcuts();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBounds(drawerBounds(drawerDisplay(false), isDrawerExpanded()));
  }
  screen.on('display-added', reseatDrawer);
  screen.on('display-removed', reseatDrawer);
  screen.on('display-metrics-changed', reseatDrawer);

  // Periodic health check — cheap (just two boolean reads) and catches any
  // edge case the above handlers miss. Runs every 30 seconds.
  setInterval(() => {
    try {
      const drawerOk = globalShortcut.isRegistered('CommandOrControl+Shift+V');
      const dockOk = globalShortcut.isRegistered('CommandOrControl+Shift+Space');
      if (!drawerOk || !dockOk) {
        console.log('[Stash] health check found dropped shortcut — re-registering');
        registerShortcuts();
      }
    } catch (_) {}
  }, 30000);

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
  stopScreenshotWatcher();
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

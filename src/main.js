// src/main.js — Stash main process
// Handles: window lifecycle, global hotkey, tray, clipboard polling, native drag-out
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, nativeImage, screen, shell, powerMonitor } = require('electron');
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

// Drawer drag state — set by IPC from the renderer. Used by the blur handler
// to suppress hide-on-blur while the OS is driving a drag operation.
// Mirrors the dock's dragInProgress pattern (see further down).
let drawerDragInProgress = false;
let drawerDragSafetyTimer = null;

// User settings (persisted to disk)
let settings = {
  autoPasteFromDock: false, // default off — no permission prompt on first launch
};

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
const DRAWER_W = 340;
const INSPECTOR_W = 520;

function setWindowExpanded(expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const { workArea } = screen.getPrimaryDisplay();
  const width = expanded ? DRAWER_W + INSPECTOR_W : DRAWER_W;
  mainWindow.setBounds({
    // grow to the left so the drawer stays welded to the screen edge
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height: workArea.height,
  });
  return true;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const drawerW = DRAWER_W;

  mainWindow = new BrowserWindow({
    width: drawerW,
    height: workArea.height,
    x: workArea.x + workArea.width - drawerW,
    y: workArea.y,
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
  if (dockWindow && dockWindow.isVisible()) refreshDock();
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

ipcMain.handle('clip:prompt', (_e, id) => {
  const ok = promptItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned });
  }
  return ok;
});

ipcMain.handle('prompt:update', (_e, id, patch) => {
  const ok = updatePrompt(id, patch);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned });
  }
  return ok;
});

ipcMain.handle('clip:unprompt', (_e, id) => {
  const ok = unpromptItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned });
  }
  return ok;
});

// Dock selection: copy the item, hide the dock, optionally auto-paste
ipcMain.handle('dock:pick', (_e, entry) => {
  lastSig = entry.id;
  if (entry.type === 'img' && entry.filepath && fs.existsSync(entry.filepath)) {
    clipboard.writeImage(nativeImage.createFromPath(entry.filepath));
  } else {
    clipboard.writeText(entry.content);
  }
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
// one blob of text just moves the problem. So we take the lines tesseract finds
// and cluster them into visual blocks, the way a person reads the image.

let ocrWorker = null;
let ocrWorkerPromise = null;

// Paths have to survive being packed into app.asar — tesseract needs real files
// on disk for its worker, wasm core and language data, so those are unpacked by
// electron-builder and we point at the unpacked copies.
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

async function getOcrWorker(onProgress) {
  if (ocrWorker) return ocrWorker;
  if (ocrWorkerPromise) return ocrWorkerPromise;

  ocrWorkerPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    const langPath = unpacked(path.join(__dirname, '..', 'assets', 'tessdata'));
    const options = {
      workerPath: unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js')),
      corePath: unpacked(path.dirname(require.resolve('tesseract.js-core/package.json'))),
      cachePath: app.getPath('userData'),
      logger: (m) => { if (onProgress) onProgress(m); },
    };
    // Fall back to the CDN only if the bundled language data is missing, so a
    // source checkout that skipped the fetch script still works when online.
    if (fs.existsSync(path.join(langPath, 'eng.traineddata.gz'))) options.langPath = langPath;
    else console.warn('[Stash] bundled tessdata missing — OCR will try the network');

    ocrWorker = await createWorker('eng', 1, options);
    // Sparse text mode. The default assumes a scanned document, and on UI
    // screenshots it decides isolated large text — the number on a stat card —
    // is a picture and silently drops it. Sparse mode just finds text wherever
    // it is and leaves the grouping to us, which is what we want anyway.
    await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
    return ocrWorker;
  })();

  try {
    return await ocrWorkerPromise;
  } catch (err) {
    ocrWorkerPromise = null;
    throw err;
  }
}

// Walk whatever shape tesseract hands back and pull out flat words with boxes.
// Words, not lines: tesseract happily runs a line straight across three
// side-by-side cards, and once it has done that the columns can't be pulled
// apart again. Starting from words lets us decide where a line really ends.
function wordsFrom(data) {
  const out = [];
  const push = (w) => {
    const text = (w.text || '').trim();
    const b = w.bbox;
    if (!text || !b) return;
    if (typeof w.confidence === 'number' && w.confidence < 40) return;
    out.push({ text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  };
  if (Array.isArray(data.blocks)) {
    data.blocks.forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => (l.words || []).forEach(push))));
  }
  if (!out.length && Array.isArray(data.words)) data.words.forEach(push);
  return out;
}

// Words -> runs. Group words sharing a baseline, then cut a run wherever the
// horizontal gap is far wider than ordinary word spacing — that gap is a column
// boundary, a table cell edge, or the space between two unrelated labels.
function runsFromWords(words) {
  if (!words.length) return [];
  const heights = words.map(w => w.y1 - w.y0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 12;

  const rows = [];
  for (const w of [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)) {
    const mid = (w.y0 + w.y1) / 2;
    const row = rows.find(r => Math.abs(r.mid - mid) < medianH * 0.5);
    if (row) {
      row.words.push(w);
      row.mid = (row.mid * (row.words.length - 1) + mid) / row.words.length;
    } else {
      rows.push({ mid, words: [w] });
    }
  }

  const runs = [];
  const gapLimit = medianH * 1.2; // ordinary word spacing is well under this
  for (const row of rows) {
    const sorted = row.words.sort((a, b) => a.x0 - b.x0);
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].x0 - sorted[i - 1].x1 > gapLimit) {
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
      const alignedLeft = Math.abs(line.x0 - g.x0) < medianH * 0.6;
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
    mainWindow.webContents.send('state:updated', { history, pinned });
  }
  return true;
});

ipcMain.handle('ocr:run', async (_e, id) => {
  const entry = [...history, ...pinned].find(c => c.id === id);
  if (!entry || entry.type !== 'img' || !entry.filepath || !fs.existsSync(entry.filepath)) {
    return { ok: false, error: 'that image is no longer on disk' };
  }
  const send = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ocr:progress', msg);
  };
  try {
    send({ status: 'starting', progress: 0 });
    const worker = await getOcrWorker(send);
    const { data } = await worker.recognize(entry.filepath, {}, { blocks: true, text: true });
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
      raw: (data.text || '').trim(),
      imageUrl: pathToFileURL(entry.filepath).href,
      width: size.width,
      height: size.height,
    };
  } catch (err) {
    console.error('[Stash] OCR failed:', err);
    return { ok: false, error: err.message || 'could not read that image' };
  }
});

// ---------- update check ----------
// Lightweight check: ask GitHub for the latest release tag, compare to our
// own version, tell the renderer if there's something newer. Runs once at
// startup and again every 6 hours. Failures are silent — if GitHub is down
// or the user is offline, the app just behaves as if no update exists.
//
// We use the public GitHub Releases API (unauthenticated, 60 req/hour per IP),
// which is more than enough for this poll cadence.

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/harikrsh10/Stash/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Strip leading "v" and split into numbers so "0.1.10" > "0.1.9" (string
// compare would get this wrong).
function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewerVersion(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'User-Agent': `Stash/${app.getVersion()}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const latestTag = data.tag_name; // e.g. "v0.1.4"
    const currentVersion = app.getVersion();

    if (isNewerVersion(latestTag, currentVersion)) {
      console.log(`[Stash] update available: ${currentVersion} → ${latestTag}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', {
          version: latestTag,
          url: data.html_url, // release page on github.com
        });
      }
    } else {
      console.log(`[Stash] up to date (${currentVersion})`);
    }
  } catch (err) {
    // Offline, rate-limited, or GitHub having a bad day — silently ignore.
    console.log('[Stash] update check failed:', err.message);
  }
}

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
  loadPinned();
  loadSettings();

  createWindow();
  createDockWindow();
  createTray();

  console.log('[Stash] tray created:', tray ? 'yes' : 'no');
  console.log('[Stash] platform:', process.platform);
  console.log('[Stash] assets dir:', path.join(__dirname, '..', 'assets'));
  console.log('[Stash] pinned store:', pinnedStorePath);
  console.log('[Stash] settings store:', settingsStorePath);

  registerShortcuts();

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
  screen.on('display-added', () => registerShortcuts());
  screen.on('display-removed', () => registerShortcuts());
  screen.on('display-metrics-changed', () => registerShortcuts());

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
  if (ocrWorker) { try { ocrWorker.terminate(); } catch (_) {} }
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
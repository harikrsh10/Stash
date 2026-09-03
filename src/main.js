// src/main.js — Stash main process
// Handles: window lifecycle, global hotkey, tray, clipboard polling, native drag-out
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, nativeImage, nativeTheme, Notification, screen, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const icns = require('./icns');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { createHistoryStore } = require('./history-store');
const { createOcrIndexer, sanitizeOcrText } = require('./ocr-index');
const { createSourceApp } = require('./source-app');
const { sniffAsset, extensionFor, htmlCapFor, paperScene,
        isDesignTool } = require('./design-assets');

const isDev = process.argv.includes('--dev');
// History is written down now, so the cap is about what a person could
// plausibly want back rather than what fits in memory for one sitting.
const HISTORY_LIMIT = 10000;
// Pictures are the clips you cannot simply copy again — the window has moved
// on — so they are the ones worth keeping, and also the only ones big enough
// to need a ceiling. Text runs to the item cap; images run to this many bytes,
// oldest out first.
const HISTORY_IMAGE_BUDGET = 1024 * 1024 * 1024;
const POLL_INTERVAL = 600;
// And how it slows down when nothing is happening. Reading the clipboard is
// never free -- 19ms just to get a 4K bitmap off it -- so doing it a hundred
// times a minute through an afternoon where nobody copied anything is work
// spent on nothing. After a while quiet it drops to a slower beat and goes
// straight back to full speed the moment anything happens.
//
// The latency this could cost is given back where it would be noticed:
// opening the drawer polls immediately, so a clip is never missing from the
// list you just opened to look at.
const POLL_IDLE_INTERVAL = 2500;
const POLL_CALM_AFTER_MS = 20 * 1000;
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
// Where history's pictures live. The temp directory was fine while history
// died with the process; it is not somewhere a screenshot from last Tuesday
// can be expected to survive.
let historyImageDir = null;
// The log behind `history`. Created once app is ready, since it needs a path.
// Until then it is a no-op, so anything that runs early can call it safely.
let historyStore = createHistoryStore({ filePath: null });

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
  rememberHistory: true,    // write history to disk; off returns it to memory-only
  indexImageText: true,     // read the text in pictures so it can be searched for
  recordSourceApp: true,    // remember which app a clip was copied out of
  // The background gradient moving. Off by default, and that is a deliberate
  // choice rather than an oversight: the window is transparent, so every frame
  // it paints has to be blended with whatever is behind it, and that costs
  // about sixty times what the same frame costs in an opaque window -- 50% of
  // a core against 0.8%, measured. A still gradient is the same picture and
  // costs nothing at all. Anyone who wants it moving can say so.
  animateBackground: false,
  // The keys themselves, so a conflict with another app is something a person
  // can settle rather than live with.
  shortcuts: {
    drawer: 'CommandOrControl+Shift+V',
    dock: 'CommandOrControl+Shift+Space',
  },
};

// An accelerator Electron will accept, and that is worth accepting: a bare key
// with no modifier would swallow that key everywhere on the machine.
const ACCEL_MODIFIERS = ['CommandOrControl', 'Command', 'Cmd', 'Control', 'Ctrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];
const ACCEL_KEYS = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => 'F' + (i + 1)),
  'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down',
  'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Plus',
  ',', '.', '/', '\\', '`', '-', '=', '[', ']', ';', "'",
];

function validAccelerator(accel) {
  if (typeof accel !== 'string' || !accel.trim()) return false;
  const parts = accel.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;                    // a key on its own is a trap
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!mods.length || !mods.every(m => ACCEL_MODIFIERS.includes(m))) return false;
  if (new Set(mods).size !== mods.length) return false;
  return ACCEL_KEYS.some(k => k.toLowerCase() === key.toLowerCase());
}

function currentAccelerators() {
  const s = settings.shortcuts || {};
  return {
    drawer: validAccelerator(s.drawer) ? s.drawer : DEFAULT_SHORTCUTS.drawer,
    dock: validAccelerator(s.dock) ? s.dock : DEFAULT_SHORTCUTS.dock,
  };
}

// The keys as shipped. Kept apart from `settings` so "reset to default" has
// something to reset to after settings has been written over.
const DEFAULT_SHORTCUTS = { drawer: 'CommandOrControl+Shift+V', dock: 'CommandOrControl+Shift+Space' };

// Setting themeSource is what flips prefers-color-scheme inside the windows, so
// the stylesheets need no theme class of their own — and native bits like
// scrollbars and menus follow at the same time.
function appearanceChoice() {
  return ['system', 'dark', 'light'].includes(settings.appearance) ? settings.appearance : 'system';
}

// What the drawer was last told, so an event that changes nothing sends nothing.
let lastAppearanceSent = '';

// Tell the drawer where things stand. Assigns nothing -- which is the whole
// point of it being separate from applyAppearance below.
function notifyAppearance() {
  const choice = appearanceChoice();
  const dark = choice === 'system' ? nativeTheme.shouldUseDarkColors : choice === 'dark';
  const key = `${choice}:${dark}`;
  if (key === lastAppearanceSent) return;
  lastAppearanceSent = key;
  // the drawer has its own switch, so it has to hear about changes made from
  // the tray — and about the system flipping underneath a 'system' choice
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('appearance:changed', { choice, dark });
  }
}

function applyAppearance() {
  const choice = appearanceChoice();
  // Assigning themeSource is neither free nor idempotent.
  //
  // Measured on a Mac: assigning 'light' when it is already 'light' emits
  // nothing, but assigning 'system' when it is already 'system' emits
  // 'updated' every single time. The handler for that event called back into
  // here, which assigned it again -- 86,985 times in two seconds, each one
  // sending an appearance:changed to the drawer.
  //
  // 'system' is the default, and this runs at startup, so every Mac has been
  // spinning a core from launch and had no room left to handle the click that
  // would change the appearance. Two guards, because one of them being enough
  // is not worth relying on: assign only on a real change, and never assign
  // from the event handler.
  if (nativeTheme.themeSource !== choice) nativeTheme.themeSource = choice;
  // The windows are NOT given a background of their own here, and must not be.
  //
  // They used to be, so that neither painted its old ground for a frame when
  // it opened. Both are transparent now: the drawer is always wide enough for
  // the side panel and the half the panel is not using has to show the desktop
  // through it. An opaque colour set here is painted across the whole window
  // and defeats that -- as a white slab beside the drawer in light mode, which
  // is exactly what it did.
  //
  // Nothing is lost. What each window is transparent to is its own page, which
  // paints its ground in the theme colour on the first frame it draws.
  //
  // An explicit apply always tells the drawer, even if nothing appears to have
  // moved: this runs a second time once the windows exist, and a window that
  // was not there for the first call still needs the answer. The deduplication
  // is there to quieten the event handler, not this.
  lastAppearanceSent = '';
  notifyAppearance();
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
//
// One width, always: the drawer plus the space the side panel occupies when it
// is out. The window never changes size while it is on screen.
//
// It used to grow leftward when a panel opened, and that is what the jump was.
// The page is laid out at the full width whatever the window is doing, so the
// layout was never wrong -- but a window whose left edge moves 520px has its
// old contents shown at the new origin for the frame or two before the
// renderer paints, and what that looks like is the whole drawer sliding left
// and snapping back. No stylesheet can reach that frame. The only fix is for
// the edge not to move, so it does not.
function drawerBounds(display) {
  const { workArea } = display;
  const width = DRAWER_W + INSPECTOR_W;
  return {
    // grow to the left so the drawer stays welded to the screen edge
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height: workArea.height,
  };
}

function createWindow() {
  const first = drawerBounds(drawerDisplay(true));

  mainWindow = new BrowserWindow({
    width: first.width,
    height: first.height,
    x: first.x,
    y: first.y,
    frame: false,
    // The window is always wide enough for the side panel, and the half the
    // panel is not using has to show the desktop rather than a dark slab.
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
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

  // A hidden drawer cannot be told the pointer has left the empty column, so
  // whatever the click-through was set to when it went away is still set when
  // it comes back. Coming back catching its own clicks is the harmless way to
  // be wrong; coming back ignoring them means a drawer nothing can click.
  mainWindow.on('show', () => mainWindow.setIgnoreMouseEvents(false));
  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);

  // Tell the page whether anyone can see it. The background animation used to
  // decide this from window blur alone, which depends on the OS sending one --
  // a window that was never focused never gets a blur, and a drawer that keeps
  // animating while hidden is a laptop fan with no explanation. The main
  // process knows for certain, so it says so.
  const tellVisibility = (visible) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(visible ? 'window:shown' : 'window:hidden');
  };
  // Opening the drawer is the moment a missing clip would be noticed, so the
  // slower idle beat never costs anything visible: catch up first, then show.
  mainWindow.on('show', () => { try { pollClipboard(); } catch (_) {} clipboardIsBusy(); });
  mainWindow.on('show', () => tellVisibility(true));
  mainWindow.on('hide', () => tellVisibility(false));
  mainWindow.on('minimize', () => tellVisibility(false));
  mainWindow.on('restore', () => tellVisibility(true));

  watchForCrashes(mainWindow, 'drawer');

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // The motion dials, injected rather than linked from renderer.html: a
  // development tool should not have a script tag in the shipped page, and
  // this way a reload re-injects it without the page knowing it exists.
  if (isDev) {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const src = fs.readFileSync(path.join(__dirname, 'motion-dials.js'), 'utf8');
        await mainWindow.webContents.executeJavaScript(src, true);
      } catch (err) {
        console.warn('motion dials did not load:', err.message);
      }
    });
  }
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    // Summon it to the screen the pointer is on, at that screen's height, and
    // always narrow: hiding closes the inspector, so coming back wide would
    // only show empty space where it used to be.
    mainWindow.setBounds(drawerBounds(drawerDisplay(true)));
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
  // An accelerator here is a promise that the key works. While another app
  // holds it, showing it anyway is the app telling you to press something that
  // does nothing, so the promise is withdrawn along with the key.
  const trouble = shortcutTrouble(shortcutState);
  const menu = Menu.buildFromTemplate([
    ...(trouble ? [
      { label: trouble.label, enabled: false },
      { label: 'Try to claim it again', click: () => registerShortcuts() },
      { type: 'separator' },
    ] : []),
    {
      label: visible ? 'Hide Stash' : 'Show Stash',
      ...(shortcutState.drawer ? { accelerator: currentAccelerators().drawer } : {}),
      click: toggleWindow,
    },
    {
      label: 'Quick dock',
      ...(shortcutState.dock ? { accelerator: currentAccelerators().dock } : {}),
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
      label: `Collecting into "${activeSession.name}"`,
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
      label: 'Remember history between restarts',
      type: 'checkbox',
      checked: settings.rememberHistory !== false,
      click: (item) => {
        settings.rememberHistory = item.checked;
        saveSettings();
        if (item.checked) {
          // Nothing to restore -- what is on screen is all there is -- but the
          // log has to start carrying it from here on.
          historyStore = createHistoryStore({
            filePath: path.join(app.getPath('userData'), 'history.ndjson'),
            limit: HISTORY_LIMIT,
            enabled: true,
          });
          historyStore.load();
          history.forEach(h => historyStore.add(h));
        } else {
          // Switching it off means what is already written goes too, otherwise
          // the setting only stops the log growing and quietly keeps the rest.
          historyStore.clear();
          historyStore = createHistoryStore({ filePath: null, enabled: false });
        }
        refreshTrayMenu();
      },
    },
    ...(sourceApp && sourceApp.supported ? [{
      label: 'Remember which app a clip came from',
      type: 'checkbox',
      checked: settings.recordSourceApp !== false,
      click: (item) => {
        settings.recordSourceApp = item.checked;
        saveSettings();
        // Switching it off should stop the helper too, not merely stop asking.
        if (!item.checked && sourceApp) sourceApp.stop();
        refreshTrayMenu();
      },
    }] : []),
    {
      label: 'Copy diagnostics',
      toolTip: 'puts a short report on the clipboard, for working out why something is not happening',
      click: () => {
        const report = diagnosticsReport();
        // Written straight to the clipboard rather than through writeClip, so
        // the report does not become a clip in the history it describes.
        lastSig = 'txt:diagnostics-' + Date.now();
        clipboard.writeText(report);
        console.log('[Stash] diagnostics\n' + report);
      },
    },
    // Nothing to offer where there is no OS engine to do the reading.
    ...(ocrIndexingAvailable() ? [{
      label: 'Search text inside images',
      type: 'checkbox',
      checked: settings.indexImageText !== false,
      click: (item) => {
        settings.indexImageText = item.checked;
        saveSettings();
        startOcrIndexer();
        refreshTrayMenu();
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
        const wasHolding = history;
        history = [];
        wasHolding.forEach(h => dropImageFile(h.filepath));
        historyStore.clear();
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
// What Stash writes to disk. This comment claimed for a long time that pinned
// items were the only thing, which stopped being true several features ago -- a
// stale sentence about privacy is worse than none, because the next person
// makes a decision on it.
//
//   pinned.json         pins and prompts, and the tags on them
//   sessions.json       collections, and which clips are in them
//   settings.json       including the chosen shortcuts
//   source-icons.json   one icon per app a clip has been copied from
//   history.ndjson      the running history        -- off with rememberHistory
//   pinned-images/      the picture behind a pinned or prompted image clip
//   history-images/     the picture behind an ordinary image clip
//   ocrText on a clip   text read out of a picture -- off with indexImageText
//
// Two switches genuinely turn things off: rememberHistory returns history to
// memory-only, and indexImageText stops pictures being read at all. Secrets
// reach none of it -- looksSecret refuses them before capture, so an API key
// never enters memory, let alone a file.

function loadPinned() {
  if (!pinnedStorePath) return;
  try {
    if (!fs.existsSync(pinnedStorePath)) return;
    const raw = fs.readFileSync(pinnedStorePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;
    // Drop img entries whose file is genuinely gone -- but only once we are
    // sure we can see the folder it lived in.
    //
    // This used to trust existsSync on its own, and existsSync says false for
    // "not there" and for "could not look": a locked folder, a permissions
    // blip, an antivirus scan, a drive not mounted yet at login. Any of those
    // pruned every pinned picture, and the next ordinary save wrote the
    // pruning to disk. Same shape as the corrupt-store bug -- a transient
    // problem made permanent by the app's own tidying.
    const folderReadable = (dir) => {
      try { fs.readdirSync(dir); return true; } catch (_) { return false; }
    };
    const checkedFolders = new Map();
    pinned = data.filter(entry => {
      if (entry.type !== 'img' || !entry.filepath) return true;
      if (fs.existsSync(entry.filepath)) return true;
      const dir = path.dirname(entry.filepath);
      if (!checkedFolders.has(dir)) checkedFolders.set(dir, folderReadable(dir));
      if (checkedFolders.get(dir)) return false;      // folder is fine, file is not
      // Cannot see the folder, so cannot conclude the file is gone. Keep it.
      console.warn(`[Stash] keeping ${entry.id}: cannot read ${dir} to check it`);
      return true;
    });
    storeCarriedThumbs = false;
    pinned.forEach(recallThumb);
    if (storeCarriedThumbs) {
      console.log('[Stash] moving pinned previews into the cache');
      savePinned();
    }
    console.log(`[Stash] loaded ${pinned.length} pinned items`);
  } catch (err) {
    console.error('[Stash] failed to load pinned:', err);
    preserveUnreadableStore(pinnedStorePath, 'library');
    pinned = [];
  }
}

// ---------- writing to disk without being able to lose it ----------
//
// Every store used to be written with a single writeFileSync straight over the
// live file. If the process died part-way through -- a crash, a force quit, a
// power cut, a full disk -- what was left on disk was a truncated file, and
// there was nothing to fall back to. That is not a rare shape for this app:
// pinned.json is rewritten on every pin, prompt, rename and reorder.
//
// A rename is atomic on both platforms, so a reader sees either the whole old
// file or the whole new one and never half of either. The fsync matters as
// much as the rename: without it the rename can land before the bytes do, and
// a power cut then leaves a name pointing at nothing.
function writeStoreAtomically(filePath, text) {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// A store whose file would not parse. Set on the way in, read on the way out.
const unreadableStores = new Set();

// What a failed load used to do: log, empty the array, carry on. The next
// ordinary save -- pinning anything at all -- then wrote that emptiness over
// the file, turning a corrupt file into a deleted one. So the file is moved
// aside instead, under a name that says what it is, and the person is told.
// Losing the library is survivable if the bytes are still somewhere.
function preserveUnreadableStore(filePath, which) {
  unreadableStores.add(which);
  try {
    if (!fs.existsSync(filePath)) return null;
    const kept = filePath + '.unreadable-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(filePath, kept);
    console.error(`[Stash] ${which} could not be read; kept it at ${kept}`);
    // Silence is what made this bad. Say it where someone will see it.
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Stash could not read its ' + which,
          body: 'The file was kept at ' + path.basename(kept) + ' rather than overwritten. '
            + 'Stash has started with an empty ' + which + '.',
        }).show();
      }
    } catch (_) { /* a missing notification must not take the app with it */ }
    return kept;
  } catch (err) {
    console.error('[Stash] could not set the unreadable ' + which + ' aside:', err);
    return null;
  }
}

// ---------- preview thumbnails, kept out of the stores ----------
//
// Every image clip carries a 240px preview so a row can draw without decoding
// the full picture. That preview was being written into the stores as base64,
// and it is the overwhelming majority of what is in them: sessions.json was
// 13.66MB, of which 11.22MB was thumbnails for 177 clips and 0.78MB was the
// actual text of 462 clips. All of it parsed at startup, and all of it
// rewritten -- and fsynced -- every time a collection changed.
//
// A thumbnail is a cache of a file we already have, so it belongs in a cache.
// Not rebuilt on load instead: at 25ms each that is four and a half seconds of
// startup for a library this size, which is worse than the problem. Read from
// a small file it is about a tenth of a millisecond.
let thumbDir = null;

function thumbPathFor(id) {
  if (!thumbDir || !id) return null;
  // ids look like "img:9f86d081..."; a colon is not a filename on Windows
  return path.join(thumbDir, String(id).replace(/[^a-zA-Z0-9._-]/g, '_') + '.png');
}

function rememberThumb(id, dataUrl) {
  const p = thumbPathFor(id);
  if (!p || !dataUrl) return;
  try {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    fs.writeFileSync(p, Buffer.from(base64, 'base64'));
  } catch (err) {
    // A missing cache costs a redraw, never a clip.
    console.warn('[Stash] could not cache a thumbnail:', err.message);
  }
}

// True when a store handed us a preview it should no longer be carrying, so
// the caller knows to write the smaller file back once.
let storeCarriedThumbs = false;

function recallThumb(entry) {
  if (!entry || entry.type !== 'img') return;
  if (entry.dataUrl) {
    // An older store, from before previews were cached. Take a copy now and
    // let the caller rewrite the file without them -- otherwise the migration
    // waits for the person to happen to edit a collection, and until then they
    // keep paying to parse a thirteen megabyte store on every launch.
    storeCarriedThumbs = true;
    rememberThumb(entry.id, entry.dataUrl);
    return;
  }
  const p = thumbPathFor(entry.id);
  try {
    if (p && fs.existsSync(p)) {
      entry.dataUrl = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
      return;
    }
  } catch (_) { /* fall through and rebuild it */ }
  // No cache yet: an older library that stored its previews in the stores, or
  // one that was cleared. Rebuilding is 25ms a picture, which for a library
  // this size is four and a half seconds -- far too long to spend before the
  // app answers its shortcut. So it is queued and done after startup, a few at
  // a time. A row without its preview yet still shows everything else.
  if (entry.filepath) thumbsToRebuild.push(entry);
}

const thumbsToRebuild = [];
let rebuildTimer = null;
function rebuildThumbsInBackground() {
  if (rebuildTimer || !thumbsToRebuild.length) return;
  rebuildTimer = setInterval(() => {
    // a handful per tick, so this never holds up a copy being captured
    for (let i = 0; i < 4 && thumbsToRebuild.length; i++) {
      const entry = thumbsToRebuild.shift();
      if (!entry || entry.dataUrl) continue;
      try {
        const img = nativeImage.createFromPath(entry.filepath);
        if (img.isEmpty()) continue;
        entry.dataUrl = img.resize({ width: 240 }).toDataURL();
        rememberThumb(entry.id, entry.dataUrl);
      } catch (_) { /* a row without a preview still works */ }
    }
    if (!thumbsToRebuild.length) {
      clearInterval(rebuildTimer);
      rebuildTimer = null;
      console.log('[Stash] thumbnail cache filled');
      // the rows that were waiting on one can draw it now
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:updated', {});
    }
  }, 60);
}

function forgetThumb(id) {
  const p = thumbPathFor(id);
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

function savePinned() {
  if (!pinnedStorePath) return;
  // The file could not be read at boot and has been kept aside. Writing an
  // empty library over its replacement is how the loss became permanent.
  if (unreadableStores.has('library')) return;
  try {
    // Strip dataUrl from saved entries — it's huge and we can regenerate on demand
    const serializable = pinned.map(p => {
      const copy = { ...p };
      delete copy._new;
      delete copy._promoted;
      // Cache it before dropping it, never after: the store is about to stop
      // being the only place this preview exists, so the other place has to
      // exist first.
      if (p.dataUrl) rememberThumb(p.id, p.dataUrl);
      delete copy.dataUrl;
      // keep dataUrl for images so they render without re-reading the file
      return copy;
    });
    writeStoreAtomically(pinnedStorePath, JSON.stringify(serializable, null, 2));
  } catch (err) {
    console.error('[Stash] failed to save pinned:', err);
  }
}

// Reading the text in pictures, quietly, one at a time, in the background.
// Null until the app is ready and we know whether the platform can do it.
let ocrIndexer = null;

// Which app was in front when something was copied. The helper behind this is
// started on the first copy rather than at launch, so an app that is opened and
// never used costs nothing.
let sourceApp = createSourceApp({
  spawn: require('child_process').spawn,
  writeScript: (body) => {
    const p = path.join(TMP_DIR, 'stash-source-app.ps1');
    fs.writeFileSync(p, body, 'utf8');
    return p;
  },
  // Only worth a second process for an app we have no icon for yet.
  // Ask for the bundle path unless we already have an icon. A miss must not
  // stop the lookup, or a single failure is permanent.
  needsPath: (name) => !sourceIcons[name],
  // macOS asks per copy instead of keeping a helper alive; see source-app.js.
  runOnce: (cmd, args) => new Promise((resolve, reject) => {
    require('child_process').execFile(cmd, args, { timeout: 2000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  }),
  onError: (err) => console.error('[Stash] source app:', err.message),
});

// The same clip can be held in history, in pinned and in any number of
// collections at once, so learning something about it means learning it about
// every copy. Writes down whichever stores hold it. Returns false when the clip
// has gone -- deleted, or aged out, while whatever discovered this was working.
function updateClipEverywhere(id, patch) {
  let inHistory = false, inPinned = false, inSessions = false;
  history.forEach(h => { if (h.id === id) { Object.assign(h, patch); inHistory = true; } });
  pinned.forEach(p => { if (p.id === id) { Object.assign(p, patch); inPinned = true; } });
  sessionClips.forEach(s => { if (s.id === id) { Object.assign(s, patch); inSessions = true; } });
  if (!inHistory && !inPinned && !inSessions) return false;
  if (inHistory) history.forEach(h => { if (h.id === id) historyStore.add(h); });
  if (inPinned) savePinned();
  if (inSessions) saveSessions();
  return true;
}

// Put extracted text on every copy of a clip. Used by the background queue and
// by reading a picture by hand.
function rememberOcrText(id, raw) {
  if (settings.indexImageText === false) return;
  const text = sanitizeOcrText(raw, looksSecret);
  if (!updateClipEverywhere(id, { ocrText: text })) return;
  if (ocrIndexer) ocrIndexer.forget(id);
  forgetThumb(id);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clip:indexed', id, text);
  }
}

// An app's icon, keyed by the name shown on the row. Icons are 16px PNGs --
// about half a kilobyte of base64 each -- so the whole cache for a working
// week of apps is smaller than one screenshot, and it is kept beside the other
// stores so a restart does not have to re-ask the OS for every one of them.
let sourceIcons = {};
let sourceIconStorePath = null;

function loadSourceIcons() {
  if (!sourceIconStorePath) return;
  try {
    if (!fs.existsSync(sourceIconStorePath)) return;
    const data = JSON.parse(fs.readFileSync(sourceIconStorePath, 'utf8'));
    if (data && typeof data === 'object') {
      // Older builds wrote misses in here as nulls, and a null was permanent:
      // it looked like a remembered answer, so the icon was never fetched
      // again. Anyone upgrading with a store full of them would keep seeing
      // names where logos should be, so they are dropped on the way in.
      sourceIcons = {};
      for (const [name, icon] of Object.entries(data)) {
        if (icon) sourceIcons[name] = icon;
      }
      const dropped = Object.keys(data).length - Object.keys(sourceIcons).length;
      if (dropped) console.log(`[Stash] forgetting ${dropped} app(s) remembered as having no icon`);
    }
    console.log(`[Stash] ${Object.keys(sourceIcons).length} app icon(s) remembered`);
  } catch (err) {
    console.error('[Stash] failed to load app icons:', err);
    // These are a cache and can be rebuilt, so they are kept aside without a
    // notification -- there is nothing here a person would miss.
    unreadableStores.add('app icons');
    sourceIcons = {};
  }
}

function saveSourceIcons() {
  if (!sourceIconStorePath) return;
  if (unreadableStores.has('app icons')) return;
  try {
    writeStoreAtomically(sourceIconStorePath, JSON.stringify(sourceIcons));
  } catch (err) {
    console.error('[Stash] failed to save app icons:', err);
  }
}

// Ask the OS for an app's icon once and remember it. Everything here is
// best-effort: an app that will not give up its icon shows as a name, which is
// what every row looked like before icons existed.
// Apps we asked about and got nothing for. Deliberately in memory and not on
// disk: a miss used to be written to the store like a hit, and once written it
// was permanent -- hasOwnProperty said we knew the answer, so the icon was
// never fetched again and the bundle path was never even looked up again. One
// bad run, and every app on the machine showed as text for ever with no way
// back short of deleting the file by hand. That is exactly what "no source app
// is able to retrieve the logos" looks like from the outside.
//
// Kept for the session so a protected process is not asked on every copy, and
// forgotten at quit so a restart is all it takes to try again.
const iconMisses = new Set();

// What "I have no icon for this" looks like.
//
// getFileIcon does not fail for a path macOS cannot place. It answers with a
// generic icon -- the blank document, or the blank application for anything
// ending in .app -- and that answer is a real, non-empty image. isEmpty() is
// false, so it was remembered as though it were the app's own logo, and every
// row from that app then showed a grey placeholder square instead of a name.
// That is the state in the screenshot: not a missing icon falling back to
// text, but a present icon that is not the app's.
//
// So the generic icons are asked for once, against paths that certainly are
// not apps, and anything matching them is treated as a miss.
let genericIcons = null;
async function genericIconSet() {
  if (genericIcons) return genericIcons;
  genericIcons = new Set();
  const stem = path.join(app.getPath('temp'), `stash-icon-probe-${Date.now()}`);
  // A bare name, an unknown extension, and a bundle that is not there -- macOS
  // hands back a different generic for each shape, and the third is the one an
  // app path that has gone stale would produce.
  for (const probe of [stem, `${stem}.stash-nothing`, `${stem}.app`]) {
    try {
      const img = await app.getFileIcon(probe, { size: 'small' });
      if (img && !img.isEmpty()) genericIcons.add(img.toDataURL());
    } catch (_) {
      // Refusing outright is the better answer; there is nothing to learn here.
    }
  }
  return genericIcons;
}

// Icons already remembered from before the check above existed are still
// generic, and nothing would ever ask for them again -- the store says the
// answer is known. Swept once, on the first lookup after launch.
let sweptGenericIcons = false;
async function dropRememberedGenericIcons() {
  if (sweptGenericIcons) return;
  sweptGenericIcons = true;
  const generic = await genericIconSet();
  // Anything two apps share is a placeholder by definition, whatever it looks
  // like. A store written before this check has every app pointing at the same
  // picture, and none of them would ever be asked about again -- so the sweep
  // has to find them by the collision rather than by recognising the picture.
  const byIcon = new Map();
  for (const [n, url] of Object.entries(sourceIcons)) {
    if (!url) continue;
    byIcon.set(url, (byIcon.get(url) || 0) + 1);
  }
  for (const [url, count] of byIcon) if (count > 1) generic.add(url);
  if (!generic.size) return;
  const bad = Object.keys(sourceIcons).filter(n => generic.has(sourceIcons[n]));
  if (!bad.length) return;
  bad.forEach(n => { delete sourceIcons[n]; });
  console.log(`[Stash] forgetting ${bad.length} app(s) remembered with a generic icon`);
  saveSourceIcons();
  broadcastState();
}

// A path is only worth asking about if something is actually there. An app
// bundle that has moved, or a path that never parsed properly in the first
// place, is precisely what produces a generic icon.
function usableAppPath(p) {
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    if (process.platform === 'darwin' && !p.endsWith('.app')) return null;
    return p;
  } catch (_) {
    return null;
  }
}

// Where the standard Mac keeps its applications, plus one level down, which is
// where /Applications/Utilities and the vendor folders (Adobe, Microsoft) live.
const MAC_APP_DIRS = [
  '/Applications',
  '/System/Applications',
  '/System/Applications/Utilities',
  '/Applications/Utilities',
];

// The second route to an app bundle: its name.
//
// The first route asks lsappinfo, which needs two shells per copy and, on the
// Mac this was reported from, came back with something that did not lead to an
// icon. Mac apps are named after themselves and live in a handful of places, so
// this is half a dozen stats rather than a search -- and it needs no shell at
// all, which is why it is worth having even when the first route works.
function findAppBundle(name) {
  if (process.platform !== 'darwin' || !name) return null;
  const candidates = [];
  const dirs = MAC_APP_DIRS.slice();
  try { dirs.push(path.join(app.getPath('home'), 'Applications')); } catch (_) {}
  for (const dir of dirs) candidates.push(path.join(dir, `${name}.app`));
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  // One level in, for the apps that ship inside a folder of their own.
  for (const dir of dirs) {
    let sub;
    try { sub = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of sub) {
      if (!d.isDirectory() || d.name.endsWith('.app')) continue;
      const p = path.join(dir, d.name, `${name}.app`);
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
  }
  return null;
}

// The name a bundle gives its own icon file. Asked out of process because
// Info.plist is usually binary, and asked asynchronously because this runs on
// the way through a copy.
function plistIconName(appPath) {
  return new Promise((resolve) => {
    require('child_process').execFile(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      { timeout: 2000 },
      (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

// An app's real logo, read out of its own bundle.
//
// This is the route that works. Asked on a Mac about all 86 apps installed on
// it: every one had an icns, every one had a PNG inside, none failed to decode,
// and they came out as 73 distinct pictures -- the only repeats being seven
// copies of Xcode, which genuinely share an icon. getFileIcon on the same
// machine returned one identical placeholder for Firefox, Chrome and Edge.
//
// About 15ms per app, once, and then it is in the store.
async function iconFromBundle(appPath) {
  if (process.platform !== 'darwin' || !appPath) return null;
  try {
    const named = await plistIconName(appPath);
    const file = icns.iconPathFor(appPath, { readPlistIconName: () => named });
    if (!file) return null;
    const best = icns.bestPng(fs.readFileSync(file));
    // An icns written before 10.7 carries JPEG 2000 in these slots, which
    // nativeImage cannot read. That is a miss, and the name is shown.
    if (!best) return null;
    const img = nativeImage.createFromBuffer(best.data);
    if (!img || img.isEmpty()) return null;
    return img.resize({ width: 32, height: 32 }).toDataURL();
  } catch (err) {
    console.warn(`[Stash] could not read the icon inside ${appPath}: ${err.message}`);
    return null;
  }
}

async function iconFor(name, appPath) {
  if (!name) return null;
  await dropRememberedGenericIcons();
  if (Object.prototype.hasOwnProperty.call(sourceIcons, name)) return sourceIcons[name];
  if (iconMisses.has(name)) return null;
  const where = usableAppPath(appPath) || findAppBundle(name);
  if (!where) {
    iconMisses.add(name);
    console.warn(`[Stash] no usable path for ${name} (asked about ${appPath || 'nothing'})`);
    return null;
  }
  // The bundle first, because on a Mac it is the only one of the two that
  // reliably answers with the app's own logo. No collision check on this one:
  // it reads the icon the app declares for itself, so two apps agreeing means
  // they really do share an icon -- seven copies of Xcode, say -- rather than
  // both having been handed a placeholder.
  const fromBundle = await iconFromBundle(where);
  if (fromBundle) {
    sourceIcons[name] = fromBundle;
    saveSourceIcons();
    return fromBundle;
  }

  try {
    const img = await app.getFileIcon(where, { size: 'small' });
    if (!img || img.isEmpty()) throw new Error('no icon');
    const url = img.toDataURL();
    // A data URL with nothing after the comma is a valid string and a broken
    // picture, which is the other way a placeholder reaches a row.
    if (url.length < 256) throw new Error(`icon is empty (${url.length} chars)`);
    if ((await genericIconSet()).has(url)) throw new Error('generic icon, not the app');
    // Two different apps cannot have the same logo.
    //
    // This needs no idea of what a placeholder looks like, which is why it is
    // here: asked on a Mac, getFileIcon returned one identical picture for
    // Terminal, TextEdit, Calculator, Chrome and Firefox -- and that picture is
    // not the one an unplaceable path returns, so the set of generics learned
    // up front never matches it. A collision is the tell, and it needs nothing
    // learned in advance.
    //
    // Two apps really shipping identical icons costs both of them a logo and
    // leaves both showing a name, which is the old behaviour and survivable.
    const clash = Object.keys(sourceIcons).find(other => sourceIcons[other] === url);
    if (clash) {
      genericIcons.add(url);
      delete sourceIcons[clash];
      iconMisses.add(clash);
      saveSourceIcons();
      broadcastState();
      throw new Error(`the same picture as ${clash}, so it is not either app's logo`);
    }
    sourceIcons[name] = url;
  } catch (err) {
    iconMisses.add(name);
    console.warn(`[Stash] no icon for ${name} at ${where}: ${err.message}`);
    return null;
  }
  saveSourceIcons();
  return sourceIcons[name];
}

// The last few source-app lookups, kept in memory so the app can say what it
// actually saw. Three fixes to this have now been made from a Windows desk by
// reasoning about what a Mac probably answers, and two of them were wrong. A
// report the user can paste back costs a few lines and ends that.
const sourceLog = [];
// What the clipboard was offering when a design asset arrived.
const assetLog = [];
// Every clipboard change, kept or not.
const clipboardLog = [];
let lastFormatsKey = '';

// The last app we managed to identify, so a copy whose own lookup comes back
// empty is not left anonymous. Short-lived on purpose: half a minute later it
// is a guess rather than a memory.
let lastKnownApp = null;
const LAST_APP_GRACE_MS = 30 * 1000;
function noteSourceLookup(entry) {
  sourceLog.unshift({ at: Date.now(), ...entry });
  sourceLog.length = Math.min(sourceLog.length, 12);
}

function diagnosticsReport() {
  const lines = [];
  lines.push(`Stash ${app.getVersion()} · ${process.platform} · electron ${process.versions.electron}`);
  lines.push(`history ${history.length} · pinned ${pinned.length} · collections ${sessions.length}`);
  // Which build is answering the shortcut is the first thing worth knowing when
  // "nothing happens" -- a second copy holding the key looks exactly like a
  // broken app from the outside.
  // Anything that died since launch. Empty is the answer people should see.
  if (crashLog.length) {
    lines.push(`crashes: ${crashLog.length} since launch`);
    crashLog.slice(0, 4).forEach(c =>
      lines.push(`  ${new Date(c.at).toLocaleTimeString()} — ${c.what}: ${c.detail}`));
  } else {
    lines.push('crashes: none since launch');
  }
  // The thing to look at first when someone says Stash is heating their
  // machine: this window is transparent, so anything that animates in it is
  // blended with the desktop every frame and costs far more than it looks.
  lines.push(`updates: ${updateState ? updateState.status : 'nothing pending'}`
    + ` · ${updateBlockedReason() || 'can install'}`
    + (app.isPackaged ? '' : ' · UNPACKAGED (no feed)'));
  lines.push(`background: ${settings.animateBackground === true ? 'ANIMATED (opt-in)' : 'still'}`
    + ` · window transparent, so motion here is expensive`);
  lines.push(`shortcuts: drawer ${shortcutState.drawer ? 'held' : 'TAKEN BY ANOTHER APP'}`
    + ` · dock ${shortcutState.dock ? 'held' : 'TAKEN BY ANOTHER APP'}`);
  lines.push(`source app: ${settings.recordSourceApp !== false ? 'on' : 'off'}`
    + ` · supported ${sourceApp && sourceApp.supported}`
    + ` · helper running ${sourceApp && sourceApp.running}`);
  lines.push(`image text: ${settings.indexImageText !== false ? 'on' : 'off'}`
    + ` · indexer ${ocrIndexer ? 'started' : 'off'}`);
  const icons = Object.entries(sourceIcons);
  lines.push(`icons cached: ${icons.length}`
    + (icons.length ? ` (${icons.filter(([, v]) => v).length} with an icon,`
      + ` ${icons.filter(([, v]) => !v).length} refused)` : ''));
  // The size is the tell. A real logo is a few kilobytes; a generic icon is a
  // valid picture of nothing, and reads as a broken square on a row -- so it is
  // named here rather than counted as a success.
  // The fingerprint is the useful part of this line. Two apps showing the same
  // one means neither picture is a logo, which is the failure that took three
  // attempts to find -- and it reads off the report at a glance.
  const fingerprint = (v) => require('crypto').createHash('sha1').update(v).digest('hex').slice(0, 8);
  icons.slice(0, 12).forEach(([name, v]) => lines.push(`  icon "${name}": `
    + (!v ? 'NO ICON'
      : (genericIcons && genericIcons.has(v)) ? `GENERIC (${v.length} chars)`
      : `${v.length} chars, ${fingerprint(v)}`)));
  const shas = icons.filter(([, v]) => v).map(([, v]) => fingerprint(v));
  if (shas.length > 1) {
    lines.push(`  ${shas.length} icons, ${new Set(shas).size} of them different`
      + (new Set(shas).size < shas.length ? '  <-- apps sharing a picture are not showing logos' : ''));
  }
  if (iconMisses.size) {
    lines.push(`icons refused this session: ${[...iconMisses].join(', ')}`);
  }
  lines.push(`generic icons learned: ${genericIcons ? genericIcons.size : 'not asked yet'}`);
  lines.push('every clipboard change (newest first), kept or not:');
  if (!clipboardLog.length) lines.push('  nothing seen yet');
  clipboardLog.forEach(e => {
    lines.push(`  ${new Date(e.at).toLocaleTimeString()} ${e.formats.join(', ') || '(no formats)'}`);
  });
  lines.push('design assets seen (newest first) — what the clipboard offered:');
  if (!assetLog.length) lines.push('  none yet — copy a frame or an SVG first');
  assetLog.forEach(e => {
    lines.push(`  ${new Date(e.at).toLocaleTimeString()} ${e.asset}: ${e.formats.join(', ')}`);
  });
  lines.push('recent source lookups (newest first):');
  if (!sourceLog.length) lines.push('  none yet — copy something from another app first');
  sourceLog.forEach(e => {
    lines.push(`  ${new Date(e.at).toLocaleTimeString()} name=${JSON.stringify(e.name || null)}`
      + ` path=${JSON.stringify(e.path || null)} icon=${e.icon || 'n/a'}`);
  });
  return lines.join('\n');
}

// Where a clip came from. Asked after the clip is already captured, because the
// answer takes about ten milliseconds and a copy should never wait on it.
function attachSourceApp(entry) {
  if (!sourceApp || !sourceApp.supported || settings.recordSourceApp === false) return;
  if (!entry || !entry.id) return;
  sourceApp.current().then(async (from) => {
    // The question is asked a moment after the copy, and by then the person may
    // already have clicked into Stash to look at what they copied -- which
    // answers "Stash", which is nothing. The app they were in a moment ago is a
    // far better answer than none, so a recent one stands in.
    if ((!from || !from.name) && lastKnownApp
        && Date.now() - lastKnownApp.at < LAST_APP_GRACE_MS) {
      from = { name: lastKnownApp.name, path: lastKnownApp.path };
    }
    if (!from || !from.name) {
      noteSourceLookup({ name: null, path: null, icon: 'no answer' });
      return;
    }
    lastKnownApp = { name: from.name, path: from.path, at: Date.now() };
    // A picture copied out of a drawing tool is artwork, not a screenshot, and
    // belongs on an asset card. Figma offers nothing but image/png for an icon
    // -- no payload, no marker -- so where it came from is the only thing that
    // distinguishes the two.
    const alsoAsset = (entry.type === 'img' && !entry.asset && isDesignTool(from.name))
      ? { asset: 'artwork' }
      : {};
    if (!updateClipEverywhere(entry.id, { sourceApp: from.name, ...alsoAsset })) return;
    // The icon is a second, slower question, and the row is already correct
    // without it -- so the name goes over first and the icon follows.
    const icon = await iconFor(from.name, from.path);
    noteSourceLookup({ name: from.name, path: from.path, icon: icon ? 'yes' : 'NO ICON' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clip:sourced', entry.id, from.name, icon || null);
    }
  }).catch(() => { /* not knowing where it came from must never cost the clip */ });
}

function ocrIndexingAvailable() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function startOcrIndexer() {
  if (ocrIndexer) ocrIndexer.stop();
  ocrIndexer = null;
  if (settings.indexImageText === false || !ocrIndexingAvailable()) return;

  ocrIndexer = createOcrIndexer({
    extract: async (filepath) => {
      const data = await runNativeOcr(filepath);
      return clusterLines(runsFromWords(wordsFrom(data))).map(b => b.text).join('\n');
    },
    looksSecret,
    // Failures mark the clip rather than storing anything, so there is nothing
    // to write down and nothing for the drawer to search.
    onText: (clip, text) => { if (text !== null) rememberOcrText(clip.id, text); },
  });
  ocrIndexer.queue(history.filter(h => h.type === 'img'));
}

// Pictures whose clip did not come back have nothing pointing at them and
// would otherwise sit there for ever: a clip deleted while the app was closed,
// a run that ended before the log was written, a crash mid-capture. Runs once,
// after history has been restored, so "referenced" means what it says.
function gcHistoryImages() {
  if (!historyImageDir) return;
  let files = [];
  try {
    files = fs.readdirSync(historyImageDir);
  } catch (_) {
    return;
  }
  const referenced = new Set([...history, ...pinned, ...sessionClips]
    .map(c => c.filepath).filter(Boolean));
  let swept = 0;
  files.forEach(f => {
    const fp = path.join(historyImageDir, f);
    if (referenced.has(fp)) return;
    try { fs.unlinkSync(fp); swept += 1; } catch (_) {}
  });
  if (swept) console.log(`[Stash] swept ${swept} unreferenced history image(s)`);
}

// Bring back what was copied before the last quit. Runs once, after settings
// are loaded, since the user can turn the whole thing off.
function restoreHistory() {
  historyStore = createHistoryStore({
    filePath: path.join(app.getPath('userData'), 'history.ndjson'),
    limit: HISTORY_LIMIT,
    enabled: settings.rememberHistory !== false,
  });

  if (!historyStore.enabled) {
    // Turning it off is a request to forget, not merely to stop remembering.
    try { fs.rmSync(historyStore.path, { force: true }); } catch (_) {}
    history = [];
    return;
  }

  const { entries, evicted } = historyStore.load();

  // Whatever the cap pushed out no longer has anything pointing at its file.
  evicted.forEach(e => {
    if (e.filepath && fs.existsSync(e.filepath)) {
      try { fs.unlinkSync(e.filepath); } catch (_) {}
    }
  });

  let dropped = 0;
  history = entries.filter(entry => {
    if (entry.type !== 'img') return true;
    // An image whose file has gone renders as a hole in the drawer, so it is
    // dropped the way the pinned store already drops its own. Pictures kept
    // before they had a durable home lived in the temp directory, so an old
    // history is mostly these on its first launch after the change.
    if (!entry.filepath || !fs.existsSync(entry.filepath)) {
      historyStore.remove(entry.id);
      dropped += 1;
      return false;
    }
    // The thumbnail is deliberately not written to the log -- it is base64 and
    // would dwarf every other field -- so it is rebuilt from the file here.
    try {
      const img = nativeImage.createFromPath(entry.filepath);
      if (img.isEmpty()) throw new Error('unreadable');
      entry.dataUrl = img.resize({ width: 240 }).toDataURL();
    } catch (_) {
      historyStore.remove(entry.id);
      dropped += 1;
      return false;
    }
    return true;
  });

  // Dropping a clip only writes a tombstone in front of it, which is the right
  // trade during a copy but not here: history pictures still live in the temp
  // directory, so most of them are gone every launch, and the log would carry
  // their dead lines for ever. Startup is already touching the file, so fold
  // them away now.
  if (dropped) historyStore.compact();

  console.log(`[Stash] restored ${history.length} clips from history`);
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
  // makeImagePermanent copies rather than moves, so note where the picture was
  // to clear up after it.
  const wasAt = entry.filepath;
  entry = makeImagePermanent(entry);
  entry.pinnedAt = Date.now();
  pinned.unshift(entry);
  // also remove from history so it's not duplicated in the UI
  history.splice(idx, 1);
  historyStore.remove(id);
  if (wasAt && wasAt !== entry.filepath) dropImageFile(wasAt);
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
  historyStore.add(removed);
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
// Text only. The drawer stops offering this on anything else, but the offer
// and the rule are different things: this is reachable over IPC, and a prompt
// that is a screenshot is one the editor cannot open.
function promptable(entry) {
  return !!entry && entry.type === 'text' && !entry.asset;
}

function promptItem(id) {
  const existing = pinned.find(p => p.id === id);
  if (existing && !existing.isPrompt && !promptable(existing)) return false;
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
  if (!promptable(entry)) return false;
  const wasAt = entry.filepath;
  entry = makeImagePermanent(entry);
  entry.isPrompt = true;
  entry.promptedAt = Date.now();
  entry.pinnedAt = Date.now();
  pinned.unshift(entry);
  history.splice(idx, 1);
  historyStore.remove(id);
  if (wasAt && wasAt !== entry.filepath) dropImageFile(wasAt);
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
      // the words it arrived with, kept once so the preview panel can put
      // them back however the edit was made
      if (typeof entry.originalContent !== 'string') entry.originalContent = entry.content || '';
      // the styled copies describe the old words; keeping them would paste
      // something the editor no longer shows
      delete entry.html;
      delete entry.rtf;
      // and it is no longer whatever design asset it arrived as
      delete entry.asset;
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
  historyStore.add(removed);
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
    storeCarriedThumbs = false;
    sessionClips.forEach(recallThumb);
    if (storeCarriedThumbs) {
      console.log('[Stash] moving collection previews into the cache');
      saveSessions();
    }
    console.log(`[Stash] loaded ${sessions.length} sessions, ${sessionClips.length} session clips`);
  } catch (err) {
    console.error('[Stash] failed to load sessions:', err);
    // Collections are hand-made too, so the same rule: keep the bytes.
    preserveUnreadableStore(sessionStorePath, 'collections');
    sessions = [];
    sessionClips = [];
  }
}

function saveSessions() {
  if (!sessionStorePath) return;
  if (unreadableStores.has('collections')) return;
  try {
    const clips = sessionClips.map(c => {
      const copy = { ...c };
      delete copy._new;
      delete copy._promoted;
      // 82% of this file used to be these. Cached first, then dropped.
      if (c.dataUrl) rememberThumb(c.id, c.dataUrl);
      delete copy.dataUrl;
      return copy;
    });
    writeStoreAtomically(sessionStorePath, JSON.stringify({ sessions, clips }, null, 2));
  } catch (err) {
    console.error('[Stash] failed to save sessions:', err);
  }
}

function sessionState() {
  return { sessions, sessionClips, activeSessionId: settings.activeSessionId || null };
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
  dropImageFile(clip.filepath);
}

// A picture is only safe to remove once no clip anywhere still points at it.
// History used to be exempt from this question because its pictures lived in
// the temp directory and died with the process anyway; now that they are kept,
// taking a clip out of a collection could delete the file out from under the
// history row showing the same picture.
function dropImageFile(filepath) {
  if (!filepath) return;
  const stillUsed = history.some(h => h.filepath === filepath)
    || pinned.some(p => p.filepath === filepath)
    || sessionClips.some(c => c.filepath === filepath);
  if (stillUsed) return;
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch (_) { /* a leftover file is better than a crash */ }
}

// Keep the pictures under their byte ceiling by dropping the oldest, which are
// the least likely to be wanted and the most likely to be forgotten about.
// Whole clips go, not just their files — a row whose picture is gone is worse
// than no row.
function pruneHistoryImages() {
  let total = 0;
  const kept = [];
  for (const h of history) {
    if (h.type !== 'img' || !h.filepath) continue;
    total += sizeOf(h);
    kept.push(h);
  }
  if (total <= HISTORY_IMAGE_BUDGET) return;

  // kept is newest-first, so walking back from the end drops the oldest.
  const doomed = [];
  for (let i = kept.length - 1; i >= 0 && total > HISTORY_IMAGE_BUDGET; i--) {
    total -= sizeOf(kept[i]);
    doomed.push(kept[i]);
  }
  const goners = new Set(doomed);
  history = history.filter(h => !goners.has(h));
  doomed.forEach(h => {
    historyStore.remove(h.id);
    // after the filter above, so the reference check sees it gone
    dropImageFile(h.filepath);
  });
  console.log(`[Stash] history images over budget — dropped ${doomed.length}`);
}

// What a picture costs on disk. Recorded at capture; anything captured before
// that is measured once and remembered.
function sizeOf(entry) {
  if (Number.isFinite(entry.bytes)) return entry.bytes;
  try {
    entry.bytes = fs.statSync(entry.filepath).size;
  } catch (_) {
    entry.bytes = 0;
  }
  return entry.bytes;
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
    writeStoreAtomically(settingsStorePath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[Stash] failed to save settings:', err);
  }
}

function setActiveSession(id) {
  const next = id && sessions.some(s => s.id === id) ? id : null;
  settings.activeSessionId = next;
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
  watchForCrashes(dockWindow, 'quick dock');

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
// What a scene payload knows about itself, read once at capture rather than on
// every render.
function sceneFieldsFor(scene) {
  if (!scene || scene.asset !== 'paper') return {};
  const parsed = paperScene(scene.html);
  if (!parsed) return {};
  return { assetName: parsed.name || '', assetSize: parsed.size || '' };
}

function ingestImage(png, scene) {
  if (!png || !png.length) return null;
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) return null;

  const sig = 'img:' + hash(png);
  const thumb = img.resize({ width: 240 }).toDataURL();

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
    historyStore.add(existing);
    broadcastPromote(existing, collectIfActive(existing));
    return sig;
  }

  const size = img.getSize();
  const filename = `clip-${Date.now()}.png`;
  // Somewhere durable if we have one. Falling back to the temp directory keeps
  // capture working before the app is ready rather than dropping the picture.
  const filepath = path.join(historyImageDir || TMP_DIR, filename);
  try {
    fs.writeFileSync(filepath, png);
  } catch (err) {
    console.error('[Stash] could not write the image:', err);
    return null;
  }

  addEntry({
    id: sig,
    type: 'img',
    content: filename,
    filepath,
    dataUrl: thumb,   // cached to disk below, not written into the stores
    meta: `${size.width}×${size.height}`,
    // Written down so the budget below is arithmetic rather than a stat() per
    // picture per copy.
    bytes: png.length,
    ts: Date.now(),
    // The design tool's own description of what this is a picture of, kept so
    // the clip can go back where it came from rather than only look like it.
    ...(scene ? { asset: scene.asset, html: scene.html, ...sceneFieldsFor(scene) } : {}),
  });
  rememberThumb(sig, thumb);
  pruneHistoryImages();
  // The picture just copied is the one most likely to be searched for next.
  if (ocrIndexer) ocrIndexer.queueFirst(history.find(h => h.id === sig));
  return sig;
}

// Some apps do not fill the clipboard in one go. The plain text lands, then the
// HTML a moment later, and sometimes the RTF after that -- and because the
// signature covers every flavour, each stage looks like a brand new copy. Figma
// is one of these, which is how one frame became three rows all stamped the
// same second.
//
// A capture whose plain text matches something captured moments ago is not
// another copy; it is the same copy arriving more completely. It upgrades the
// clip that is already there instead of joining it.
const COALESCE_MS = 2500;

function coalesceRecent(text, styled, asset, sceneFields) {
  const now = Date.now();
  const recent = history.find(h => h.content === text
    && h.type !== 'img'
    && now - (h.ts || 0) < COALESCE_MS);
  if (!recent) return null;
  // Keep the fullest version of each flavour seen, since the later poll is
  // usually the one that caught everything.
  if (styled.html && (!recent.html || styled.html.length > recent.html.length)) {
    recent.html = styled.html;
  }
  if (styled.rtf && (!recent.rtf || styled.rtf.length > recent.rtf.length)) {
    recent.rtf = styled.rtf;
  }
  if (asset && !recent.asset) recent.asset = asset;
  // the later poll is usually the one that caught the whole payload, so the
  // name and size it yields are the ones worth keeping
  if (sceneFields && sceneFields.assetName && !recent.assetName) {
    recent.assetName = sceneFields.assetName;
  }
  if (sceneFields && sceneFields.assetSize && !recent.assetSize) {
    recent.assetSize = sceneFields.assetSize;
  }
  recent.ts = now;
  historyStore.add(recent);
  return recent;
}

// The clipboard changes because a person did something, so the beat follows
// them rather than running flat out regardless.
let lastClipboardChangeAt = Date.now();
let pollInterval = POLL_INTERVAL;

function startPolling(interval) {
  const next = interval || POLL_INTERVAL;
  if (pollTimer && next === pollInterval) return;
  if (pollTimer) clearInterval(pollTimer);
  pollInterval = next;
  pollTimer = setInterval(tickClipboard, next);
}

// Something happened. Go back to watching closely.
function clipboardIsBusy() {
  lastClipboardChangeAt = Date.now();
  if (pollInterval !== POLL_INTERVAL) startPolling(POLL_INTERVAL);
}

function tickClipboard() {
  pollClipboard();
  const quietFor = Date.now() - lastClipboardChangeAt;
  if (quietFor > POLL_CALM_AFTER_MS && pollInterval === POLL_INTERVAL) {
    startPolling(POLL_IDLE_INTERVAL);
  }
}

// A cheap way to tell whether the image on the clipboard is the one we already
// looked at. Dimensions and formats on their own are not enough -- two
// screenshots of the same window differ in neither -- so it includes a hash of
// a thumbnail, which is where nearly all of the remaining cost is.
let lastImageFingerprint = '';
function imageFingerprint(img, formatsKey) {
  const s = img.getSize();
  const thumb = img.resize({ width: 128, quality: 'good' }).toPNG();
  return formatsKey + '|' + s.width + 'x' + s.height + '|' + hash(thumb);
}

function pollClipboard() {
  if (isPaused) {
    rememberPausedClipboard();
    return;
  }
  if (shouldIgnorePausedClipboard()) return;

  // Every change the clipboard goes through, whether or not Stash keeps it.
  // A copy that produces no clip at all is invisible in every other log --
  // there is nothing to attach the record to -- and that is exactly the case
  // worth seeing: Figma copies that landed nowhere.
  // Declared out here because the image check below needs it too, and it is
  // the one signal that costs nothing at all -- 0.04ms against 19ms to read
  // the bitmap and 336ms to encode it.
  let key = '';
  try {
    const formats = clipboard.availableFormats();
    key = formats.join(',');
    if (key !== lastFormatsKey) {
      lastFormatsKey = key;
      // Whatever it was, the clipboard moved. Watch closely again.
      clipboardIsBusy();
      clipboardLog.unshift({ at: Date.now(), formats });
      clipboardLog.length = Math.min(clipboardLog.length, 10);
    }
  } catch (_) { /* a clipboard that will not list itself is not a problem */ }

  try {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      // Notice whether anything changed BEFORE paying to encode it.
      //
      // This used to encode the whole image to PNG and hash it, and only then
      // compare -- every 600ms, for as long as the image sat on the clipboard.
      // An image stays there until something replaces it, so that was not a
      // cost per copy but a permanent one: measured at 336ms per poll for a
      // 4K screenshot, which is 56% of a core, for ever, while nobody is doing
      // anything. It is the likeliest thing behind "Stash is eating my CPU",
      // and it is worst for exactly the people this is built for -- a designer
      // copying Retina screenshots and Figma frames always has a big image
      // sitting there.
      //
      // A 128px thumbnail is enough to tell whether the clipboard changed and
      // costs about a tenth as much (29ms against 336ms at 4K), nearly all of
      // which is reading the bitmap at all. The full encode still happens, but
      // once per actual copy rather than a hundred times a minute.
      const fp = imageFingerprint(img, key);
      if (fp === lastImageFingerprint) return;
      lastImageFingerprint = fp;
      clipboardIsBusy();

      const png = img.toPNG();
      if (png && png.length > 0) {
        const sig = 'img:' + hash(png);
        if (sig === lastSig) return;

        const size = img.getSize();
        const text = clipboard.readText();
        const isTinyIncidental = size.width < 16 && size.height < 16;

        if (!(text && isTinyIncidental)) {
          lastSig = sig;
          // A design tool puts a picture of the selection on the clipboard AND
          // its own description of that selection, in different flavours. The
          // picture used to win outright and the description was thrown away,
          // so a frame copied out of Figma became an anonymous screenshot that
          // could not be pasted back as a frame. Both are kept: the picture is
          // what you see, the payload is what makes it paste.
          const styled = readStyled();
          const asset = sniffAsset('', styled.html);
          try {
            assetLog.unshift({ at: Date.now(), asset: asset || 'image (no scene payload)',
                               formats: clipboard.availableFormats() });
            assetLog.length = Math.min(assetLog.length, 6);
          } catch (_) { /* a clipboard that will not list itself is not a problem */ }
          ingestImage(png, asset ? { asset, html: styled.html } : null);
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
      historyStore.add(existing);
      // copying it again counts as copying it, so a live session takes it too
      broadcastPromote(existing, collectIfActive(existing));
      return;
    }

    // A design asset is still text underneath -- it drags, searches and stores
    // as text -- so this rides alongside the type rather than replacing it.
    const asset = sniffAsset(text, styled.html);
    // Read once, here, rather than on every render: the payload runs to tens of
    // kilobytes of JSON and the list redraws often.
    const scene = asset === 'paper' ? paperScene(styled.html) : null;
    const sceneFields = scene
      ? { assetName: scene.name || '', assetSize: scene.size || '' }
      : {};

    // What the source app actually offered. A Figma frame cannot be drawn from
    // the flavour we keep, but if Figma also puts a picture or a PDF on the
    // pasteboard then a real preview is possible -- and this is the only way to
    // find out from a machine that has no Figma on it.
    if (asset) {
      try {
        assetLog.unshift({ at: Date.now(), asset, formats: clipboard.availableFormats() });
        assetLog.length = Math.min(assetLog.length, 6);
      } catch (_) { /* a clipboard that will not list itself is not a problem */ }
    }

    // The same copy arriving in pieces, rather than a second copy.
    const upgraded = coalesceRecent(text, styled, asset, sceneFields);
    if (upgraded) {
      broadcastPromote(upgraded, collectIfActive(upgraded));
      return;
    }

    addEntry({
      id: sig,
      type: sniffType(text),
      content: text,
      ts: Date.now(),
      ...styled,
      ...(asset ? { asset } : {}),
      ...sceneFields,
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
  // The catch belongs around the clipboard read and nothing else. With the
  // decision inside it too, a fault in the decision was indistinguishable from
  // a clipboard with no HTML on it -- styled text simply stopped working, in
  // silence.
  let html = null;
  try { html = clipboard.readHTML(); } catch (_) { /* no HTML is the normal case */ }
  if (html) {
    // A Figma frame lives in the HTML flavour, so for those the payload is the
    // clip rather than formatting around it, and the cap meant for stray Word
    // scaffolding would silently throw the frame away.
    const cap = htmlCapFor(html, STYLED_MAX);
    if (html.length <= cap) out.html = html;
    else console.log(`[Stash] dropped ${(html.length / 1024).toFixed(0)}KB of HTML — over the cap`);
  }
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
    const image = nativeImage.createFromPath(entry.filepath);
    // A picture of a frame that also carries the frame goes back with both, so
    // the design tool can take its own description and everything else still
    // sees a picture. Writing only the image is what made a copied frame paste
    // into Figma as a flat screenshot.
    if (!plain && entry.html) {
      clipboard.write({ image, html: entry.html, text: entry.content || '' });
      return;
    }
    clipboard.writeImage(image);
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

  history = history.filter(h => h.id !== entry.id);
  history.unshift(entry);
  historyStore.add(entry);
  if (history.length > HISTORY_LIMIT) {
    const dropped = history.splice(HISTORY_LIMIT);
    dropped.forEach(d => {
      historyStore.remove(d.id);
      // splice already took it out of history, so the reference check below is
      // asking whether anything *else* still wants the picture.
      dropImageFile(d.filepath);
    });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clip:new', entry, collected);
  }
  if (dockWindow && dockWindow.isVisible()) refreshDock();
  refreshTrayMenu();
  attachSourceApp(entry);
}

// ---------- ipc ----------
ipcMain.handle('history:get', () => ({ history, pinned, sourceIcons, ...sessionState() }));

ipcMain.handle('appearance:get', () => ({
  choice: settings.appearance || 'system',
  dark: nativeTheme.shouldUseDarkColors,
}));
ipcMain.handle('appearance:set', (_e, choice) => setAppearance(choice));

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
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
  saveSessions();
  saveSettings();
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

// History can be reordered too, now that it survives a restart. It could not
// when it was memory-only and capped -- an order arranged there undid itself at
// the next launch, so the handle was left inert in the one place people spend
// most of their time. The log is append-only, so the new order is persisted by
// rewriting it, which is what compact already does.
ipcMain.handle('order:history', (_e, ids) => {
  if (!Array.isArray(ids)) return false;
  const moved = reorderWithin(history, ids);
  if (moved) {
    historyStore.reorder(history.map(h => h.id));
    broadcastState();
  }
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
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
  }
  return ok;
});

ipcMain.handle('clip:unpin', (_e, id) => {
  const ok = unpinItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
  }
  return ok;
});

ipcMain.handle('clip:prompt', (_e, id) => {
  const ok = promptItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
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

  let inHistory = false;

  const apply = (entry) => {
    if (clean) entry.name = clean;
    else delete entry.name;   // an empty name is a reset, not a blank title
    touched = true;
  };

  history.forEach(h => { if (h.id === id) { apply(h); inHistory = true; } });
  pinned.forEach(p => { if (p.id === id) { apply(p); inPinned = true; } });
  sessionClips.forEach(s => { if (s.id === id) { apply(s); inSessions = true; } });

  // Every store the clip sits in gets written, history included — a name is
  // worth more than the clip it is on, and losing it to a restart was the
  // thing that made naming an unpinned clip feel pointless.
  if (inHistory) history.forEach(h => { if (h.id === id) historyStore.add(h); });
  if (inPinned) savePinned();
  if (inSessions) saveSessions();
  return touched;
}

ipcMain.handle('clip:rename', (_e, id, name) => {
  const ok = renameClip(id, name);
  if (ok) {
    refreshTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
    }
    if (dockWindow && dockWindow.isVisible()) refreshDock();
  }
  return ok;
});

// The words a clip arrived with are not always the words you want to paste: a
// snippet comes with a stray line above it, a link comes with tracking on the
// end, a stretch of read-back text comes close but not right. Editing used to
// be a prompt's privilege alone, which put a filing decision -- "save this as
// a prompt first" -- in front of fixing a typo.
//
// The captured text is kept the first time an edit lands, and only then, so
// reset has somewhere to go back to and the clips nobody touches store nothing
// extra. What was derived from the words goes with them: the styled copies
// describe sentences that are no longer there, an asset describes a shape no
// longer being carried, and a link edited into a sentence has stopped being a
// link.
//
// Like a name, the text belongs to the clip rather than to one copy of it. The
// same id can sit in history, in pinned and in any number of collections at
// once, and one drawer showing the same clip under two different texts is the
// bug this avoids.
const CLIP_TEXT_MAX = 100000;

function writeClipText(id, next, isReset) {
  let inHistory = false, inPinned = false, inSessions = false;

  const apply = (entry) => {
    // A picture has no words to edit. Refusing here means a stray id cannot
    // quietly turn a screenshot into a text clip.
    if (entry.type === 'img') return false;
    if (isReset) delete entry.originalContent;   // it is the original again
    else if (typeof entry.originalContent !== 'string') entry.originalContent = entry.content || '';
    if (entry.content !== next) {
      delete entry.html;
      delete entry.rtf;
      delete entry.asset;
      delete entry.assetName;
      delete entry.assetSize;
    }
    entry.content = next;
    entry.type = sniffType(next);
    entry.updatedAt = Date.now();
    return true;
  };

  history.forEach(h => { if (h.id === id && apply(h)) inHistory = true; });
  pinned.forEach(p => { if (p.id === id && apply(p)) inPinned = true; });
  sessionClips.forEach(s => { if (s.id === id && apply(s)) inSessions = true; });
  if (!inHistory && !inPinned && !inSessions) return false;

  // History is written too, for the reason a name is: an edit is worth more
  // than the clip it sits on, and losing it to a restart would make editing an
  // unpinned clip pointless.
  if (inHistory) history.forEach(h => { if (h.id === id) historyStore.add(h); });
  if (inPinned) savePinned();
  if (inSessions) saveSessions();
  return true;
}

function editClipContent(id, content) {
  if (typeof content !== 'string') return false;
  const next = content.slice(0, CLIP_TEXT_MAX);
  // Refuse to empty a clip. That is a delete, and there is a button for it.
  if (!next.trim()) return false;
  return writeClipText(id, next, false);
}

// Back to the words it was captured with. Only a clip that has actually been
// edited has anywhere to go back to, so this says no rather than quietly doing
// nothing and leaving the drawer to claim it worked.
function resetClipContent(id) {
  const source = history.find(h => h.id === id)
              || pinned.find(p => p.id === id)
              || sessionClips.find(s => s.id === id);
  if (!source || typeof source.originalContent !== 'string') return false;
  return writeClipText(id, source.originalContent, true);
}

// An edited clip shows up on the row, in the tray and in the dock, all of
// which are reading the same three stores this just rewrote.
function announceClipChange() {
  refreshTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
  }
  if (dockWindow && dockWindow.isVisible()) refreshDock();
}

ipcMain.handle('clip:edit', (_e, id, content) => {
  const ok = editClipContent(id, content);
  if (ok) announceClipChange();
  return ok;
});

ipcMain.handle('clip:resetContent', (_e, id) => {
  const ok = resetClipContent(id);
  if (ok) announceClipChange();
  return ok;
});

ipcMain.handle('prompt:update', (_e, id, patch) => {
  const ok = updatePrompt(id, patch);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
  }
  return ok;
});

ipcMain.handle('clip:unprompt', (_e, id) => {
  const ok = unpromptItem(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
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

// Changing a key can fail -- the whole point of letting someone change it is
// that another app may already have the one they had. So it is tried, and put
// back if it does not take: a settings panel that silently leaves you with no
// shortcut at all is worse than the conflict it was meant to solve.
ipcMain.handle('shortcuts:set', (_e, patch) => {
  const wanted = { ...currentAccelerators(), ...(patch || {}) };
  for (const which of ['drawer', 'dock']) {
    if (!validAccelerator(wanted[which])) {
      return { ok: false, reason: 'that is not a shortcut Stash can use', ...shortcutsReport() };
    }
  }
  if (wanted.drawer === wanted.dock) {
    return { ok: false, reason: 'both would be the same key', ...shortcutsReport() };
  }
  const before = settings.shortcuts;
  settings.shortcuts = wanted;
  registerShortcuts();
  if (!shortcutState.drawer || !shortcutState.dock) {
    // hand back whatever worked before rather than leaving them with nothing
    settings.shortcuts = before;
    registerShortcuts();
    return { ok: false, reason: 'another app is already using that', ...shortcutsReport() };
  }
  saveSettings();
  return { ok: true, ...shortcutsReport() };
});

ipcMain.handle('shortcuts:get', () => shortcutsReport());

function shortcutsReport() {
  const keys = currentAccelerators();
  return {
    keys,
    // what to print on a key cap, which is not what gets registered
    labels: { drawer: humanAccelerator(keys.drawer), dock: humanAccelerator(keys.dock) },
    held: { drawer: shortcutState.drawer, dock: shortcutState.dock },
    defaults: DEFAULT_SHORTCUTS,
  };
}

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
    historyStore.add(existing);
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
  historyStore.remove(id);

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
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
  }
  return true;
});

ipcMain.handle('clip:clear', () => {
  // Only clear history, never pinned. Pinned is explicit user commitment.
  const wasHolding = history;
  history = [];
  wasHolding.forEach(h => dropImageFile(h.filepath));
  historyStore.clear();
  refreshTrayMenu();
  return true;
});

// The window is wider than the drawer so the side panel has somewhere to go.
// While the panel is shut that extra width is transparent and empty, and the
// renderer asks for it to stop catching the mouse as the pointer crosses in.
// `forward` keeps mouse events coming to the renderer while they are being
// passed through, which is the only way it can tell the pointer has left again.
ipcMain.handle('window:clickThrough', (_e, on) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setIgnoreMouseEvents(!!on, { forward: true });
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
  // SVG dragged out as a .txt is something the target app refuses to open, so
  // a design asset leaves under the extension it actually is.
  const ext = extensionFor(entry.asset);
  const filepath = path.join(TMP_DIR, `${safe}-${Date.now()}-${index}${ext}`);
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
  // A Figma frame is not a file and cannot be made into one -- its payload is a
  // clipboard flavour that only Figma's own paste handler can read. Dragging it
  // out wrote a .txt of the frame's *text*, which Figma then refused to import,
  // and the refusal was the first anyone heard about it. So the gesture does
  // the thing the user meant instead: puts the frame back on the clipboard, and
  // says which key finishes the job.
  if (entry && (entry.asset === 'figma' || entry.asset === 'paper')) {
    writeClip(entry, false);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clip:pasteInstead', {
        tool: entry.asset === 'paper' ? 'Paper' : 'Figma',
        key: process.platform === 'darwin' ? '⌘V' : 'Ctrl+V',
      });
    }
    return;
  }
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
    mainWindow.webContents.send('state:updated', { history, pinned, sourceIcons, ...sessionState() });
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
    // Reading it by hand is a read like any other, so the index takes it too
    // rather than making the background queue do the same work again.
    rememberOcrText(entry.id, blocks.map(b => b.text).join('\n'));
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
  settleCheck({ status: 'downloading', version: info.version });
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
  settleCheck({ status: 'current', version: app.getVersion() });
});

autoUpdater.on('error', (err) => {
  // Offline, rate-limited, or a release without an update feed. For the check
  // that runs on its own there is nothing to act on, so the badge stays hidden
  // and the app carries on -- but somebody who pressed a button is owed an
  // answer, even when the answer is that it did not work.
  console.log('[Stash] update check failed:', (err && err.message) || err);
  settleCheck({ status: 'failed', detail: (err && err.message) || String(err) });
});

// A check somebody asked for, as opposed to the hourly one nobody sees.
// autoUpdater reports through events rather than the promise it returns, so
// this waits for whichever event arrives -- and gives up rather than leaving
// a button spinning for ever if none does.
let pendingCheck = null;
function settleCheck(result) {
  if (!pendingCheck) return;
  const { resolve, timer } = pendingCheck;
  pendingCheck = null;
  clearTimeout(timer);
  resolve(result);
}

// macOS will not let an app replace itself unless it is installed. Run from a
// mounted .dmg, or from Downloads with the quarantine flag still on it, and
// the updater fails in a way that reads as "the button does nothing" -- which
// is exactly how this was reported. Saying so is the whole fix.
function updateBlockedReason() {
  if (process.platform !== 'darwin') return null;
  const where = app.getPath('exe');
  if (where.includes('/Applications/')) return null;
  if (where.includes('/Volumes/')) {
    return 'Stash is running from the disk image. Drag it to Applications first.';
  }
  return 'Stash is not in your Applications folder, so macOS will not let it update itself.';
}

ipcMain.handle('update:check', () => {
  // A dev run has no feed to read and no installed copy to replace. Saying so
  // beats a button that looks broken.
  if (isDev || !app.isPackaged) {
    return { status: 'dev', version: app.getVersion() };
  }
  const blocked = updateBlockedReason();
  if (blocked) return { status: 'failed', detail: blocked };
  // Already downloaded and waiting for a restart: that is the answer.
  if (updateState && updateState.status === 'ready') {
    return { ...updateState };
  }
  if (pendingCheck) return pendingCheck.promise;

  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const timer = setTimeout(() => settleCheck({ status: 'failed', detail: 'no answer' }), 20000);
  pendingCheck = { resolve, timer, promise };
  autoUpdater.checkForUpdates().catch(() => { /* the error event settles it */ });
  return promise;
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
ipcMain.handle('app:version', () => app.getVersion());

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
// Which of the two shortcuts we actually hold. A shortcut belongs to whichever
// app asked for it first, so another app -- or a second copy of Stash -- can
// simply have it, and registering fails with a plain false.
let shortcutState = { drawer: true, dock: true, keys: null };
// Warn on the way into trouble, not on every health check: registerShortcuts
// runs every 30 seconds, on resume, on unlock and on a display change.
let warnedAboutShortcuts = false;

// An accelerator as a person would read it. CommandOrControl is the right thing
// to register and the wrong thing to show: nobody has that key.
function humanAccelerator(accel) {
  const mac = process.platform === 'darwin';
  return String(accel || '')
    .replace(/CommandOrControl|Command|Cmd/g, mac ? 'Cmd' : 'Ctrl')
    .replace(/Control|Ctrl/g, mac ? 'Ctrl' : 'Ctrl')
    .replace(/Option|Alt/g, mac ? 'Option' : 'Alt')
    .replace(/Super|Meta/g, mac ? 'Cmd' : 'Win');
}

// What to say about the state, or null when there is nothing wrong. Kept apart
// from the registering so it can be tested without a running app.
function shortcutTrouble(state) {
  const keys = state.keys || { drawer: DEFAULT_SHORTCUTS.drawer, dock: DEFAULT_SHORTCUTS.dock };
  const lost = [];
  if (!state.drawer) lost.push({ what: 'Stash', key: humanAccelerator(keys.drawer) });
  if (!state.dock) lost.push({ what: 'the quick dock', key: humanAccelerator(keys.dock) });
  if (!lost.length) return null;
  const lostKeys = lost.map(l => l.key).join(' and ');
  return {
    // the tray line, which is where someone looks when the key does nothing
    label: lost.length === 2
      ? 'Both shortcuts are taken by another app'
      : `${lost[0].key} is taken by another app`,
    title: 'Stash could not claim its shortcut',
    body: lost.length === 2
      ? `Another app is using ${lostKeys}. Open Stash from the tray instead.`
      : `Another app is using ${lostKeys}, so it will not open ${lost[0].what}. `
        + 'Open Stash from the tray instead.',
  };
}

// ---------- surviving a crash ----------
//
// A renderer can die on its own -- a GPU fault, an out-of-memory kill, a bug --
// and until this existed nothing noticed. Killing every renderer of a healthy
// instance left the main process running, the tray sitting there and the
// shortcut still registered, with not one line logged: the drawer would open as
// a window with nothing in it while clipboard polling carried on behind it.
// That is the worst shape for a clipboard manager, because the person keeps
// copying and only finds out later.
//
// Kept for the diagnostics report, which is what gets pasted back when someone
// says it stopped working.
const crashLog = [];
function noteCrash(what, detail) {
  crashLog.unshift({ at: Date.now(), what, detail });
  crashLog.length = Math.min(crashLog.length, 10);
  console.error(`[Stash] ${what}: ${detail}`);
}

// A window whose renderer keeps dying is a window that will keep dying, and
// reloading it forever burns CPU and hides the problem. After this many in a
// short window, leave it and say so.
const RELOAD_LIMIT = 3;
const RELOAD_WINDOW_MS = 60 * 1000;
const reloadTimes = new Map();

function watchForCrashes(win, which) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on('render-process-gone', (_e, details) => {
    noteCrash(`the ${which} stopped`, details.reason + (details.exitCode ? ' (' + details.exitCode + ')' : ''));
    // A clean exit is the window being closed on purpose; nothing to recover.
    if (details.reason === 'clean-exit') return;
    if (win.isDestroyed()) return;

    const now = Date.now();
    const recent = (reloadTimes.get(which) || []).filter(t => now - t < RELOAD_WINDOW_MS);
    if (recent.length >= RELOAD_LIMIT) {
      noteCrash(`the ${which} keeps crashing`, `gave up after ${RELOAD_LIMIT} reloads in a minute`);
      return;
    }
    recent.push(now);
    reloadTimes.set(which, recent);
    console.log(`[Stash] reloading the ${which} (attempt ${recent.length})`);
    try { win.webContents.reload(); } catch (err) { noteCrash('reload failed', err.message); }
  });

  win.webContents.on('unresponsive', () => noteCrash(`the ${which} stopped responding`, 'still waiting'));
  win.webContents.on('responsive', () => console.log(`[Stash] the ${which} is responding again`));
}

function registerShortcuts() {
  // Always unregister first to be safe — prevents accidental duplicate handlers
  try { globalShortcut.unregisterAll(); } catch (_) {}

  const keys = currentAccelerators();
  // A key the OS rejects outright throws rather than returning false.
  const claim = (accel, fn) => { try { return globalShortcut.register(accel, fn); } catch (_) { return false; } };
  const drawerReg = claim(keys.drawer, toggleWindow);
  const dockReg = claim(keys.dock, toggleDock);

  const before = shortcutState;
  shortcutState = { drawer: drawerReg, dock: dockReg, keys };

  console.log(`[Stash] shortcuts registered — drawer: ${drawerReg}, dock: ${dockReg}`);
  if (!drawerReg) console.warn('[Stash] drawer hotkey registration failed (conflict?)');
  if (!dockReg) console.warn('[Stash] dock hotkey registration failed (conflict?)');

  // A shortcut that does nothing and says nothing is indistinguishable from an
  // app that has crashed. This cost a whole afternoon: a second copy of Stash
  // held the key, every press went to it, and the only sign anywhere was a line
  // in a log nobody reads.
  const trouble = shortcutTrouble(shortcutState);
  if (trouble && !warnedAboutShortcuts) {
    warnedAboutShortcuts = true;
    // Logged as well as shown: a notification that never appears is otherwise
    // indistinguishable from one that was never raised, and this is the exact
    // situation where someone is already trying to work out why nothing works.
    console.warn(`[Stash] ${trouble.label} — ${trouble.body}`);
    try {
      if (Notification.isSupported()) {
        new Notification({ title: trouble.title, body: trouble.body }).show();
      } else {
        console.warn('[Stash] notifications are not available to say so');
      }
    } catch (err) {
      // a missing notification must never take the app with it
      console.warn('[Stash] could not raise the shortcut notification: ' + err.message);
    }
  }
  // Recovered -- the health check re-registers every 30 seconds, so quitting
  // whatever held the key is enough. Arm the warning again for next time.
  if (!trouble) warnedAboutShortcuts = false;

  if (before.drawer !== drawerReg || before.dock !== dockReg) refreshTrayMenu();
  return drawerReg && dockReg;
}

// The GPU process dying is usually survivable -- Chromium starts another and
// the window repaints -- but it is worth saying so, because it is the loudest
// thing in the log when something goes wrong and it needs to be attributable.
app.on('child-process-gone', (_e, details) => {
  if (details.reason === 'clean-exit') return;
  noteCrash(`the ${details.type} process stopped`, details.reason);
});

// Without these, one unhandled error in the main process takes the tray, the
// clipboard poller and the shortcuts with it -- and a clipboard manager that
// has quietly stopped capturing is worse than one that has visibly crashed.
// Staying up on an unknown error is a deliberate trade: the alternative is
// silently capturing nothing.
process.on('uncaughtException', (err) => {
  const where = (err && err.stack) || String(err);
  noteCrash('an error escaped', where.split('\n').slice(0, 3).join(' | '));
});
process.on('unhandledRejection', (reason) => {
  noteCrash('a promise was rejected with nobody listening', String(reason && reason.message || reason));
});

app.setAppUserModelId('com.harikrish.stash');

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Set up persistence paths (now that app is ready)
  pinnedStorePath = path.join(app.getPath('userData'), 'pinned.json');
  settingsStorePath = path.join(app.getPath('userData'), 'settings.json');
  sessionStorePath = path.join(app.getPath('userData'), 'sessions.json');
  sourceIconStorePath = path.join(app.getPath('userData'), 'source-icons.json');
  loadSourceIcons();
  thumbDir = path.join(app.getPath('userData'), 'thumbs');
  try {
    fs.mkdirSync(thumbDir, { recursive: true });
  } catch (err) {
    console.warn('[Stash] no thumbnail cache:', err.message);
    thumbDir = null;
  }

  historyImageDir = path.join(app.getPath('userData'), 'history-images');
  try {
    fs.mkdirSync(historyImageDir, { recursive: true });
  } catch (err) {
    console.error('[Stash] no history image directory, falling back to temp:', err.message);
    historyImageDir = null;
  }
  loadPinned();
  loadSettings();
  loadSessions();
  restoreHistory();
  gcHistoryImages();
  pruneHistoryImages();
  startOcrIndexer();
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
  // The OS flipped its appearance under a 'system' choice, so the drawer is
  // told. It is told and nothing more: this used to call applyAppearance,
  // which assigns themeSource, which emits this event again -- see the note
  // there for what that cost.
  nativeTheme.on('updated', () => {
    if (appearanceChoice() === 'system') notifyAppearance();
  });

  console.log('[Stash] tray created:', tray ? 'yes' : 'no');
  console.log('[Stash] platform:', process.platform);
  console.log('[Stash] assets dir:', path.join(__dirname, '..', 'assets'));
  console.log('[Stash] pinned store:', pinnedStorePath);
  console.log('[Stash] session store:', sessionStorePath);
  console.log('[Stash] settings store:', settingsStorePath);

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
    const k = currentAccelerators();
    if (!globalShortcut.isRegistered(k.drawer) || !globalShortcut.isRegistered(k.dock)) {
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
    mainWindow.setBounds(drawerBounds(drawerDisplay(false)));
  }
  screen.on('display-added', reseatDrawer);
  screen.on('display-removed', reseatDrawer);
  screen.on('display-metrics-changed', reseatDrawer);

  // Periodic health check — cheap (just two boolean reads) and catches any
  // edge case the above handlers miss. Runs every 30 seconds.
  setInterval(() => {
    try {
      const k = currentAccelerators();
      const drawerOk = globalShortcut.isRegistered(k.drawer);
      const dockOk = globalShortcut.isRegistered(k.dock);
      if (!drawerOk || !dockOk) {
        console.log('[Stash] health check found dropped shortcut — re-registering');
        registerShortcuts();
      }
    } catch (_) {}
  }, 30000);

  // Anything whose preview was not cached yet gets one, quietly, now that the
  // app is up and answering.
  rebuildThumbsInBackground();

  startPolling();
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
  if (ocrIndexer) ocrIndexer.stop();
  // the helper is a separate process and will not go on its own
  if (sourceApp) sourceApp.stop();
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

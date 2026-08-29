// The settings panel, and the shortcut recorder in it.
//
// Two halves: the accelerator rules lifted out of main.js, and the real drawer
// driven through the gear.
//
// The shortcut is the setting that most needs to be reachable and was least
// reachable: it lived in no UI at all, and the one thing you cannot use to
// reach a settings panel is a shortcut another app has taken.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// Lift a declaration out of main.js: from where it starts to the first line
// that closes at column 0. Both endings matter — a function closes with `}`
// and an array with `];`, and looking only for the first swallowed whatever
// came next.
function lift(opening) {
  const at = MAIN.indexOf(opening);
  if (at === -1) throw new Error('could not find ' + opening + ' in main.js');
  const rest = MAIN.slice(at);
  // a declaration that finishes on its own line finishes there
  const firstLine = rest.slice(0, rest.indexOf('\n'));
  if (firstLine.trimEnd().endsWith(';')) return firstLine;
  const m = rest.match(/\n(\}|\];|\};)/);
  if (!m) throw new Error('could not find the end of ' + opening);
  return rest.slice(0, m.index + m[0].length);
}

// ---------- part 1: what counts as a shortcut ----------
const ctx = { process: { platform: 'win32' } };
vm.createContext(ctx);
vm.runInContext(
  lift('const ACCEL_MODIFIERS = ') + '\n'
  + lift('const ACCEL_KEYS = ') + '\n'
  + lift('function validAccelerator(')
  + '\nthis.validAccelerator = validAccelerator;', ctx);
const valid = ctx.validAccelerator;

ok('the shipped drawer key is acceptable', valid('CommandOrControl+Shift+V') === true, '');
ok('so is a plain ctrl+alt combination', valid('CommandOrControl+Alt+K') === true, '');
ok('and a function key with a modifier', valid('Alt+F5') === true, '');

// A bare key registers globally and swallows that key everywhere on the
// machine — typing "v" would open Stash instead of typing.
ok('a key with no modifier is refused', valid('V') === false, 'V');
ok('and so is a modifier with no key', valid('Shift') === false, 'Shift');
ok('nonsense is refused', valid('Ctrl+Splat') === false, '');
ok('an empty shortcut is refused', valid('') === false, '');
ok('and so is a repeated modifier', valid('Shift+Shift+V') === false, '');
ok('a non-string is refused rather than throwing', valid(null) === false, '');

// the handler has to put back what worked when the new key does not
ok('a refused key restores the one that worked',
   MAIN.includes('settings.shortcuts = before;'), '');
// Within the handler, not anywhere in the file: saveSettings is called all
// over main.js, so an indexOf against the whole thing proves nothing.
const setHandler = lift("ipcMain.handle('shortcuts:set'");
ok('and only saves once the new one is actually held',
   setHandler.indexOf('saveSettings();')
     > setHandler.indexOf("reason: 'another app is already using that'"),
   'revert at ' + setHandler.indexOf("reason: 'another app is already using that'")
     + ', save at ' + setHandler.indexOf('saveSettings();'));
ok('the same key for both is refused',
   MAIN.includes("reason: 'both would be the same key'"), '');
ok('registration uses the configured keys, not the shipped ones',
   MAIN.includes('const keys = currentAccelerators();'), '');
ok('and the health check watches the configured ones too',
   MAIN.includes('globalShortcut.isRegistered(k.drawer)'), '');

// ---------- part 2: the panel ----------
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 986, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms || 20));

    let savedSettings = null, savedShortcuts = null;
    let shortcuts = {
      keys: { drawer: 'CommandOrControl+Shift+V', dock: 'CommandOrControl+Shift+Space' },
      labels: { drawer: 'Ctrl+Shift+V', dock: 'Ctrl+Shift+Space' },
      held: { drawer: true, dock: true },
      defaults: { drawer: 'CommandOrControl+Shift+V', dock: 'CommandOrControl+Shift+Space' },
    };
    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
      getSettings: async () => ({ rememberHistory: true, indexImageText: true,
                                  recordSourceApp: true, watchScreenshots: true,
                                  autoPasteFromDock: false }),
      setSettings: async (patch) => { savedSettings = patch; },
      getShortcuts: async () => shortcuts,
      setShortcuts: async (patch) => {
        savedShortcuts = patch;
        // the drawer must cope with a refusal, so refuse this one
        if (patch.drawer === 'CommandOrControl+Shift+T') {
          return { ok: false, reason: 'another app is already using that', ...shortcuts };
        }
        shortcuts = { ...shortcuts, keys: { ...shortcuts.keys, ...patch } };
        return { ok: true, ...shortcuts };
      },
    };
    pinned = []; history = []; render();

    const sheet = document.getElementById('settingsSheet');
    const gear = document.getElementById('settingsBtn');
    ok('the drawer has a gear', !!gear, '');
    ok('and the panel starts shut', !sheet.classList.contains('show'), '');

    gear.click();
    await tick(60);
    ok('the gear opens it', sheet.classList.contains('show'), '');
    ok('and the gear shows it is open', gear.classList.contains('on'), '');

    // the toggles have to arrive showing what is actually set
    const remember = document.querySelector('[data-setting="rememberHistory"]');
    const autopaste = document.querySelector('[data-setting="autoPasteFromDock"]');
    ok('a setting that is on arrives on', remember.checked === true, '');
    ok('and one that is off arrives off', autopaste.checked === false, '');

    remember.checked = false;
    remember.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    ok('turning one off saves it',
       savedSettings && savedSettings.rememberHistory === false, JSON.stringify(savedSettings));

    // --- the key cap ---
    const cap = document.getElementById('drawerKey');
    ok('the key cap shows the key as a person would read it',
       cap.textContent === 'Ctrl+Shift+V', cap.textContent);

    cap.click();
    await tick();
    ok('clicking it starts listening', cap.classList.contains('recording'), cap.className);
    ok('and it says so in words, not only in colour',
       /press/i.test(cap.textContent), cap.textContent);

    // A modifier on its own is not a combination — it is the way to one.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await tick();
    ok('a modifier on its own does not end the recording',
       cap.classList.contains('recording'), cap.className);
    ok('and nothing was saved for it', savedShortcuts === null, JSON.stringify(savedShortcuts));

    // a real combination
    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'j', ctrlKey: true, altKey: true, bubbles: true }));
    await tick(60);
    ok('a real combination is sent to be claimed',
       savedShortcuts && savedShortcuts.drawer === 'CommandOrControl+Alt+J',
       JSON.stringify(savedShortcuts));
    ok('and the cap stops listening once it takes',
       !cap.classList.contains('recording'), cap.className);

    // --- a key another app already has ---
    savedShortcuts = null;
    cap.click();
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 't', ctrlKey: true, shiftKey: true, bubbles: true }));
    await tick(80);
    ok('a key another app holds is refused out loud',
       /already using/.test(cap.textContent), cap.textContent);
    ok('and the cap says it was refused',
       cap.classList.contains('rejected'), cap.className);

    // --- escape ---
    await tick(1500);   // let the refusal clear itself
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(60);
    ok('escape closes the panel', !sheet.classList.contains('show'), '');
    ok('and the gear stops looking open', !gear.classList.contains('on'), '');

    // --- a key we do not hold has to look wrong ---
    shortcuts = { ...shortcuts, held: { drawer: false, dock: true } };
    gear.click();
    await tick(60);
    ok('a key another app has taken is marked on the cap',
       document.getElementById('drawerKey').classList.contains('taken'),
       document.getElementById('drawerKey').className);
    ok('and said in words beside it',
       /another app/i.test(document.getElementById('drawerKeyNote').textContent),
       document.getElementById('drawerKeyNote').textContent);

    return out;
  })()`;

  let rendered;
  try {
    rendered = await win.webContents.executeJavaScript(probe, true);
  } catch (err) {
    console.log('PROBE THREW: ' + err.message);
    app.exit(1);
    return;
  }

  const all = results.concat(rendered);
  let failed = 0;
  for (const r of all) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  }
  console.log(`\n${all.length - failed}/${all.length} passed`);
  app.exit(failed ? 1 : 0);
});

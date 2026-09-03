// Driving the list without a mouse.
//
// The drawer is a keyboard tool that, once the shortcut had opened it, could
// only be used by pointing: no way to walk the list, no way to copy without
// reaching for the mouse. Arrows move a cursor, Enter copies the row it is on.
//
// The cursor is a third idea alongside hover and selection, and the risk is it
// stealing keys from the things that already use them — the editor, a tag
// field, the shortcut recorder — so most of what is checked here is that it
// keeps out of the way.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const SRCDIR = path.join(__dirname, '..', 'src');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 986, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

    let copied = null;
    window.api = {
      write: async (c) => { copied = c && c.id; },
      delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true,
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
      getSettings: async () => ({}), setSettings: async () => {}, getShortcuts: async () => null,
    };
    pinned = [];
    history = Array.from({ length: 5 }, (_, i) => ({
      id: 'c' + i, type: 'text', content: 'clip number ' + i, ts: Date.now() - i * 1000 }));
    render();
    await tick();

    const press = (key, opts) => document.dispatchEvent(
      new KeyboardEvent('keydown', Object.assign({ key, bubbles: true }, opts || {})));
    const cursor = () => document.querySelector('.item.cursor');

    ok('nothing is under the cursor to begin with', !cursor(), '');

    press('ArrowDown');
    await tick();
    ok('down starts at the top of the list',
       cursor() && cursor().dataset.id === 'c0', cursor() ? cursor().dataset.id : 'none');

    press('ArrowDown'); press('ArrowDown');
    await tick();
    ok('and keeps moving down', cursor().dataset.id === 'c2', cursor().dataset.id);

    press('ArrowUp');
    await tick();
    ok('up goes back', cursor().dataset.id === 'c1', cursor().dataset.id);

    // Wrapping would take you somewhere you did not ask to go; stopping at the
    // end is what a list does.
    for (let i = 0; i < 10; i++) press('ArrowDown');
    await tick();
    ok('it stops at the bottom rather than wrapping round',
       cursor().dataset.id === 'c4', cursor().dataset.id);
    for (let i = 0; i < 10; i++) press('ArrowUp');
    await tick();
    ok('and at the top', cursor().dataset.id === 'c0', cursor().dataset.id);

    // Enter does exactly what the row's own copy button does.
    press('Enter');
    await tick(60);
    ok('enter copies the row the cursor is on', copied === 'c0', String(copied));

    // ---- keeping out of the way ----
    copied = null;
    const search = document.getElementById('search');
    search.focus();
    press('ArrowDown');
    await tick();
    ok('arrows still walk the list while the search box has focus',
       cursor().dataset.id === 'c1', cursor().dataset.id);

    // The preview panel edits a clip in a text box, and a text box owns arrows
    // and Enter entirely. There is no flag for this: the panel is guarded by
    // where the focus is, which is the thing that actually decides.
    const before = cursor().dataset.id;
    document.querySelector('.item[data-id="c0"] [data-act="name"]').click();
    await tick(80);
    document.getElementById('inspEdit').focus();
    ok('the panel takes the focus into its text box',
       document.activeElement === document.getElementById('inspEdit'),
       String(document.activeElement && document.activeElement.id));
    press('ArrowDown'); press('Enter');
    await tick(60);
    ok('the panel keeps its own arrows', cursor().dataset.id === before, cursor().dataset.id);
    ok('and its own enter', copied === null, String(copied));
    document.getElementById('inspClose').click();
    await tick(220);

    // The shortcut recorder wants every key there is.
    const gear = document.getElementById('settingsBtn');
    gear.click();
    await tick(60);
    press('ArrowDown');
    await tick();
    ok('the settings sheet keeps its arrows too',
       cursor().dataset.id === before, cursor().dataset.id);
    document.getElementById('settingsClose').click();
    await tick(40);

    // ---- surviving a redraw ----
    press('ArrowDown');
    await tick();
    const held = cursor().dataset.id;
    render();
    await tick();
    ok('the cursor survives a redraw',
       cursor() && cursor().dataset.id === held, cursor() ? cursor().dataset.id : 'lost');

    // and lets go when the row it was on is filtered away
    searchQuery = 'number 4';
    render();
    await tick();
    ok('and lets go when its row is filtered out',
       !cursor() || cursor().dataset.id !== held, cursor() ? cursor().dataset.id : 'none');
    searchQuery = '';
    render();
    await tick();

    return out;
  })()`;

  let rendered;
  const consoleLines = [];
  win.webContents.on('console-message', (_e, _l, text) => consoleLines.push(text));
  try {
    rendered = await win.webContents.executeJavaScript(probe, true);
  } catch (err) {
    console.log('PROBE THREW: ' + err.message);
    consoleLines.filter(l => /error|undefined|not a function/i.test(l))
      .forEach(l => console.log('  renderer: ' + l));
    app.exit(1);
    return;
  }

  let failed = 0;
  for (const r of rendered) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  }
  console.log(`\n${rendered.length - failed}/${rendered.length} passed`);
  app.exit(failed ? 1 : 0);
});

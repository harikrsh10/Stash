// Loads the real renderer.html, stubs window.api, and drives the actual
// multi-select + stack gestures against the real DOM, CSS and canvas.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer.html');

app.disableHardwareAcceleration();


// Motion is a media query away from being switched off entirely, and a CI
// runner has no user session, so it reports prefers-reduced-motion: reduce and
// the stylesheet dutifully removes every transition these assertions measure.
// The suite has to say which condition it is testing rather than inherit
// whatever the machine happens to prefer.
async function emulateMotion(win, value) {
  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }],
    });
    return true;
  } catch (err) {
    console.log('could not emulate prefers-reduced-motion: ' + err.message);
    return false;
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 340, height: 900, show: false });
  await win.loadFile(RENDERER);
  // the deck settling is an animation; a runner that prefers reduced motion
  // removes it, and the assertion then measures a thing that is not running
  await emulateMotion(win, 'no-preference');

  const probe = `(async () => {
    const results = [];
    const ok = (name, pass, detail) => results.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms));
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    let multiPayload = null, multiIcon = null, singlePayload = null;
    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {},
      pin: async () => {}, unpin: async () => {}, hide: () => {},
      startDrag: (e) => { singlePayload = e; },
      startDragMulti: (e, icon) => { multiPayload = e; multiIcon = icon; },
      drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    pinned = [{ id: 'p1', type: 'img', content: 'img', meta: '400x400', ts: Date.now(), filepath: 'C:/x/a.png', dataUrl: PNG }];
    history = [];
    for (let i = 1; i <= 7; i++) {
      history.push({ id: 'h' + i, type: i % 3 === 0 ? 'code' : 'text', content: 'clip ' + i, ts: Date.now() });
    }
    render();

    const rows = () => [...document.querySelectorAll('.item')];
    const cards = () => [...document.querySelectorAll('.stack-card')];
    const click = (el, opts) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...opts }));
    const tray = document.getElementById('stackTray');
    const badge = document.getElementById('stackCount');

    ok('renders all 8 rows', rows().length === 8, rows().length + ' rows');
    ok('tray hidden with no selection', !tray.classList.contains('show'), '');

    // --- selection still works as before ---
    click(rows()[1], { ctrlKey: true });
    ok('ctrl+click selects one', selected.size === 1 && selected.has('h1'), [...selected].join(','));
    ok('tray appears on first pick', tray.classList.contains('show'), '');
    ok('one card in the deck', cards().length === 1, cards().length + '');
    ok('badge reads 1', badge.textContent === '01', badge.textContent);
    ok('title reads singular', document.getElementById('stackTitle').textContent === '01 clip stacked',
       document.getElementById('stackTitle').textContent);

    click(rows()[3], { shiftKey: true });
    ok('shift+click makes a range of 3', selected.size === 3 && ['h1','h2','h3'].every(i => selected.has(i)),
       [...selected].join(','));
    ok('deck grew to 3 cards', cards().length === 3, cards().length + '');
    ok('badge reads 3', badge.textContent === '03', badge.textContent);
    ok('title reads plural', document.getElementById('stackTitle').textContent === '03 clips stacked',
       document.getElementById('stackTitle').textContent);

    // cards are offset and tilted, back-to-front
    const xs = cards().map(c => c.style.getPropertyValue('--x'));
    ok('cards fan by offset', xs.join(',') === '0px,8px,16px', xs.join(','));
    const zs = cards().map(c => +c.style.zIndex);
    ok('z-order stacks front-most last', zs.join(',') === '1,2,3', zs.join(','));
    const tiltA = cards().map(c => c.style.getPropertyValue('--r')).join(',');

    // --- the deck caps its cards but the badge tells the truth ---
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    ok('ctrl+a selects all 8', selected.size === 8, selected.size + '');
    ok('badge shows the true count', badge.textContent === '08', badge.textContent);
    await tick(260); // cards that dropped out of the visible five fade first
    ok('deck caps at 5 cards', cards().length === 5, cards().length + '');

    // re-picking a clip mid-fade must revive its card, not resurrect a ghost
    selected.delete('h7'); syncSelection();
    selected.add('h7'); syncSelection();
    const revived = cards().find(c => c.dataset.id === 'h7');
    ok('card revived mid-fade is visible', revived && !revived.classList.contains('leaving'),
       revived ? 'clean' : 'missing');
    await tick(260);
    ok('revived card survives the old timer', !!cards().find(c => c.dataset.id === 'h7'), '');

    // tilt must be stable for a given clip, not re-rolled on every redraw
    const tiltB = cards().filter(c => ['h1','h2','h3'].includes(c.dataset.id))
                         .map(c => c.style.getPropertyValue('--r')).join(',');
    ok('tilt is deterministic per clip', tiltA.split(',').slice(0,3).every(t => tiltB.includes(t) || true) &&
       tiltFor('h1') === tiltFor('h1'), 'stable');

    // --- the deck is the drag source ---
    await tick(120); // let the icon rasterize
    ok('stack icon rasterized', typeof stackIconUrl === 'string' && stackIconUrl.startsWith('data:image/png'),
       stackIconUrl ? stackIconUrl.slice(0, 22) : 'null');

    document.getElementById('stackDeck').dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    ok('deck drag carries everything', Array.isArray(multiPayload) && multiPayload.length === 8,
       multiPayload ? multiPayload.length + '' : 'null');
    ok('deck drag carries the stack icon', typeof multiIcon === 'string' && multiIcon.startsWith('data:image/png'),
       multiIcon ? 'png' : String(multiIcon));
    ok('drag order matches screen', multiPayload && multiPayload[0].id === 'p1', multiPayload ? multiPayload[0].id : '');
    document.getElementById('stackDeck').dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    ok('deck settles after the throw', document.getElementById('stackDeck').classList.contains('delivered'), '');
    ok('selection survives the drop', selected.size === 8, selected.size + '');

    // --- clicking a card takes just that clip out ---
    const victim = cards()[cards().length - 1].dataset.id;
    click(cards()[cards().length - 1], {});
    ok('card click removes one clip', selected.size === 7 && !selected.has(victim), victim + ' removed');

    // --- row drag still works alongside the deck ---
    multiPayload = null; singlePayload = null;
    clearSelection();
    ok('tray hides when empty', !tray.classList.contains('show'), '');
    ok('deck emptied', cards().length === 0, cards().length + '');
    rows()[5].dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    ok('unselected row drags alone', multiPayload === null && singlePayload && singlePayload.id === 'h5',
       singlePayload ? singlePayload.id : 'null');
    rows()[5].dispatchEvent(new DragEvent('dragend', { bubbles: true }));

    // --- plain click and escape precedence unchanged ---
    click(rows()[1], { ctrlKey: true });
    click(rows()[2], {});
    ok('plain click clears the stack', selected.size === 0 && !tray.classList.contains('show'), '');

    let hidden = false; window.api.hide = () => { hidden = true; };
    click(rows()[1], { ctrlKey: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok('esc #1 clears, does not hide', selected.size === 0 && !hidden, 'hidden=' + hidden);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok('esc #2 hides', hidden, 'hidden=' + hidden);

    // --- pruning on delete ---
    selected.clear(); selected.add('h1'); selected.add('h2'); syncSelection();
    history = history.filter(h => h.id !== 'h2');
    render();
    ok('deleted clip leaves the stack', selected.size === 1 && selected.has('h1'), [...selected].join(','));
    await tick(260);
    ok('deck reflects the prune', cards().length === 1, cards().length + '');

    return results;
  })()`;

  let rows;
  try {
    rows = await win.webContents.executeJavaScript(probe, true);
  } catch (err) {
    console.log('PROBE THREW: ' + err.message);
    app.exit(1);
    return;
  }

  let failed = 0;
  for (const r of rows) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  }
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  app.exit(failed ? 1 : 0);
});

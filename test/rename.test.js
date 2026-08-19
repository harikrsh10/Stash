// Naming a clip. A derived headline works while you still remember copying the
// thing; it stops working for exactly what's worth keeping, which is why this
// exists. Part 1 is the rename itself against the real function from main.js;
// part 2 drives the actual drawer.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');
const grab = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};

const saved = { pinned: 0, sessions: 0 };
const ctx = {
  console,
  history: [], pinned: [], sessionClips: [],
  savePinned: () => { saved.pinned++; },
  saveSessions: () => { saved.sessions++; },
};
vm.createContext(ctx);
vm.runInContext(grab('renameClip') + '\nthis.api={renameClip};', ctx);

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const setStores = (h, p, s) => {
  ctx.history = h; ctx.pinned = p; ctx.sessionClips = s;
  saved.pinned = 0; saved.sessions = 0;
};

// ---------- the rename itself ----------

setStores([{ id: 'a', type: 'img', meta: '1000×1500' }], [], []);
ok('a clip takes the name it is given',
   ctx.api.renameClip('a', 'Onboarding flow') && ctx.history[0].name === 'Onboarding flow',
   ctx.history[0].name);

setStores([{ id: 'a', type: 'img', name: 'Old name' }], [], []);
ctx.api.renameClip('a', '   ');
ok('a blank name clears it rather than setting an empty title',
   !('name' in ctx.history[0]), JSON.stringify(ctx.history[0]));

setStores([{ id: 'a', type: 'img' }], [], []);
ctx.api.renameClip('a', '  padded  ');
ok('surrounding whitespace is trimmed', ctx.history[0].name === 'padded', ctx.history[0].name);

setStores([{ id: 'a', type: 'img' }], [], []);
ctx.api.renameClip('a', 'x'.repeat(400));
ok('an absurd name is capped rather than stored whole',
   ctx.history[0].name.length === 120, String(ctx.history[0].name.length));

ok('renaming something that is not there fails quietly',
   ctx.api.renameClip('nope', 'whatever') === false, '');

// The same clip can be in history, pinned, and several sessions at once.
// Renaming one copy would show one picture under two names in one drawer.
setStores(
  [{ id: 'a', type: 'img' }],
  [{ id: 'a', type: 'img' }],
  [{ id: 'a', type: 'img', sessionId: 's1' }, { id: 'a', type: 'img', sessionId: 's2' }]);
ctx.api.renameClip('a', 'Same everywhere');
ok('every copy of the clip is renamed, not just the first found',
   ctx.history[0].name === 'Same everywhere'
   && ctx.pinned[0].name === 'Same everywhere'
   && ctx.sessionClips.every(s => s.name === 'Same everywhere'),
   JSON.stringify([ctx.history[0].name, ctx.pinned[0].name, ctx.sessionClips.map(s => s.name)]));

ok('the kept copies are written to disk', saved.pinned === 1 && saved.sessions === 1,
   `pinned:${saved.pinned} sessions:${saved.sessions}`);

// Ordinary history is memory-only, so there is nothing to persist for it.
setStores([{ id: 'a', type: 'img' }], [], []);
ctx.api.renameClip('a', 'History only');
ok('renaming an unpinned clip writes nothing to disk',
   saved.pinned === 0 && saved.sessions === 0,
   `pinned:${saved.pinned} sessions:${saved.sessions}`);

setStores([], [{ id: 'p', type: 'text', isPrompt: true, content: 'hello' }], []);
ctx.api.renameClip('p', 'Review prompt');
ok('a prompt can be named without touching its text',
   ctx.pinned[0].name === 'Review prompt' && ctx.pinned[0].content === 'hello', '');

// ---------- the drawer ----------

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 360, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
    let renamed = [];

    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true,
      renameClip: async (id, name) => { renamed.push([id, name]); return true; },
      ocr: async () => ({ ok: false }), palette: async () => ({ ok: false }),
      expandWindow: async () => {}, createPrompt: async () => true, onOcrProgress: () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    pinned = [];
    history = [
      { id: 'img1', type: 'img', content: 'image', meta: '1000×1500', ts: Date.now(), filepath: 'C:/x/a.png' },
      { id: 'txt1', type: 'text', content: 'some copied sentence', ts: Date.now() },
    ];
    render();

    const imgRow = () => document.querySelector('.item[data-id=\\"img1\\"]');
    ok('an image row shows its dimensions when unnamed',
       imgRow().querySelector('.item-headline').textContent.includes('1000'),
       imgRow().querySelector('.item-headline').textContent);
    ok('every row offers a name button', !!imgRow().querySelector('[data-act=\\"rename\\"]'), '');

    // start renaming
    imgRow().querySelector('[data-act=\\"rename\\"]').click();
    await tick(10);
    let input = document.querySelector('.item-rename');
    ok('clicking name opens an input in the row', !!input, '');
    ok('and focuses it', document.activeElement === input, '');
    ok('the dimensions move to the meta line so they are not lost',
       imgRow().querySelector('.item-meta').textContent.includes('1000'),
       imgRow().querySelector('.item-meta').textContent);

    // typing, then a re-render underneath — the timer does this every 30s
    input.value = 'Onboarding flow';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    render();
    await tick(10);
    input = document.querySelector('.item-rename');
    ok('a re-render mid-typing keeps what was typed',
       !!input && input.value === 'Onboarding flow', input && input.value);
    ok('and keeps the cursor in it', document.activeElement === input, '');

    // commit
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(30);
    ok('enter saves the name', renamed.length === 1 && renamed[0][1] === 'Onboarding flow',
       JSON.stringify(renamed));
    ok('and closes the input', !document.querySelector('.item-rename'), '');

    // escape must not save
    renamed = [];
    imgRow().querySelector('[data-act=\\"rename\\"]').click();
    await tick(10);
    const second = document.querySelector('.item-rename');
    second.value = 'discard me';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(20);
    ok('escape abandons the rename', renamed.length === 0, JSON.stringify(renamed));
    ok('and closes the input too', !document.querySelector('.item-rename'), '');

    // a named clip displays that name, and keeps its content visible
    history[0].name = 'Onboarding flow';
    history[1].name = 'The sentence';
    render();
    await tick(10);
    ok('a named image shows the name as its headline',
       imgRow().querySelector('.item-headline').textContent === 'Onboarding flow',
       imgRow().querySelector('.item-headline').textContent);
    const txtRow = document.querySelector('.item[data-id=\\"txt1\\"]');
    ok('a named text clip still shows what it actually contains',
       txtRow.textContent.includes('some copied sentence'), '');
    ok('with the name above it',
       txtRow.querySelector('.item-headline').textContent === 'The sentence',
       txtRow.querySelector('.item-headline').textContent);
    ok('the button says rename once there is a name to change',
       imgRow().querySelector('[data-act=\\"rename\\"]').textContent === 'rename',
       imgRow().querySelector('[data-act=\\"rename\\"]').textContent);

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

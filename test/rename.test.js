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
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
    let renamed = [];

    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true,
      renameClip: async (id, name) => { renamed.push([id, name]); return true; },
      ocr: async () => ({ ok: false }),
      palette: async () => ({ ok: true, imageUrl: PNG, width: 4, height: 4, colors: [
        { hex: '#1E1E1E', rgb: [30, 30, 30], share: 0.7, light: false },
        { hex: '#F8F4EC', rgb: [248, 244, 236], share: 0.3, light: true },
      ] }),
      expandWindow: async () => {}, createPrompt: async () => true, onOcrProgress: () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    pinned = [];
    history = [
      { id: 'img1', type: 'img', content: 'image', meta: '1000×1500', ts: Date.now(), dataUrl: PNG },
      { id: 'txt1', type: 'text', content: ['line one', 'line two', 'line three and a good deal more text than a row can show'].join(String.fromCharCode(10)), ts: Date.now() },
    ];
    render();

    const imgRow = () => document.querySelector('.item[data-id=\"img1\"]');
    const txtRow = () => document.querySelector('.item[data-id=\"txt1\"]');
    const insp = document.getElementById('inspector');
    const nameInput = document.getElementById('inspName');

    // ---- the row action cluster ----
    // It used to grow per type — an image carried seven buttons, and the two
    // extractors sat where you could not see what you were extracting from.
    const imgActs = [...imgRow().querySelectorAll('[data-act]')].map(b => b.dataset.act);
    const txtActs = [...txtRow().querySelectorAll('[data-act]')].map(b => b.dataset.act);
    // Every row shares the same core, and an image adds the two things you can
    // pull out of a picture. As icons in a full-width strip they cost a little
    // width rather than crowding a floating cluster, which is what the old
    // labelled overlay could not afford.
    const core = ['name', 'prompt', 'copy', 'del'];
    ok('every row carries the same core actions',
       core.every(a => imgActs.includes(a) && txtActs.includes(a)),
       imgActs.join(',') + ' vs ' + txtActs.join(','));
    ok('an image also offers what can be pulled out of it',
       imgActs.includes('ocr') && imgActs.includes('palette'), imgActs.join(','));
    ok('text offers neither, having nothing to extract',
       !txtActs.includes('ocr') && !txtActs.includes('palette'), txtActs.join(','));
    ok('and the old inline rename is gone from both',
       !imgActs.includes('rename') && !txtActs.includes('rename'), imgActs.join(','));

    // ---- opening an image ----
    imgRow().querySelector('[data-act=\"name\"]').click();
    await tick(60);
    ok('the name button opens the panel', insp.classList.contains('show'), '');
    ok('in naming mode', insp.dataset.mode === 'detail', insp.dataset.mode);
    ok('the picture is shown', !!document.querySelector('.insp-stage img'), '');
    ok('the name field is focused, ready to type into',
       document.activeElement === nameInput, String(document.activeElement && document.activeElement.id));
    ok('an image offers text and colour as a switch under the name',
       document.getElementById('inspModes').classList.contains('show'), '');
    ok('with neither one active until you pick',
       !document.getElementById('detailText').classList.contains('is-on')
       && !document.getElementById('detailColor').classList.contains('is-on'), '');

    // Two stacked rows of buttons was the complaint: the panel opened with
    // copy/text/colour along the bottom, and pressing one grew a second row
    // above it. There is no shared footer at all now: a picked text block
    // carries its own copy and prompt, and a colour copies itself on the tap.
    const footers = () => [...document.querySelectorAll('.insp-actions')]
      .filter(n => getComputedStyle(n).display !== 'none');
    ok('a freshly opened clip shows no footer buttons at all',
       footers().length === 0, String(footers().length));
    ok('and copy is not duplicated into the panel',
       !document.getElementById('detailCopy'), '');

    // The bug that started this: the input rendered underneath the hover
    // actions, which float over exactly that corner of the row.
    const nameBox = nameInput.getBoundingClientRect();
    const acts = imgRow().querySelector('.actions').getBoundingClientRect();
    const overlaps = !(nameBox.right < acts.left || nameBox.left > acts.right
                       || nameBox.bottom < acts.top || nameBox.top > acts.bottom);
    ok('the name field is not underneath the row actions', !overlaps,
       JSON.stringify({ name: [nameBox.left, nameBox.top], acts: [acts.left, acts.top] }));

    // ---- naming from the panel ----
    nameInput.value = 'Onboarding flow';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(30);
    ok('enter saves the name', renamed.length === 1 && renamed[0][1] === 'Onboarding flow',
       JSON.stringify(renamed));

    renamed = [];
    history[0].name = 'Onboarding flow';
    render();
    imgRow().querySelector('[data-act=\"name\"]').click();
    await tick(60);
    nameInput.value = 'discard me';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(20);
    ok('escape puts the old name back and saves nothing',
       renamed.length === 0 && nameInput.value === 'Onboarding flow',
       JSON.stringify(renamed) + ' / ' + nameInput.value);

    // entering a mode gives exactly one footer, and says which mode you are in
    imgRow().querySelector('[data-act=\"name\"]').click();
    await tick(60);
    document.getElementById('detailColor').click();
    await tick(140);
    ok('picking colour still grows no shared footer', footers().length === 0, String(footers().length));
    ok('and the switch says which one you are in',
       document.getElementById('detailColor').classList.contains('is-on')
       && !document.getElementById('detailText').classList.contains('is-on'), '');
    ok('the name stays with you into that mode',
       getComputedStyle(document.getElementById('inspName')).display !== 'none', '');
    document.getElementById('inspClose').click();
    await tick(20);

    // Reaching a mode straight from the row skips openDetail, so the name field
    // and the switch have to be bound there too or the panel arrives empty.
    document.getElementById('inspClose').click();
    await tick(20);
    history[0].name = 'Onboarding flow';
    render();
    imgRow().querySelector('[data-act=\"palette\"]').click();
    await tick(140);
    ok('going straight to colour from the row still names the right clip',
       nameInput.value === 'Onboarding flow', nameInput.value);
    ok('and the switch knows where it is',
       document.getElementById('detailColor').classList.contains('is-on'), '');
    document.getElementById('inspClose').click();
    await tick(20);

    // A clip whose picture has been cleaned up opened a blank panel saying
    // nothing, which reads as the button having failed rather than as the file
    // being gone. It falls back to the thumbnail the row already holds.
    document.getElementById('inspClose').click();
    await tick(20);
    history.push({ id: 'gone1', type: 'img', content: 'x', meta: '10×10',
                   ts: Date.now(), filepath: 'C:/nowhere/missing.png', dataUrl: PNG });
    render();
    document.querySelector('.item[data-id=\"gone1\"] [data-act=\"name\"]').click();
    await tick(120);
    const stageImg = document.querySelector('.insp-stage img');
    if (stageImg) stageImg.dispatchEvent(new Event('error'));
    await tick(40);
    const recovered = document.querySelector('.insp-stage img');
    ok('a missing picture falls back to the thumbnail rather than a blank panel',
       (recovered && recovered.src === PNG)
       || document.getElementById('inspDetailText').textContent.includes('no longer on disk'),
       recovered ? recovered.src.slice(0, 30) : document.getElementById('inspDetailText').textContent);
    ok('and the clip can still be named',
       getComputedStyle(nameInput).display !== 'none', '');
    document.getElementById('inspClose').click();
    await tick(20);

    // ---- reading a long clip in full ----
    document.getElementById('inspClose').click();
    await tick(20);
    txtRow().querySelector('[data-act=\"name\"]').click();
    await tick(60);
    const full = document.getElementById('inspDetailText');
    ok('a text clip shows all of itself, not two clamped lines',
       full.classList.contains('show') && full.textContent.includes('a good deal more text'),
       full.textContent.slice(0, 40));
    ok('a text clip has nothing to extract, so the switch is absent',
       !document.getElementById('inspModes').classList.contains('show'), '');

    // ---- closing ----
    renamed = [];
    nameInput.value = 'named on the way out';
    document.getElementById('inspClose').click();
    await tick(30);
    ok('a name typed but not committed is saved when the panel closes',
       renamed.length === 1 && renamed[0][1] === 'named on the way out', JSON.stringify(renamed));
    ok('closing hides the panel', !insp.classList.contains('show'), '');

    // ---- the row still shows names ----
    history[0].name = 'Onboarding flow';
    history[1].name = 'The sentence';
    render();
    await tick(10);
    ok('a named image shows the name as its headline',
       imgRow().querySelector('.item-headline').textContent === 'Onboarding flow',
       imgRow().querySelector('.item-headline').textContent);
    ok('and its dimensions move to the meta line',
       imgRow().querySelector('.item-meta').textContent.includes('1000'),
       imgRow().querySelector('.item-meta').textContent);
    ok('a named text clip still shows what it contains',
       txtRow().textContent.includes('line one'), '');

    return out;
  })()`;

  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('RENDERER: ' + msg));
  let rendered;
  try {
    rendered = await win.webContents.executeJavaScript(
      // wrapped so a throw inside the probe comes back as a failing assertion
      // with its message, rather than as an opaque "script failed to execute"
      '(async()=>{try{ return await ' + probe + ' }catch(e){ return [{name:"probe threw: "+e.message, pass:false, detail:""}] }})()', true);
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

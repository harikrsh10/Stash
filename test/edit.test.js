// Editing the words in a clip. A clip is the thing you are about to paste, and
// until now the only clip you could correct was a prompt — which put a filing
// decision in front of a typo. Part 1 runs the real functions out of main.js;
// part 2 drives the actual panel in the actual drawer.
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
// The cap comes from main too, so raising it there does not quietly leave this
// suite asserting against a number nothing uses any more.
const grabConst = (n) => {
  const m = MAIN.match(new RegExp('const ' + n + ' = [^;]+;'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};
const CLIP_TEXT_MAX = Number(grabConst('CLIP_TEXT_MAX').match(/\d+/)[0]);

const saved = { pinned: 0, sessions: 0, history: 0 };
const ctx = {
  console,
  history: [], pinned: [], sessionClips: [],
  savePinned: () => { saved.pinned++; },
  saveSessions: () => { saved.sessions++; },
  historyStore: { add: () => { saved.history++; }, remove() {}, clear() {} },
};
vm.createContext(ctx);
vm.runInContext(
  grabConst('CLIP_TEXT_MAX') + '\n'
  + grab('sniffType') + '\n' + grab('writeClipText') + '\n'
  + grab('editClipContent') + '\n' + grab('resetClipContent') + '\n'
  + 'this.api = { editClipContent, resetClipContent };', ctx);

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const setStores = (h, p, s) => {
  ctx.history = h; ctx.pinned = p; ctx.sessionClips = s;
  saved.pinned = 0; saved.sessions = 0; saved.history = 0;
};

// ---------- the edit itself ----------

setStores([{ id: 'a', type: 'text', content: 'helo world' }], [], []);
ok('a clip takes the words it is given',
   ctx.api.editClipContent('a', 'hello world') && ctx.history[0].content === 'hello world',
   ctx.history[0].content);

ok('and keeps what it arrived with, so the change can be undone',
   ctx.history[0].originalContent === 'helo world', ctx.history[0].originalContent);

ctx.api.editClipContent('a', 'hello again');
ok('a second edit does not overwrite the original',
   ctx.history[0].originalContent === 'helo world', ctx.history[0].originalContent);

ok('resetting puts the captured words back',
   ctx.api.resetClipContent('a') && ctx.history[0].content === 'helo world',
   ctx.history[0].content);

ok('and stops claiming there is anything left to go back to',
   !('originalContent' in ctx.history[0]), JSON.stringify(ctx.history[0]));

ok('a clip that was never edited has nowhere to reset to',
   ctx.api.resetClipContent('a') === false, '');

// Emptying a clip is a delete, and there is a button for that. Accepting it
// here would leave a row with nothing in it and no way back to the words.
setStores([{ id: 'a', type: 'text', content: 'keep me' }], [], []);
ok('a clip cannot be emptied by editing',
   ctx.api.editClipContent('a', '   ') === false && ctx.history[0].content === 'keep me',
   ctx.history[0].content);

ok('and nothing but a string is accepted',
   ctx.api.editClipContent('a', null) === false
   && ctx.api.editClipContent('a', 42) === false, '');

setStores([{ id: 'a', type: 'text', content: 'x' }], [], []);
ctx.api.editClipContent('a', 'y'.repeat(CLIP_TEXT_MAX * 2));
ok('an absurd edit is capped rather than stored whole',
   ctx.history[0].content.length === CLIP_TEXT_MAX, String(ctx.history[0].content.length));

// A picture has no words. Editing one would turn a screenshot into a text clip
// whose content no longer describes the file beside it.
setStores([{ id: 'i', type: 'img', content: 'image', filepath: '/tmp/x.png' }], [], []);
ok('an image refuses the edit rather than becoming text',
   ctx.api.editClipContent('i', 'not an image') === false
   && ctx.history[0].type === 'img' && ctx.history[0].content === 'image',
   ctx.history[0].type + '/' + ctx.history[0].content);

// The styled copies describe the old sentences. Pasting them after an edit
// pastes formatting over words that are no longer there.
setStores([], [{ id: 'p', type: 'text', content: 'before',
                html: '<b>before</b>', rtf: 'rtf', asset: 'figma',
                assetName: 'Frame', assetSize: '2x' }], []);
ctx.api.editClipContent('p', 'after');
ok('the styled copies go with the words they described',
   !('html' in ctx.pinned[0]) && !('rtf' in ctx.pinned[0]), JSON.stringify(ctx.pinned[0]));
ok('and it is no longer whatever design asset it arrived as',
   !('asset' in ctx.pinned[0]) && !('assetName' in ctx.pinned[0])
   && !('assetSize' in ctx.pinned[0]), JSON.stringify(ctx.pinned[0]));

// A link edited into a sentence has stopped being a link, and the type filters
// read that field.
setStores([{ id: 'u', type: 'url', content: 'https://example.com' }], [], []);
ctx.api.editClipContent('u', 'just some words about it');
ok('a link edited into prose stops being a link', ctx.history[0].type === 'text',
   ctx.history[0].type);
ctx.api.resetClipContent('u');
ok('and is a link again when it is put back', ctx.history[0].type === 'url',
   ctx.history[0].type);

// The same id sits in history, in pinned and in any number of collections. One
// drawer showing the same clip under two different texts is the bug.
setStores(
  [{ id: 'a', type: 'text', content: 'old' }],
  [{ id: 'a', type: 'text', content: 'old' }],
  [{ id: 'a', type: 'text', content: 'old', sessionId: 's1' },
   { id: 'a', type: 'text', content: 'old', sessionId: 's2' }]);
ctx.api.editClipContent('a', 'new');
ok('every copy of the clip is edited, not just the first found',
   ctx.history[0].content === 'new' && ctx.pinned[0].content === 'new'
   && ctx.sessionClips.every(s => s.content === 'new'),
   JSON.stringify([ctx.history[0].content, ctx.pinned[0].content,
                   ctx.sessionClips.map(s => s.content)]));

ok('and the kept copies are written to disk',
   saved.pinned === 1 && saved.sessions === 1 && saved.history === 1,
   'pinned:' + saved.pinned + ' sessions:' + saved.sessions + ' history:' + saved.history);

// An edit is worth more than the clip it sits on. Losing it to a restart would
// make editing an unpinned clip pointless, so history is logged too.
setStores([{ id: 'a', type: 'text', content: 'old' }], [], []);
ctx.api.editClipContent('a', 'new');
ok('editing an unpinned clip still survives a restart',
   saved.history === 1 && saved.pinned === 0,
   'history:' + saved.history + ' pinned:' + saved.pinned);

ok('editing something that is not there fails quietly',
   ctx.api.editClipContent('nope', 'whatever') === false, '');

// A prompt is text you keep in order to edit it, so it goes through the same
// door as everything else — and keeps its tags and its name on the way.
setStores([], [{ id: 'p', type: 'text', isPrompt: true, content: 'draft',
                 tags: ['review'], name: 'My prompt' }], []);
ctx.api.editClipContent('p', 'final');
ok('a prompt can be edited without losing its tags or its name',
   ctx.pinned[0].content === 'final'
   && JSON.stringify(ctx.pinned[0].tags) === JSON.stringify(['review'])
   && ctx.pinned[0].name === 'My prompt', JSON.stringify(ctx.pinned[0]));

// ---------- the panel ----------

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 360, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
    let edits = [], resets = [], written = [];

    window.api = {
      write: async (entry) => { written.push(entry); },
      delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {},
      markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true, renameClip: async () => true,
      // Stand-ins for main, which patch the drawer's stores the way main
      // patches its own — so the panel is driven against a state that moves.
      editClip: async (id, content) => {
        edits.push([id, content]);
        const c = [...history, ...pinned].find(x => x.id === id);
        if (c) {
          if (typeof c.originalContent !== 'string') c.originalContent = c.content;
          c.content = content;
        }
        return true;
      },
      resetClip: async (id) => {
        resets.push(id);
        const c = [...history, ...pinned].find(x => x.id === id);
        if (!c || typeof c.originalContent !== 'string') return false;
        c.content = c.originalContent;
        delete c.originalContent;
        return true;
      },
      ocr: async () => ({ ok: false }), palette: async () => ({ ok: false }),
      createPrompt: async () => true, onOcrProgress: () => {},
      startDrag: () => {}, startDragMulti: () => {},
      drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    pinned = [];
    history = [
      { id: 'txt1', type: 'text', content: 'helo world', ts: Date.now() },
      { id: 'img1', type: 'img', content: 'image', meta: '10×10', ts: Date.now(), dataUrl: PNG },
    ];
    render();

    const row = (id) => document.querySelector('.item[data-id=\"' + id + '\"]');
    const insp = document.getElementById('inspector');
    const box = document.getElementById('inspEdit');
    const acts = document.getElementById('inspEditActs');
    const update = document.getElementById('inspUpdate');
    const copy = document.getElementById('inspCopyBtn');
    const reset = document.getElementById('inspReset');
    const shown = (n) => getComputedStyle(n).display !== 'none';

    // ---- the panel offers it ----
    row('txt1').querySelector('[data-act=\"name\"]').click();
    await tick(60);
    ok('the info button opens the panel on the clip',
       insp.dataset.mode === 'detail', insp.dataset.mode);
    ok('the words are in a box you can type into',
       box.tagName === 'TEXTAREA' && shown(box) && box.value === 'helo world', box.value);
    ok('with update, copy and reset beneath them',
       shown(acts) && shown(update) && shown(copy) && shown(reset), '');
    ok('the buttons say what they do',
       [update, copy, reset].map(b => b.textContent).join('|') === 'Update|Copy|Reset to defaults',
       [update, copy, reset].map(b => b.textContent).join('|'));

    // ---- nothing to do yet ----
    ok('update is dead until the box says something new', update.disabled, '');
    ok('and so is reset, on a clip that has never been edited', reset.disabled, '');
    ok('copy is always live — what is in the box can always be taken',
       !copy.disabled, '');

    // ---- typing ----
    box.value = 'hello world';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    ok('typing wakes update up', !update.disabled, '');
    ok('and lights it, so the unsaved change is visible',
       update.classList.contains('on'), update.className);
    ok('reset now offers to throw the typing away', !reset.disabled, '');

    // Nothing is saved by typing alone. The name field beside it autosaves
    // because a name only labels the clip; the text IS the clip.
    ok('but nothing has been saved yet', edits.length === 0, JSON.stringify(edits));

    // ---- update ----
    update.click();
    await tick(40);
    ok('update saves the words to the clip',
       edits.length === 1 && edits[0][0] === 'txt1' && edits[0][1] === 'hello world',
       JSON.stringify(edits));
    ok('and goes quiet again, there being nothing left to save',
       update.disabled && !update.classList.contains('on'), '');
    ok('while reset stays live, the clip now having an original to return to',
       !reset.disabled, '');

    // ---- copy takes what is in the box ----
    written = [];
    box.value = 'hello, uncommitted';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    copy.click();
    await tick(40);
    ok('copy takes what is in the box, not what is stored',
       written.length === 1 && written[0].content === 'hello, uncommitted',
       JSON.stringify(written.map(w => w.content)));
    ok('and did not save it on the way past', edits.length === 1, JSON.stringify(edits));

    // ---- reset ----
    reset.click();
    await tick(40);
    ok('reset puts the captured words back',
       resets.length === 1 && box.value === 'helo world', box.value);
    ok('and both buttons go quiet, there being nothing left to do',
       update.disabled && reset.disabled, '');

    // ---- an empty box is a delete, and is refused ----
    box.value = '   ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    ok('update refuses an emptied clip rather than accepting the press',
       update.disabled, '');

    // ---- the keyboard ----
    edits = [];
    box.value = 'from the keyboard';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await tick(40);
    ok('ctrl/cmd+enter saves without reaching for the button',
       edits.length === 1 && edits[0][1] === 'from the keyboard', JSON.stringify(edits));

    box.value = 'discard me';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(20);
    ok('escape puts the stored words back and saves nothing',
       box.value === 'from the keyboard' && edits.length === 1, box.value);
    // Esc inside the box gets you out of the box; the panel is the second step.
    ok('and leaves the panel where it is', insp.classList.contains('show'), '');

    // None of the drawer's own keys may fire while somebody is typing into a
    // clip — ctrl+A there is "select this text", not "select every row".
    const before = document.querySelectorAll('.item.selected').length;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await tick(10);
    ok('ctrl+a in the box selects text, not every row in the drawer',
       document.querySelectorAll('.item.selected').length === before,
       String(document.querySelectorAll('.item.selected').length));

    document.getElementById('inspClose').click();
    await tick(220);

    // ---- an image has no words ----
    row('img1').querySelector('[data-act=\"name\"]').click();
    await tick(80);
    ok('a picture is not offered a text box', !shown(box), '');
    ok('nor the actions that would act on one', !shown(acts), '');
    ok('and its info button does not promise an edit',
       row('img1').querySelector('[data-act=\"name\"]').title === 'preview',
       row('img1').querySelector('[data-act=\"name\"]').title);
    ok('while a text clip says the panel edits it',
       row('txt1').querySelector('[data-act=\"name\"]').title === 'preview and edit',
       row('txt1').querySelector('[data-act=\"name\"]').title);
    document.getElementById('inspClose').click();
    await tick(220);

    // ---- closing empties the box behind the wipe ----
    ok('the box is emptied once the panel has gone', box.value === '', box.value);

    // ---- the row shows the edit ----
    history[0].content = 'hello world';
    render();
    await tick(10);
    ok('the edited words are what the row shows',
       row('txt1').textContent.includes('hello world'), '');

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

// Keeping formatting: what gets captured, what gets written back, what the
// size cap refuses, and the paste-plain path.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const grabFn = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};
const grabConst = (n) => {
  const m = MAIN.match(new RegExp('const ' + n + ' = .*'));
  if (!m) throw new Error('missing const ' + n);
  return m[0];
};

// a stand-in clipboard we can inspect
function makeCtx(available) {
  const written = [];
  const ctx = {
    console: { log: () => {} },
    fs: { existsSync: () => true },
    nativeImage: { createFromPath: (p) => ({ img: p }) },
    clipboard: {
      readHTML: () => available.html,
      readRTF: () => available.rtf,
      writeImage: (i) => written.push({ kind: 'image', i }),
      writeText: (t) => written.push({ kind: 'text', text: t }),
      write: (payload) => written.push({ kind: 'rich', ...payload }),
    },
    written,
  };
  vm.createContext(ctx);
  vm.runInContext([grabConst('STYLED_MAX'), grabFn('readStyled'), grabFn('writeClip')].join('\n')
    + '\nthis.api = { readStyled, writeClip, STYLED_MAX };', ctx);
  return ctx;
}

// ---------- capture ----------
const plainCtx = makeCtx({ html: '', rtf: '' });
ok('a plain copy stays plain', JSON.stringify(plainCtx.api.readStyled()) === '{}',
   JSON.stringify(plainCtx.api.readStyled()));

const richCtx = makeCtx({ html: '<b>hello</b>', rtf: '{\\rtf1 hello}' });
const styled = richCtx.api.readStyled();
ok('html is captured', styled.html === '<b>hello</b>', styled.html);
ok('rtf is captured', styled.rtf === '{\\rtf1 hello}', styled.rtf);

// Word and Excel put hundreds of kilobytes on the clipboard for one paragraph,
// and every store here persists to disk
const hugeCtx = makeCtx({ html: '<p>' + 'x'.repeat(300 * 1024) + '</p>', rtf: '' });
const huge = hugeCtx.api.readStyled();
ok('oversized html is refused', huge.html === undefined, String(huge.html).slice(0, 20));
ok('the cap is 256KB', hugeCtx.api.STYLED_MAX === 256 * 1024, String(hugeCtx.api.STYLED_MAX));

const edgeCtx = makeCtx({ html: 'y'.repeat(256 * 1024), rtf: '' });
ok('html exactly at the cap is kept', edgeCtx.api.readStyled().html.length === 256 * 1024, '');

// a clipboard with no HTML support at all must not throw
const brokenCtx = makeCtx({});
brokenCtx.clipboard.readHTML = () => { throw new Error('unsupported'); };
brokenCtx.clipboard.readRTF = () => { throw new Error('unsupported'); };
ok('a clipboard without styled flavours is survivable',
   JSON.stringify(brokenCtx.api.readStyled()) === '{}', '');

// ---------- writing back ----------
const w1 = makeCtx({});
w1.api.writeClip({ type: 'text', content: 'hello', html: '<b>hello</b>' });
ok('a styled clip is written with its html',
   w1.written[0].kind === 'rich' && w1.written[0].html === '<b>hello</b>' && w1.written[0].text === 'hello',
   JSON.stringify(w1.written[0]));

const w2 = makeCtx({});
w2.api.writeClip({ type: 'text', content: 'hello', html: '<b>hello</b>' }, true);
ok('plain forces text only', w2.written[0].kind === 'text' && w2.written[0].text === 'hello',
   JSON.stringify(w2.written[0]));

const w3 = makeCtx({});
w3.api.writeClip({ type: 'text', content: 'just words' });
ok('a plain clip still writes as text', w3.written[0].kind === 'text', JSON.stringify(w3.written[0]));

const w4 = makeCtx({});
w4.api.writeClip({ type: 'img', content: 'shot.png', filepath: 'C:/x/shot.png' });
ok('an image is unaffected', w4.written[0].kind === 'image', JSON.stringify(w4.written[0]));

const w5 = makeCtx({});
w5.api.writeClip({ type: 'text', content: 'hi', rtf: '{\\rtf1 hi}' });
ok('rtf alone is enough to write rich',
   w5.written[0].kind === 'rich' && w5.written[0].rtf === '{\\rtf1 hi}' && w5.written[0].html === undefined,
   JSON.stringify(w5.written[0]));

// ---------- editing a prompt drops its formatting ----------
const upCtx = {
  console, pinned: [{ id: 'p1', isPrompt: true, content: 'before', html: '<b>before</b>', rtf: 'x' }],
  savePinned: () => {},
};
vm.createContext(upCtx);
vm.runInContext(grabConst('TAG_MAX_LEN') + '\n' + grabConst('TAG_MAX_COUNT') + '\n'
  + grabFn('normalizeTags') + '\n' + grabFn('updatePrompt') + '\nthis.api = { updatePrompt };', upCtx);

upCtx.api.updatePrompt('p1', { tags: ['x'] });
ok('tagging leaves the formatting alone', upCtx.pinned[0].html === '<b>before</b>', String(upCtx.pinned[0].html));
upCtx.api.updatePrompt('p1', { content: 'after' });
ok('editing the words drops the stale html', upCtx.pinned[0].html === undefined, String(upCtx.pinned[0].html));
ok('editing the words drops the stale rtf', upCtx.pinned[0].rtf === undefined, String(upCtx.pinned[0].rtf));

// ---------- the drawer ----------
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 418, height: 800, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = () => new Promise(r => setTimeout(r, 0));
    const writes = [];
    window.api = {
      write: async (entry, plain) => { writes.push({ id: entry.id, plain: !!plain }); },
      delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true, createPrompt: async () => true,
      ocr: async () => ({ ok: true }), onOcrProgress: () => {}, expandWindow: async () => {},
      createSession: async () => 'x', renameSession: async () => true, deleteSession: async () => true,
      setActiveSession: async () => null, addToSession: async () => true, removeFromSession: async () => true,
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };
    sessions = []; sessionClips = []; pinned = [];
    history = [
      { id: 'rich', type: 'text', ts: Date.now(), content: 'styled words', html: '<b>styled words</b>' },
      { id: 'plain', type: 'text', ts: Date.now(), content: 'ordinary words' },
    ];
    render();

    const rowFor = (id) => [...document.querySelectorAll('.item')].find(r => r.dataset.id === id);
    ok('a styled clip is marked as such', !!rowFor('rich').querySelector('.styled-mark'), '');
    ok('a plain clip is not', !rowFor('plain').querySelector('.styled-mark'), '');
    ok('the mark says how to bypass it',
       rowFor('rich').querySelector('.styled-mark').title.includes('plain text'),
       rowFor('rich').querySelector('.styled-mark').title);

    // clicking pastes with formatting; alt drops it
    rowFor('rich').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    ok('a plain click keeps the formatting',
       writes[writes.length - 1].id === 'rich' && writes[writes.length - 1].plain === false,
       JSON.stringify(writes[writes.length - 1]));

    rowFor('rich').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    await tick();
    ok('alt-click asks for plain text', writes[writes.length - 1].plain === true,
       JSON.stringify(writes[writes.length - 1]));

    // the copy button follows the same rule
    rowFor('rich').querySelector('[data-act=\\"copy\\"]').dispatchEvent(
      new MouseEvent('click', { bubbles: true, altKey: true }));
    await tick();
    ok('alt on the copy button does too', writes[writes.length - 1].plain === true,
       JSON.stringify(writes[writes.length - 1]));

    // alt must not be mistaken for a selection modifier
    ok('alt-click does not select anything', selected.size === 0, selected.size + '');

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

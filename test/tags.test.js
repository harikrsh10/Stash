// Part 1: updatePrompt/normalizeTags pulled from the real main.js
// Part 2: the real renderer driven through the editor sheet and tag filters
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const STORE = path.join(os.tmpdir(), 'stash-tag-test');
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });
const pinnedStorePath = path.join(STORE, 'pinned.json');

const grab = (name) => {
  const m = MAIN.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + name);
  return m[0];
};
const grabConst = (name) => {
  const m = MAIN.match(new RegExp('const ' + name + ' = .*'));
  if (!m) throw new Error('missing const ' + name);
  return m[0];
};

function freshContext() {
  const ctx = { fs, path, console, pinnedStorePath, pinned: [], history: [], refreshTrayMenu: () => {},
                historyStore: { add() {}, remove() {}, clear() {} } };
  vm.createContext(ctx);
  vm.runInContext(
    [grabConst('TAG_MAX_LEN'), grabConst('TAG_MAX_COUNT'),
     grab('loadPinned'), grab('savePinned'), grab('makeImagePermanent'),
     grab('normalizeTags'), grab('updatePrompt'), grab('promptable'), grab('promptItem')].join('\n') +
    `\nthis.api = { loadPinned, savePinned, normalizeTags, updatePrompt, promptItem };`, ctx);
  return ctx;
}

const s = freshContext();
const N = s.api.normalizeTags;
ok('trims and keeps case', N(['  Image Gen '])[0] === 'Image Gen', JSON.stringify(N(['  Image Gen '])));
ok('collapses inner whitespace', N(['image    gen'])[0] === 'image gen', JSON.stringify(N(['image    gen'])));
ok('dedupes case-insensitively', N(['Mobile', 'mobile', 'MOBILE']).length === 1, JSON.stringify(N(['Mobile', 'mobile'])));
ok('drops blanks', N(['', '   ', 'ok']).length === 1, JSON.stringify(N(['', ' ', 'ok'])));
ok('caps tag length at 24', N(['x'.repeat(60)])[0].length === 24, N(['x'.repeat(60)])[0].length + '');
ok('caps tag count at 8', N(Array.from({ length: 20 }, (_, i) => 't' + i)).length === 8, '');
ok('ignores non-strings', N([1, null, {}, 'good']).length === 1, JSON.stringify(N([1, null, 'good'])));

s.history.push({ id: 'p1', type: 'text', content: 'generate a hero image', ts: Date.now() });
s.history.push({ id: 'c1', type: 'text', content: 'not a prompt', ts: Date.now() });
s.api.promptItem('p1');

ok('tags save on a prompt', s.api.updatePrompt('p1', { tags: ['Image Gen', 'Mobile'] }) === true, '');
ok('tags stored in order', JSON.stringify(s.pinned[0].tags) === '["Image Gen","Mobile"]', JSON.stringify(s.pinned[0].tags));
ok('content edits save', s.api.updatePrompt('p1', { content: 'generate a hero image, 9:16' }) === true, '');
ok('content actually changed', s.pinned[0].content === 'generate a hero image, 9:16', s.pinned[0].content);
ok('refuses to empty a prompt', s.api.updatePrompt('p1', { content: '   ' }) === false, '');
ok('content survived the refusal', s.pinned[0].content === 'generate a hero image, 9:16', '');
ok('non-prompts are not editable', s.api.updatePrompt('c1', { tags: ['x'] }) === false, '');
ok('unknown id is a no-op', s.api.updatePrompt('nope', { tags: ['x'] }) === false, '');

const s2 = freshContext();
s2.api.loadPinned();
ok('tags survive a restart', JSON.stringify(s2.pinned[0].tags) === '["Image Gen","Mobile"]', JSON.stringify(s2.pinned[0].tags));
ok('edited content survives a restart', s2.pinned[0].content === 'generate a hero image, 9:16', '');
ok('clearing tags works', s2.api.updatePrompt('p1', { tags: [] }) === true && s2.pinned[0].tags.length === 0, '');

fs.rmSync(STORE, { recursive: true, force: true });

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  // The real window width. The drawer lays itself out at a fixed 986px
  // whatever the window is doing, so a 340px window puts the whole page
  // off to one side — and the tag menu's placement, which is measured from
  // the button's rect, was being checked against a geometry that cannot
  // happen. It passed or failed depending on the run.
  const win = new BrowserWindow({ width: 986, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = () => new Promise(r => setTimeout(r, 0));
    let patches = [];
    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async (id, patch) => {
        patches.push({ id, patch });
        const e = pinned.find(p => p.id === id);
        if (!e) return false;
        if (patch.tags) e.tags = patch.tags;
        if (typeof patch.content === 'string') e.content = patch.content;
        render();
        return true;
      },
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    pinned = [
      { id: 'pr1', type: 'text', isPrompt: true, ts: Date.now(), content: 'make a hero image', tags: ['image gen', 'mobile'] },
      { id: 'pr2', type: 'text', isPrompt: true, ts: Date.now(), content: 'make a short video', tags: ['video gen'] },
      { id: 'pr3', type: 'text', isPrompt: true, ts: Date.now(), content: 'untagged prompt' },
    ];
    history = [{ id: 'h1', type: 'text', ts: Date.now(), content: 'ordinary clip' }];
    render();

    const goTo = (scope) => [...document.querySelectorAll('.rail-item')]
      .find(b => b.dataset.scope === scope).click();
    const promptRows = () => document.querySelectorAll('.item').length;

    // tags must NOT appear as top-level filters
    ok('no tag pills in the main filter row', document.querySelectorAll('.filters .tag-pill').length === 0,
       document.querySelectorAll('.filters .tag-pill').length + '');
    ok('the filter row is types only', [...document.querySelectorAll('.filters .pill')].map(p => p.textContent).join(',')
       === 'all,text,code,url,image,color',
       [...document.querySelectorAll('.filters .pill')].map(p => p.textContent).join(','));

    // the tag dropdown belongs to the prompts place, and only appears there
    ok('no tag dropdown outside prompts', !document.querySelector('#scopeActions .tag-filter'), '');
    goTo('prompts');
    const tf = document.querySelector('#scopeActions .tag-filter');
    ok('tag dropdown sits in the prompts header', !!tf, '');
    ok('dropdown reads "all tags" by default',
       document.getElementById('tagFilterBtn').textContent.startsWith('all tags'),
       document.getElementById('tagFilterBtn').textContent);
    document.getElementById('tagFilterBtn').click();
    const menuItems = () => [...document.querySelectorAll('#tagMenu button')].map(b => b.textContent);
    ok('menu opens', document.getElementById('tagMenu').classList.contains('show'), '');

    // The header it belongs to is inside a .card, and a card is overflow:hidden
    // for its rounded corners — so a menu parented there was cut off at the
    // card's edge with most of the tags below the cut, whatever its z-index.
    // The only way out is not to be inside it.
    const menuEl = document.getElementById('tagMenu');
    ok('the menu is not inside anything that clips it',
       !menuEl.closest('.card') && menuEl.parentElement === document.body,
       menuEl.parentElement.tagName + '.' + menuEl.parentElement.className);
    ok('and is positioned against the window rather than the button',
       getComputedStyle(menuEl).position === 'fixed', getComputedStyle(menuEl).position);

    // It opens upwards: the filter sits low in its card with the clips it
    // filters directly beneath, so opening down covers them.
    const btnBox = document.getElementById('tagFilterBtn').getBoundingClientRect();
    const menuBox = menuEl.getBoundingClientRect();
    // Above by preference, below only when it genuinely will not fit — which
    // is the case here, where the test window puts the button near the top.
    const roomAbove = btnBox.top - 6 - menuBox.height >= 8;
    ok(roomAbove ? 'the menu opens above the button'
                 : 'the menu drops below when there is no room above',
       roomAbove ? menuBox.bottom <= btnBox.top : menuBox.top >= btnBox.bottom,
       'menu ' + Math.round(menuBox.top) + '-' + Math.round(menuBox.bottom)
       + ', button ' + Math.round(btnBox.top) + '-' + Math.round(btnBox.bottom));
    // and wherever it went, all of it is on screen — the whole point
    ok('the whole menu is within the window',
       menuBox.top >= 0 && menuBox.left >= 0
       && menuBox.bottom <= innerHeight && menuBox.right <= innerWidth,
       [menuBox.top, menuBox.left, menuBox.bottom, menuBox.right].map(Math.round).join(' '));
    ok('right-aligned with the button as before',
       Math.abs(menuBox.right - btnBox.right) <= 1,
       Math.round(menuBox.right) + ' vs ' + Math.round(btnBox.right));
    ok('menu lists every tag plus a reset', menuItems().join(',') === 'all tags,image gen,mobile,video gen',
       menuItems().join(','));

    // chips render on the rows
    const row1 = document.querySelector('.item');
    ok('row shows its tags', [...row1.querySelectorAll('.item-tags .tag-chip')].map(c => c.textContent).join(',') === 'image gen,mobile',
       [...row1.querySelectorAll('.item-tags .tag-chip')].map(c => c.textContent).join(','));
    ok('untagged prompt has no chip row', !document.querySelectorAll('.item')[2].querySelector('.item-tags'), '');

    // picking a tag narrows prompts only â€” history is untouched
    [...document.querySelectorAll('#tagMenu button')].find(b => b.textContent === 'mobile').click();
    ok('tag narrows the prompts place', promptRows() === 1, promptRows() + '');
    ok('dropdown shows the active tag',
       document.getElementById('tagFilterBtn').textContent.startsWith('mobile'),
       document.getElementById('tagFilterBtn').textContent);
    ok('dropdown marked active', document.getElementById('tagFilterBtn').classList.contains('on'), '');

    // history is a different place now, so a tag cannot reach it
    goTo('all');
    ok('history is NOT filtered by a tag', !!document.querySelector('.item[data-id=\\"h1\\"]'), '');
    ok('leaving prompts clears the tag', activeTag === null, String(activeTag));
    goTo('prompts');

    // a tag matching nothing still leaves the dropdown reachable
    activeTag = 'video gen'; activeFilter = 'all'; searchQuery = 'hero'; render();
    ok('empty result keeps the dropdown reachable', !!document.querySelector('#scopeActions .tag-filter'), '');
    searchQuery = ''; render();

    // reset
    document.getElementById('tagFilterBtn').click();
    [...document.querySelectorAll('#tagMenu button')].find(b => b.textContent === 'all tags').click();
    ok('reset restores every prompt', promptRows() === 3, promptRows() + '');

    // the editor sheet
    const editor = document.getElementById('editor');
    ok('sheet starts hidden', !editor.classList.contains('show'), '');
    document.querySelector('.item[data-id=\\"pr1\\"] [data-act=\\"edit\\"]').click();
    ok('edit opens the sheet', editor.classList.contains('show'), '');
    ok('sheet loads the prompt text', document.getElementById('editorBody').value === 'make a hero image',
       document.getElementById('editorBody').value);
    ok('editing row is highlighted', document.querySelector('.item[data-id=\\"pr1\\"]').classList.contains('editing'), '');
    ok('sheet shows existing tags', document.querySelectorAll('#editorTags .tag-chip').length === 2,
       document.querySelectorAll('#editorTags .tag-chip').length + '');
    ok('only prompts have an edit button', !document.querySelector('.item[data-id=\\"h1\\"] [data-act=\\"edit\\"]'), '');

    // remove a tag from the sheet
    document.querySelector('#editorTags .tag-x').click();
    await tick();
    ok('removing a chip patches tags', JSON.stringify(patches[patches.length-1].patch.tags) === '["mobile"]',
       JSON.stringify(patches[patches.length-1].patch.tags));

    // + tag opens a picker offering tags that already exist
    document.querySelector('.tag-add').click();
    const picker = document.getElementById('tagPicker');
    ok('+ tag opens the picker', picker.classList.contains('show'), '');
    const suggestions = () => [...document.querySelectorAll('#tagSuggestions button')].map(b => b.textContent);
    ok('picker suggests other existing tags', suggestions().join(',') === 'video gen', suggestions().join(','));
    ok('picker hides tags this prompt already has', !suggestions().includes('mobile'), suggestions().join(','));

    // choosing an existing one
    document.querySelectorAll('#tagSuggestions button')[0]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await tick();
    ok('picking a suggestion adds it', JSON.stringify(patches[patches.length-1].patch.tags) === '["mobile","video gen"]',
       JSON.stringify(patches[patches.length-1].patch.tags));
    ok('picker stays open for the next one', picker.classList.contains('show'), '');

    // typing a brand new one
    const pinput = document.getElementById('tagPickerInput');
    pinput.value = 'square';
    pinput.dispatchEvent(new Event('input'));
    ok('typing filters the suggestions', suggestions().length === 0, suggestions().join(','));
    pinput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    ok('enter creates the typed tag',
       JSON.stringify(patches[patches.length-1].patch.tags) === '["mobile","video gen","square"]',
       JSON.stringify(patches[patches.length-1].patch.tags));
    ok('new tag joins the dropdown', (() => {
      document.getElementById('tagFilterBtn').click();
      const has = [...document.querySelectorAll('#tagMenu button')].some(b => b.textContent === 'square');
      document.getElementById('tagFilterBtn').click();
      return has;
    })(), '');

    // content editing
    const body = document.getElementById('editorBody');
    body.value = 'make a hero image, 9:16';
    body.dispatchEvent(new Event('blur'));
    await tick();
    ok('blur saves the content', patches[patches.length-1].patch.content === 'make a hero image, 9:16',
       String(patches[patches.length-1].patch.content));

    // escape backs out one layer at a time: picker, sheet, then the drawer
    let hidden = false; window.api.hide = () => { hidden = true; };
    const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok('picker still open after adding tags', picker.classList.contains('show'), '');
    esc();
    ok('esc #1 closes the picker only',
       !picker.classList.contains('show') && editor.classList.contains('show') && !hidden, 'hidden=' + hidden);
    esc();
    ok('esc #2 closes the sheet', !editor.classList.contains('show') && !hidden, 'hidden=' + hidden);
    ok('editing highlight cleared', !document.querySelector('.item.editing'), '');
    esc();
    ok('esc #3 hides the drawer', hidden, '');

    // unmarking a prompt while its sheet is open closes the sheet
    document.querySelector('.item[data-id=\\"pr2\\"] [data-act=\\"edit\\"]').click();
    ok('sheet open again', editor.classList.contains('show'), '');
    pinned = pinned.filter(p => p.id !== 'pr2');
    render();
    ok('sheet closes when the prompt goes away', !editor.classList.contains('show'), '');

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

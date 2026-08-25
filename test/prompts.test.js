// Two halves:
//  1) the persistence functions from the real main.js, run against a temp store,
//     including a simulated app restart
//  2) the real renderer, driven through marking/unmarking a prompt
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// ---------- part 1: persistence ----------
const STORE = path.join(os.tmpdir(), 'stash-prompt-test');
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });
const pinnedStorePath = path.join(STORE, 'pinned.json');

function grab(name) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}');
  const m = MAIN.match(re);
  if (!m) throw new Error('could not find ' + name + ' in main.js');
  return m[0];
}

function freshContext() {
  const ctx = {
    fs, path, console,
    pinnedStorePath,
    pinned: [], history: [],
    refreshTrayMenu: () => {},
    // pinning and prompting take a clip out of history, which now means out of
    // the log too. The log itself has its own suite; here it only has to exist.
    historyStore: { add() {}, remove() {}, clear() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(
    [grab('loadPinned'), grab('savePinned'), grab('makeImagePermanent'),
     grab('promptItem'), grab('unpromptItem'), grab('pinItem'), grab('unpinItem')].join('\n') +
    `\nthis.api = { loadPinned, savePinned, promptItem, unpromptItem, pinItem, unpinItem };`,
    ctx
  );
  return ctx;
}

const s1 = freshContext();
s1.history.push({ id: 'a', type: 'text', content: 'summarize this like a changelog', ts: Date.now() });
s1.history.push({ id: 'b', type: 'text', content: 'just a normal clip', ts: Date.now() });

ok('marking a prompt returns true', s1.api.promptItem('a') === true, '');
ok('prompt left history', s1.history.length === 1 && s1.history[0].id === 'b', s1.history.map(h => h.id).join(','));
ok('prompt entered the persistent store', s1.pinned.length === 1 && s1.pinned[0].isPrompt === true, '');
ok('marking twice is a no-op', s1.api.promptItem('a') === false, '');
ok('store file written', fs.existsSync(pinnedStorePath), '');

// simulate a full app restart: brand new context, load from disk
const s2 = freshContext();
s2.api.loadPinned();
ok('prompt survives a restart', s2.pinned.length === 1 && s2.pinned[0].id === 'a', s2.pinned.length + ' loaded');
ok('isPrompt survives a restart', s2.pinned[0] && s2.pinned[0].isPrompt === true, JSON.stringify(s2.pinned[0] && s2.pinned[0].isPrompt));
ok('content survives intact', s2.pinned[0] && s2.pinned[0].content === 'summarize this like a changelog', '');

// unmarking drops it back into ephemeral history
ok('unmark returns true', s2.api.unpromptItem('a') === true, '');
ok('unmarked clip left the store', s2.pinned.length === 0, s2.pinned.length + '');
ok('unmarked clip is back in history', s2.history.length === 1 && !s2.history[0].isPrompt, '');

const s3 = freshContext();
s3.api.loadPinned();
ok('unmark persisted too', s3.pinned.length === 0, s3.pinned.length + '');

// a pinned clip promoted to prompt keeps one entry, not two
const s4 = freshContext();
s4.history.push({ id: 'p', type: 'text', content: 'pinned then promoted', ts: Date.now() });
s4.api.pinItem('p');
ok('pin then prompt keeps a single entry', s4.api.promptItem('p') === true && s4.pinned.length === 1, s4.pinned.length + '');
ok('promoted entry is flagged', s4.pinned[0].isPrompt === true, '');

fs.rmSync(STORE, { recursive: true, force: true });

// ---------- part 2: the drawer ----------
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 340, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(() => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    let marked = null, unmarked = null;
    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {},
      pin: async () => {}, unpin: async () => {}, hide: () => {},
      markPrompt: async (id) => { marked = id; }, unmarkPrompt: async (id) => { unmarked = id; },
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    pinned = [
      { id: 'pr1', type: 'text', content: 'act as a staff engineer and review', ts: Date.now(), isPrompt: true },
      { id: 'pr2', type: 'code', content: 'refactor {{code}} for clarity', ts: Date.now(), isPrompt: true },
      { id: 'pn1', type: 'img', content: 'img', meta: '400x400', ts: Date.now() },
    ];
    history = [{ id: 'h1', type: 'text', content: 'ephemeral clip', ts: Date.now() }];
    render();

    // prompts are a place on the rail, not a section in a stack of sections
    const goTo = (scope) => [...document.querySelectorAll('.rail-item')]
      .find(b => b.dataset.scope === scope).click();
    const rows = () => [...document.querySelectorAll('.item')];

    ok('the rail offers prompts as a place',
       !!document.querySelector('.rail-item[data-scope=\\"prompts\\"]'), '');
    ok('no section headers anywhere', document.querySelectorAll('.section-label').length === 0,
       document.querySelectorAll('.section-label').length + '');
    ok('everything shows all of it', rows().length === 4, rows().length + '');

    goTo('prompts');
    ok('the prompts place holds both prompts', rows().length === 2, rows().length + '');
    ok('the header names the place', document.getElementById('scopeName').textContent === 'prompts',
       document.getElementById('scopeName').textContent);
    goTo('pinned');
    ok('the pinned place excludes prompts', rows().length === 1, rows().length + '');

    goTo('prompts');
    const promptRow = rows()[0];
    ok('prompt badge replaces the type badge', promptRow.querySelector('.type-badge').textContent.trim() === 'prompt',
       promptRow.querySelector('.type-badge').textContent.trim());
    ok('prompt row has no pin button', !promptRow.querySelector('[data-act=\\"pin\\"]'), '');
    ok('prompt row meta says prompt', promptRow.querySelector('.item-meta').textContent.includes('prompt'),
       promptRow.querySelector('.item-meta').textContent.trim());
    ok('mark button is on for a prompt', promptRow.querySelector('[data-act=\\"prompt\\"]').classList.contains('on'), '');

    goTo('all');
    const histRow = rows().find(r => r.dataset.id === 'h1');
    ok('history row has both buttons',
       !!histRow.querySelector('[data-act=\\"pin\\"]') && !!histRow.querySelector('[data-act=\\"prompt\\"]'), '');
    histRow.querySelector('[data-act=\\"prompt\\"]').click();
    ok('clicking mark calls markPrompt', marked === 'h1', String(marked));
    goTo('prompts');
    rows()[0].querySelector('[data-act=\\"prompt\\"]').click();
    ok('clicking again calls unmarkPrompt', unmarked === 'pr1', String(unmarked));

    // the filter pills now deal only in types
    ok('pills are types only',
       [...document.querySelectorAll('.filters .pill')].map(p => p.textContent).join(',') === 'all,text,code,url,image,color',
       [...document.querySelectorAll('.filters .pill')].map(p => p.textContent).join(','));

    // search narrows within the place you are in
    goTo('prompts'); searchQuery = 'refactor'; render();
    ok('search narrows the current place', rows().length === 1, rows().length + '');
    searchQuery = ''; goTo('all');

    ok('footer counts prompts separately',
       document.getElementById('footerInfo').textContent.includes('2 prompts') &&
       document.getElementById('footerInfo').textContent.includes('1 pinned'),
       document.getElementById('footerInfo').textContent);

    // prompts still take part in the stack
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    ok('prompts can be stacked', selected.size === 4, selected.size + '');

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

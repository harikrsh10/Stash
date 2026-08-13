// Sessions: the store (including a simulated restart) and the drawer UI.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const grab = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};

const STORE = path.join(os.tmpdir(), 'stash-session-test');
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });
const sessionStorePath = path.join(STORE, 'sessions.json');
const pinnedStorePath = path.join(STORE, 'pinned.json');

function freshContext() {
  const ctx = {
    fs, path, console,
    sessionStorePath, pinnedStorePath,
    sessions: [], sessionClips: [], pinned: [], history: [],
    settings: { activeSessionId: null },
  };
  vm.createContext(ctx);
  vm.runInContext([
    grab('loadSessions'), grab('saveSessions'), grab('sessionState'), grab('inSession'),
    grab('addToSession'), grab('removeFromSession'), grab('dropSessionImage'),
    grab('makeImagePermanent'),
  ].join('\n') + `
    this.api = { loadSessions, saveSessions, addToSession, removeFromSession, inSession, sessionState };`, ctx);
  return ctx;
}

const s = freshContext();
s.sessions.push({ id: 'ses1', name: 'Redesign', createdAt: Date.now() });

const clip = { id: 'c1', type: 'text', content: 'a note worth keeping', ts: Date.now() };
ok('a clip joins a session', s.api.addToSession(clip, 'ses1') === true, '');
ok('the session holds it', s.sessionClips.length === 1 && s.sessionClips[0].sessionId === 'ses1', '');
ok('adding the same clip twice is a no-op', s.api.addToSession(clip, 'ses1') === false, '');
ok('an unknown session refuses clips', s.api.addToSession(clip, 'nope') === false, '');

// the session keeps its own copy: history ages clips out and deletes their files
ok('the session copy is not the history object', s.sessionClips[0] !== clip, '');
clip.content = 'mutated after the fact';
ok('mutating the original leaves the session alone',
   s.sessionClips[0].content === 'a note worth keeping', s.sessionClips[0].content);

// restart
const s2 = freshContext();
s2.api.loadSessions();
ok('sessions survive a restart', s2.sessions.length === 1 && s2.sessions[0].name === 'Redesign',
   JSON.stringify(s2.sessions.map(x => x.name)));
ok('their clips survive too', s2.sessionClips.length === 1
   && s2.sessionClips[0].content === 'a note worth keeping', '');

ok('removing takes it out', s2.api.removeFromSession('c1', 'ses1') === true, '');
ok('removing something absent says so', s2.api.removeFromSession('c1', 'ses1') === false, '');

const s3 = freshContext();
s3.api.loadSessions();
ok('removal persisted', s3.sessionClips.length === 0, s3.sessionClips.length + '');

// the same clip can sit in two sessions
const s4 = freshContext();
s4.sessions.push({ id: 'a', name: 'A', createdAt: 1 }, { id: 'b', name: 'B', createdAt: 2 });
const shared = { id: 'x', type: 'text', content: 'shared', ts: Date.now() };
s4.api.addToSession(shared, 'a');
s4.api.addToSession(shared, 'b');
ok('one clip can belong to two sessions', s4.sessionClips.length === 2, s4.sessionClips.length + '');
ok('removing from one leaves the other', s4.api.removeFromSession('x', 'a') && s4.sessionClips.length === 1
   && s4.sessionClips[0].sessionId === 'b', '');

// an image shared by two sessions must not have its file deleted by the first removal
const s5 = freshContext();
s5.sessions.push({ id: 'a', name: 'A', createdAt: 1 }, { id: 'b', name: 'B', createdAt: 2 });
const imgPath = path.join(STORE, 'shot.png');
fs.writeFileSync(imgPath, 'not really a png');
const imgClip = { id: 'img', type: 'img', content: 'shot.png', filepath: imgPath, ts: Date.now() };
s5.api.addToSession(imgClip, 'a');
s5.api.addToSession(imgClip, 'b');
const stored = s5.sessionClips[0].filepath;
ok('an image is copied somewhere permanent', stored !== imgPath && fs.existsSync(stored), stored);
s5.api.removeFromSession('img', 'a');
ok('the file survives while another session still holds it', fs.existsSync(stored), '');
s5.api.removeFromSession('img', 'b');
ok('the file goes once nothing points at it', !fs.existsSync(stored), '');

fs.rmSync(STORE, { recursive: true, force: true });

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 340, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = () => new Promise(r => setTimeout(r, 0));
    const calls = [];
    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true, createPrompt: async () => true,
      ocr: async () => ({ ok: true }), onOcrProgress: () => {}, expandWindow: async () => {},
      createSession: async (n) => { calls.push(['create', n]); return 'new'; },
      renameSession: async (id, n) => { calls.push(['rename', id, n]); return true; },
      deleteSession: async (id) => { calls.push(['delete', id]); return true; },
      setActiveSession: async (id) => { calls.push(['setActive', id]); return id; },
      addToSession: async (c, s) => { calls.push(['add', c, s]); return true; },
      removeFromSession: async (c, s) => { calls.push(['remove', c, s]); return true; },
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    sessions = [{ id: 'ses1', name: 'Redesign', createdAt: 1 }, { id: 'ses2', name: 'Research', createdAt: 2 }];
    sessionClips = [
      { id: 'sc1', sessionId: 'ses1', type: 'text', content: 'collected while working', ts: Date.now() },
      { id: 'sc2', sessionId: 'ses2', type: 'text', content: 'from the other session', ts: Date.now() },
    ];
    activeSessionId = 'ses1';
    pinned = [];
    history = [{ id: 'h1', type: 'text', content: 'an ordinary clip', ts: Date.now() }];
    render();

    // the bar says what is being collected into
    ok('the bar names the active session',
       document.getElementById('sessionName').textContent.startsWith('Redesign'),
       document.getElementById('sessionName').textContent);
    ok('the bar is marked live', document.getElementById('sessionBtn').classList.contains('on'), '');

    // a section per session, the active one first
    const heads = [...document.querySelectorAll('.sessions-section .section-label')]
      .map(h => h.textContent.replace(/\\s+/g, ' ').trim());
    ok('a section per session with clips', heads.length === 2, heads.length + '');
    ok('the one being collected into comes first', heads[0].includes('Redesign'), heads[0]);

    const inSes = document.querySelector('.sessions-section .item');
    ok('session clips render in their section', !!inSes, '');
    ok('inside a session, delete becomes remove',
       inSes.querySelector('[data-act=\\"del\\"]').textContent === 'remove',
       inSes.querySelector('[data-act=\\"del\\"]').textContent);
    inSes.querySelector('[data-act=\\"del\\"]').click();
    await tick();
    ok('removing calls removeFromSession, not delete',
       JSON.stringify(calls[calls.length - 1]) === '[\\"remove\\",\\"sc1\\",\\"ses1\\"]',
       JSON.stringify(calls[calls.length - 1]));

    // an ordinary clip can be added to whatever is being collected into
    const histRow = [...document.querySelectorAll('.item')].find(r => r.dataset.id === 'h1');
    ok('ordinary rows offer to join the session', !!histRow.querySelector('[data-act=\\"ses\\"]'), '');
    histRow.querySelector('[data-act=\\"ses\\"]').click();
    await tick();
    ok('joining calls addToSession',
       JSON.stringify(calls[calls.length - 1]) === '[\\"add\\",\\"h1\\",\\"ses1\\"]',
       JSON.stringify(calls[calls.length - 1]));
    ok('a clip already in the session is not offered again',
       !document.querySelector('.sessions-section .item [data-act=\\"ses\\"]'), '');

    // rename and delete live on the section header
    const actions = document.querySelector('.sessions-section .session-actions');
    ok('the header offers collect, rename and delete',
       [...actions.querySelectorAll('button')].map(b => b.textContent).join(',') === 'collecting,rename,delete',
       [...actions.querySelectorAll('button')].map(b => b.textContent).join(','));

    // deleting throws away clips, so it asks first
    const del = [...actions.querySelectorAll('button')].find(b => b.textContent === 'delete');
    del.click();
    ok('the first click only arms deletion',
       del.textContent === 'sure?' && !calls.some(c => c[0] === 'delete'), del.textContent);
    del.click();
    await tick();
    ok('the second click deletes', JSON.stringify(calls[calls.length - 1]) === '[\\"delete\\",\\"ses1\\"]',
       JSON.stringify(calls[calls.length - 1]));

    // the picker
    document.getElementById('sessionBtn').click();
    const menu = document.getElementById('sessionMenu');
    ok('the picker opens', menu.classList.contains('show'), '');
    const labels = [...menu.querySelectorAll('button')].map(b => b.textContent);
    ok('it offers normal copying, each session, and a way to make one',
       labels[0].startsWith('nothing') && labels.some(l => l.startsWith('Redesign'))
       && labels[labels.length - 1] === '+ new session', JSON.stringify(labels));
    // creating one: the button becomes a field you type a name into
    const newBtn = [...menu.querySelectorAll('button')].find(b => b.textContent === '+ new session');
    newBtn.click();
    ok('the new-session field appears', !!document.querySelector('.session-input'),
       document.querySelector('.session-input') ? 'present' : 'GONE — the menu closed itself');
    const nameField = document.querySelector('.session-input');
    if (nameField) {
      nameField.value = 'Redesign work';
      nameField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
    }
    ok('typing a name and pressing enter creates the session',
       JSON.stringify(calls[calls.length - 1]) === '[\\"create\\",\\"Redesign work\\"]',
       JSON.stringify(calls[calls.length - 1]));

    document.getElementById('sessionBtn').click();
    const menu2 = document.getElementById('sessionMenu');
    [...menu2.querySelectorAll('button')][0].click();
    await tick();
    ok('choosing nothing stops collecting',
       JSON.stringify(calls[calls.length - 1]) === '[\\"setActive\\",null]',
       JSON.stringify(calls[calls.length - 1]));

    // with nothing active, rows stop offering to join
    activeSessionId = null; render();
    ok('no session, no join buttons', !document.querySelector('[data-act=\\"ses\\"]'), '');
    ok('the bar says normal copying',
       document.getElementById('sessionName').textContent.includes('normal copying'),
       document.getElementById('sessionName').textContent);
    ok('sections remain so old sessions stay reachable',
       document.querySelectorAll('.sessions-section').length === 2,
       document.querySelectorAll('.sessions-section').length + '');

    // a clip in both places is still one entry for selection purposes
    activeSessionId = 'ses1';
    sessionClips.push({ id: 'h1', sessionId: 'ses1', type: 'text', content: 'an ordinary clip', ts: Date.now() });
    render();
    ok('a clip shown twice appears once in the selection order',
       renderedOrder.filter(id => id === 'h1').length === 1,
       renderedOrder.filter(id => id === 'h1').length + '');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    ok('select-all counts it once', selected.size === renderedOrder.length,
       selected.size + ' of ' + renderedOrder.length);

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

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
    collectionStats: {
      totalCaptures: 0,
      activeCollectionCaptures: 0,
      collectionsCreated: 0,
      activeStops: 0,
      activeChanges: 0,
    },
    activeCollectionRunCaptures: {},
    settings: { activeSessionId: null },
  };
  vm.createContext(ctx);
  vm.runInContext([
    grab('loadSessions'), grab('saveSessions'), grab('collectionStatsSnapshot'),
    grab('sessionState'), grab('inSession'),
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

// ---------- collecting reaches the drawer ----------
// The clip was being collected and saved, but the drawer keeps its own list of
// session clips and was only told about the history entry, so the session on
// screen stayed empty until something forced a full state broadcast.
const cap = freshContext();
cap.sessions.push({ id: 'live', name: 'Live', createdAt: Date.now() });
cap.settings.activeSessionId = 'live';
const sent = [];
Object.assign(cap, {
  HISTORY_LIMIT: 100,
  mainWindow: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
  dockWindow: null,
  refreshDock: () => {},
  refreshTrayMenu: () => {},
});
vm.runInContext([grab('collectIfActive'), grab('addEntry')].join('\n')
  + '\nthis.api.collectIfActive = collectIfActive; this.api.addEntry = addEntry;', cap);

cap.api.addEntry({ id: 'c1', type: 'text', content: 'copied while collecting', ts: Date.now() });
ok('a copied clip joins the live session', cap.sessionClips.length === 1, cap.sessionClips.length + '');
ok('it lands in history too', cap.history.length === 1, cap.history.length + '');
const newMsg = sent.find(m => m[0] === 'clip:new');
ok('the drawer is told about the clip', !!newMsg, '');
ok('the session copy travels with it',
   !!newMsg && !!newMsg[2] && newMsg[2].sessionId === 'live',
   newMsg ? JSON.stringify(newMsg[2] && newMsg[2].sessionId) : 'no message');

cap.settings.activeSessionId = null;
cap.api.addEntry({ id: 'c2', type: 'text', content: 'copied with nothing collecting', ts: Date.now() });
const second = sent.filter(m => m[0] === 'clip:new')[1];
ok('with nothing collecting, no copy travels', !!second && second[2] === null,
   second ? JSON.stringify(second[2]) : 'no message');
ok('and nothing is added to any session', cap.sessionClips.length === 1, cap.sessionClips.length + '');

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
    let multiDrag = null;
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
      startDrag: () => {},
      startDragMulti: (entries) => { multiDrag = entries; },
      drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    sessions = [{ id: 'ses1', name: 'Redesign', createdAt: 1 }, { id: 'ses2', name: 'Research', createdAt: 2 }];
    sessionClips = [
      { id: 'sc1', sessionId: 'ses1', type: 'text', content: 'collected while working', ts: Date.now() },
      { id: 'sc1b', sessionId: 'ses1', type: 'text', content: 'a second collected clip', ts: Date.now() },
      { id: 'sc2', sessionId: 'ses2', type: 'text', content: 'from the other session', ts: Date.now() },
    ];
    activeSessionId = 'ses1';
    collectionStats = {
      totalCaptures: 5,
      activeCollectionCaptures: 3,
      activeCaptureRate: 0.6,
      activeCollectionRunCaptures: 1,
      totalCollections: 2,
      underfedCollections: 1,
    };
    pinned = [];
    history = [{ id: 'h1', type: 'text', content: 'an ordinary clip', ts: Date.now() }];
    render();

    const goTo = (scope) => [...document.querySelectorAll('.rail-item')]
      .find(b => b.dataset.scope === scope).click();
    const rows = () => [...document.querySelectorAll('.item')];

    // every session is a place on the rail
    const railLabels = [...document.querySelectorAll('.rail-item .lbl')].map(n => n.textContent);
    ok('the rail lists the fixed places, then new and the sessions',
       railLabels.join(',') === 'all,prompts,pinned,new,Redesign,Research', railLabels.join(','));

    // the rail is two cards: the fixed places, then new with the sessions
    // stacked under it
    const labelsIn = (sel) => [...document.querySelectorAll(sel + ' .rail-item .lbl')]
      .map(n => n.textContent).join(',');
    ok('the places card holds only the three fixed places',
       labelsIn('#rail') === 'all,prompts,pinned', labelsIn('#rail'));
    ok('new holds the top of the sessions card',
       labelsIn('#railSessions') === 'new,Redesign,Research', labelsIn('#railSessions'));
    ok('a divider sits between new and the sessions',
       document.querySelectorAll('#railSessions .rail-sep').length === 1,
       document.querySelectorAll('#railSessions .rail-sep').length + '');

    // Rebuilding must be idempotent. buildRail used to clear and then append
    // across many statements, so a render re-entered partway through left every
    // place on the rail twice.
    render();
    render();
    const afterRepeat = [...document.querySelectorAll('.rail-item .lbl')].map(n => n.textContent);
    ok('rendering again does not duplicate the rail',
       afterRepeat.join(',') === 'all,prompts,pinned,new,Redesign,Research', afterRepeat.join(','));
    ok('no section headers survive', document.querySelectorAll('.section-label').length === 0,
       document.querySelectorAll('.section-label').length + '');
    ok('the session being collected into is marked on the rail',
       !!document.querySelector('.rail-item.session .rec'), '');
    ok('the active collection banner is visible',
       document.getElementById('collectionBanner').classList.contains('show'), '');
    ok('the active collection banner names the collection',
       document.getElementById('collectionBannerName').textContent === 'Redesign',
       document.getElementById('collectionBannerName').textContent);
    ok('the active collection banner shows collection size',
       document.getElementById('collectionBannerCount').textContent === '2',
       document.getElementById('collectionBannerCount').textContent);
    ok('the footer exposes local collection stats',
       document.getElementById('footerInfo').title.includes('3/5 clips'),
       document.getElementById('footerInfo').title);

    goTo('ses1');
    ok('the header names the session', document.getElementById('scopeName').textContent === 'Redesign',
       document.getElementById('scopeName').textContent);
    ok('it holds only that session\\'s clips',
       rows().map(r => r.dataset.id).join(',') === 'sc1,sc1b',
       rows().map(r => r.dataset.id).join(','));

    const inSes = rows()[0];
    // Delete means delete, wherever you are standing. Taking a clip out of one
    // session without destroying it is what the session button is for, so the
    // two acts are no longer the same button wearing different labels.
    ok('inside a session, delete still means delete',
       inSes.querySelector('[data-act=\\"del\\"]').title.includes('delete from Stash'),
       inSes.querySelector('[data-act=\\"del\\"]').title);

    // the session button is the membership editor, and shows this clip is held
    const sesMenu = document.getElementById('sesMenu');
    ok('a clip in a session says so on its session button',
       inSes.querySelector('[data-act=\\"ses\\"]').classList.contains('in-session'), '');
    inSes.querySelector('[data-act=\\"ses\\"]').click();
    await tick();
    ok('the session button opens a list', sesMenu.classList.contains('show'), '');
    const held = sesMenu.querySelector('button[data-session=\\"ses1\\"]');
    ok('with the session it is already in ticked', held && held.classList.contains('on'),
       held ? held.className : 'missing');
    held.click();
    await tick();
    ok('picking a ticked session takes the clip out of it',
       JSON.stringify(calls[calls.length - 1]) === '[\\"remove\\",\\"sc1\\",\\"ses1\\"]',
       JSON.stringify(calls[calls.length - 1]));
    ok('and the list puts itself away', !sesMenu.classList.contains('show'), '');

    // an ordinary clip can be put into any session, not only the collected one
    goTo('all');
    const histRow = rows().find(r => r.dataset.id === 'h1');
    ok('every row offers the session button', !!histRow.querySelector('[data-act=\\"ses\\"]'), '');
    ok('one in no session is not marked',
       !histRow.querySelector('[data-act=\\"ses\\"]').classList.contains('in-session'), '');
    histRow.querySelector('[data-act=\\"ses\\"]').click();
    await tick();
    const unheld = sesMenu.querySelector('button[data-session=\\"ses1\\"]');
    ok('a session it is not in shows unticked', unheld && !unheld.classList.contains('on'), '');
    unheld.click();
    await tick();
    ok('picking it adds the clip there',
       JSON.stringify(calls[calls.length - 1]) === '[\\"add\\",\\"h1\\",\\"ses1\\"]',
       JSON.stringify(calls[calls.length - 1]));
    goTo('ses1');

    // collect, rename and delete live on the scope header
    const actions = document.getElementById('scopeActions');
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

    // making one from the rail
    document.getElementById('railAdd').click();
    ok('the new-session field appears', !!document.querySelector('.rail-name'),
       document.querySelector('.rail-name') ? 'present' : 'GONE — something closed it');
    const nameField = document.querySelector('.rail-name');
    if (nameField) {
      nameField.value = 'Redesign work';
      nameField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
    }
    ok('typing a name and pressing enter creates the session',
       JSON.stringify(calls[calls.length - 1]) === '[\\"create\\",\\"Redesign work\\"]',
       JSON.stringify(calls[calls.length - 1]));

    // stopping collection, from the session's own header
    goTo('ses1');
    [...document.getElementById('scopeActions').querySelectorAll('button')]
      .find(b => b.textContent === 'collecting').click();
    await tick();
    ok('the header can stop collecting',
       JSON.stringify(calls[calls.length - 1]) === '[\\"setActive\\",null]',
       JSON.stringify(calls[calls.length - 1]));

    // with nothing being collected into, rows stop offering to join
    activeSessionId = null; goTo('all');
    ok('the session button is there whether or not anything is collecting',
       !!document.querySelector('[data-act=\\"ses\\"]'), '');
    ok('nothing is marked as collecting on the rail',
       !document.querySelector('.rail-item .rec'), '');
    ok('the sessions stay on the rail so they remain reachable',
       document.querySelectorAll('.rail-item.session').length === 2,
       document.querySelectorAll('.rail-item.session').length + '');

    // a place that disappears drops you back to everything
    activeScope = 'ses2';
    sessions = sessions.filter(s => s.id !== 'ses2');
    render();
    ok('deleting the place you were in returns you to everything', activeScope === 'all', activeScope);

    // a clip collected while you watch must appear in the session immediately,
    // without needing a full state broadcast to shake it loose
    sessions.push({ id: 'ses2', name: 'Research', createdAt: 2 }); // put back the one just deleted
    render();
    goTo('ses2');
    const beforeLive = rows().length;
    // exactly what the clip:new handler does when main reports a collected clip
    history.unshift({ id: 'live1', type: 'text', content: 'copied just now', ts: Date.now() });
    takeCollected({ id: 'live1', sessionId: 'ses2', type: 'text', content: 'copied just now', ts: Date.now() });
    render();
    ok('a clip collected while watching appears at once', rows().length === beforeLive + 1,
       beforeLive + ' -> ' + rows().length);
    ok('it went into the session being viewed',
       rows()[0].dataset.id === 'live1', rows()[0].dataset.id);
    goTo('all');
    ok('and it is in everything as well',
       !!rows().find(r => r.dataset.id === 'live1'), '');

    // selecting inside a session has to build a stack like anywhere else —
    // session clips live in their own store, so an id lookup that only knows
    // history and pinned finds nothing and the tray silently stays hidden
    goTo('ses1');
    const sesRows = rows();
    sesRows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    ok('a clip inside a session can be selected', selected.size === 1, selected.size + '');
    ok('the stack tray appears inside a session',
       document.getElementById('stackTray').classList.contains('show'),
       document.getElementById('stackTray').classList.contains('show') ? '' : 'hidden — selectedClips found nothing');
    ok('the deck holds the session clip', document.querySelectorAll('.stack-card').length === 1,
       document.querySelectorAll('.stack-card').length + '');
    ok('the count reads 1', document.getElementById('stackCount').textContent === '01',
       document.getElementById('stackCount').textContent);

    // and dragging it out carries the session's own copy
    multiDrag = null;
    if (sesRows.length > 1) {
      sesRows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      sesRows[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      ok('dragging from a session carries both clips',
         Array.isArray(multiDrag) && multiDrag.length === 2,
         multiDrag ? multiDrag.map(c => c.id).join(',') : 'nothing was sent');
      sesRows[0].dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    }
    clearSelection();

    // one clip, one entry in the selection order, wherever it shows
    activeSessionId = 'ses1';
    sessionClips.push({ id: 'h1', sessionId: 'ses1', type: 'text', content: 'an ordinary clip', ts: Date.now() });
    goTo('all');
    ok('a clip appears once in the selection order',
       renderedOrder.filter(id => id === 'h1').length === 1,
       renderedOrder.filter(id => id === 'h1').length + '');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    ok('select-all counts it once', selected.size === renderedOrder.length,
       selected.size + ' of ' + renderedOrder.length);


    // ---------- a clip that lives only in a session ----------
    // Collected clips age out of history. findClip only looked at pinned and
    // history, so anything opened by id inside a session -- the preview panel,
    // the prompt editor -- silently did nothing when you clicked it.
    history = [];
    pinned = [];
    sessionClips = [
      { id: 'only', sessionId: 'ses1', type: 'text', content: '#E2E6EA', ts: Date.now() },
    ];
    activeScope = 'ses1';
    render();
    await tick(10);

    const onlyRow = document.querySelector('.item[data-id="only"]');
    ok('a session-only clip still draws a row', !!onlyRow, '');
    onlyRow.querySelector('[data-act="name"]').click();
    await tick(60);
    const inspEl = document.getElementById('inspector');
    ok('and its preview panel opens', inspEl.classList.contains('show'), '');
    ok('showing that clip, not another', document.getElementById('inspName').value === '', '');
    ok('with the colour spelled out in the facts',
       [...document.querySelectorAll('#inspMeta .meta-row')]
         .some(r => r.querySelector('.meta-key').textContent === 'Hex'), '');

    return out;
  })()`;

  let rendered;
  try {
    // wrapped so a throw inside the probe comes back with its message instead
    // of an opaque "script failed to execute"
    rendered = await win.webContents.executeJavaScript(
      '(async()=>{try{ return await ' + probe + ' }catch(e){ return [{name:"probe threw: "+e.message, pass:false, detail:String(e.stack||"").slice(0,300)}] }})()', true);
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

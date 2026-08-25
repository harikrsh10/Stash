// Searching for words that are inside a picture rather than in anything you
// copied as text. Drives the real drawer: the point is not that a substring
// matches, it is that the screenshot turns up in the results and says why.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const SRCDIR = path.join(__dirname, '..', 'src');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));

    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      expandWindow: async () => {}, onOcrProgress: () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    const search = document.getElementById('search');
    const ids = () => [...document.querySelectorAll('.item')].map(e => e.dataset.id);
    const row = (id) => document.querySelector('.item[data-id=\\"' + id + '\\"]');
    const type = async (q) => {
      search.value = q;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await tick(10);
    };

    pinned = [];
    sessionClips = [];
    history = [
      { id: 'shot', type: 'img', content: 'clip-1699999999.png', meta: '800×600',
        ocrText: 'Error: invalid token in request handler', ts: Date.now() },
      { id: 'note', type: 'text', content: 'the nav spacing feels tight', ts: Date.now() - 1 },
      { id: 'other', type: 'img', content: 'clip-1688888888.png', meta: '400×300',
        ocrText: 'Deploy succeeded in 42s', ts: Date.now() - 2 },
    ];
    render();
    await tick(10);
    ok('everything shows with no search', ids().length === 3, ids().join(','));

    // ---------- the whole point ----------
    await type('invalid token');
    ok('a screenshot is found by words inside it', ids().join(',') === 'shot', ids().join(','));
    ok('and says that is why it is here',
       !!row('shot') && !!row('shot').querySelector('.in-image'), 'no marker on the row');
    const hit = row('shot') && row('shot').querySelector('.ocr-hit');
    ok('showing the line it matched', !!hit && hit.textContent.includes('invalid token'),
       hit ? hit.textContent : 'no excerpt');

    await type('deploy');
    ok('a different picture is found by its own text', ids().join(',') === 'other', ids().join(','));

    await type('nav spacing');
    ok('ordinary text search still works', ids().join(',') === 'note', ids().join(','));
    ok('and a text clip gets no image marker',
       !row('note').querySelector('.in-image'), 'marked as an image hit');

    await type('nothing in any of these');
    ok('a word in nothing finds nothing', ids().length === 0, ids().join(','));

    // a picture found by its filename is not an "in image" hit
    await type('clip-1699999999');
    ok('a picture can still be found by its filename', ids().join(',') === 'shot', ids().join(','));
    ok('but that is not reported as text inside it',
       !row('shot').querySelector('.in-image'), 'wrongly marked');

    // a name the user gave it is searchable too
    await type('');
    history[1].name = 'kerning memo';
    render();
    await tick(10);
    await type('kerning');
    ok('a clip is found by the name you gave it', ids().join(',') === 'note', ids().join(','));

    // ---------- text arriving after the search was typed ----------
    await type('');
    history.push({ id: 'late', type: 'img', content: 'clip-late.png', meta: '100×100',
                   ts: Date.now() - 3 });
    render();
    await tick(10);
    await type('grafana');
    ok('before it is read, a picture is not findable by its text',
       ids().length === 0, ids().join(','));
    // window.api is stubbed after the page loads, so the subscription has
    // already bound to the real handler -- which is why it is a named function
    // rather than an inline one, and can be driven directly here.
    ok('there is a handler for text arriving late', typeof applyIndexedText === 'function', 'missing');
    applyIndexedText('late', 'CPU usage grafana dashboard');
    await tick(20);
    ok('once read it turns up without retyping the search',
       ids().join(',') === 'late', ids().join(','));
    ok('marked as a hit inside the picture',
       !!row('late') && !!row('late').querySelector('.in-image'), 'not marked');

    // ---------- what the excerpt does with an awkward match ----------
    await type('');
    history = [{ id: 'long', type: 'img', content: 'x.png', meta: '10×10',
      ocrText: 'a'.repeat(200) + ' NEEDLE ' + 'b'.repeat(200), ts: Date.now() }];
    render();
    await tick(10);
    await type('needle');
    const ex = row('long').querySelector('.ocr-hit').textContent;
    ok('a match deep in a wall of text is trimmed around', ex.length < 120, ex.length + ' chars');
    ok('and still contains the match', ex.toLowerCase().includes('needle'), ex);
    ok('with ellipses showing it was cut', ex.startsWith('…') && ex.endsWith('…'), ex);

    return out;
  })()`;

  let results;
  try {
    results = await win.webContents.executeJavaScript(
      '(async()=>{try{ return await ' + probe + ' }catch(e){ return [{name:"probe threw: "+e.message, pass:false, detail:String(e.stack||"").slice(0,300)}] }})()', true);
  } catch (err) {
    results = [{ name: 'probe could not run', pass: false, detail: String(err.message) }];
  }

  let failed = 0;
  results.forEach(r => {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  });
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});

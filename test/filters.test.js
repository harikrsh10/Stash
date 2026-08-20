// The type filters, and the colour one in particular. A colour is not a kind
// of clip the way a url or an image is -- it is a text clip whose content is
// nothing but colour values -- so the filter is derived from content and has
// to hold up against the things that merely contain a colour somewhere.
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
    const NL = String.fromCharCode(10);

    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      expandWindow: async () => {}, onOcrProgress: () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    // ---------- what counts as a colour ----------
    const yes = [
      ['a bare hex', '#3B82F6'],
      ['shorthand hex', '#fff'],
      ['hex with alpha', '#3B82F6FF'],
      ['rgb', 'rgb(255, 0, 0)'],
      ['rgba', 'rgba(0,0,0,0.5)'],
      ['hsl', 'hsl(210, 90%, 60%)'],
      ['a palette copied out of the colour panel', '#3B82F6' + NL + '#EF4444' + NL + '#10B981'],
      ['a comma separated pair', '#3B82F6, #EF4444'],
    ];
    yes.forEach(([what, text]) => ok(what + " reads as a colour", looksLikeColour(text), text));

    const no = [
      ['ordinary prose', 'the nav spacing feels tight at 1440'],
      ['a declaration that merely contains one', 'background: #3B82F6;'],
      ['a hex of the wrong length', '#12345'],
      ['a url with a fragment that looks hexish', 'https://example.com/#fff'],
      ['code', 'startDrag({ files, icon })'],
      ['nothing at all', ''],
    ];
    no.forEach(([what, text]) => ok(what + " does not", !looksLikeColour(text), text));

    // ---------- the filter in the drawer ----------
    pinned = [];
    history = [
      { id: 'hex', type: 'text', content: '#3B82F6', ts: Date.now() },
      { id: 'palette', type: 'text', content: '#3B82F6' + NL + '#EF4444', ts: Date.now() - 1 },
      { id: 'prose', type: 'text', content: 'the nav spacing feels tight at 1440', ts: Date.now() - 2 },
      { id: 'code', type: 'code', content: 'const x = 1;', ts: Date.now() - 3 },
      { id: 'link', type: 'url', content: 'https://example.com', ts: Date.now() - 4 },
    ];
    render();

    const pill = (t) => document.querySelector('.pill[data-type=\"' + t + '\"]');
    const ids = () => [...document.querySelectorAll('.item')].map(e => e.dataset.id);

    ok('the row offers a colour filter', !!pill('color'), '');
    ok('and still offers the other five',
       ['all', 'text', 'code', 'url', 'img'].every(t => !!pill(t)), '');

    pill('color').click();
    await tick(10);
    ok('colour keeps only the clips that are colour values',
       ids().join(',') === 'hex,palette', ids().join(','));

    pill('text').click();
    await tick(10);
    ok('text still keeps every text clip, colours among them',
       ids().join(',') === 'hex,palette,prose', ids().join(','));

    pill('all').click();
    await tick(10);
    ok('all brings everything back', ids().length === 5, ids().join(','));

    // a colour clip is still a text clip underneath
    ok('the colour filter does not invent a type',
       history.every(c => c.type !== 'color'), '');


    // ---------- how a colour clip reads ----------
    history = [
      { id: 'one', type: 'text', content: '#C03E2F', ts: Date.now() },
      { id: 'pal', type: 'text', content: '#3B82F6' + NL + '#EF4444' + NL + '#10B981', ts: Date.now() - 1 },
      // esc() does not escape quotes, so a colour written straight into a style
      // attribute would let clipboard content break out of it
      { id: 'evil', type: 'text', content: 'rgb(" onerror=alert(1) x)', ts: Date.now() - 2 },
      { id: 'prose', type: 'text', content: 'just some words', ts: Date.now() - 3 },
    ];
    render();
    await tick(20);

    const row = (id) => document.querySelector('.item[data-id=\\"' + id + '\\"]');
    const badgeOf = (id) => row(id).querySelector('.type-badge').textContent;
    const chipsOf = (id) => [...row(id).querySelectorAll('.colour-chip')];

    ok('a colour clip badges as colour, not text', badgeOf('one') === 'color', badgeOf('one'));
    ok('and shows the colour itself', chipsOf('one').length === 1, String(chipsOf('one').length));
    ok('painted with the value it holds',
       chipsOf('one')[0].style.backgroundColor === 'rgb(192, 62, 47)',
       chipsOf('one')[0].style.backgroundColor);
    ok('the value is spelled out beside it',
       row('one').querySelector('.colour-value').textContent === '#C03E2F',
       row('one').querySelector('.colour-value').textContent);

    ok('a palette gets one chip per colour', chipsOf('pal').length === 3, String(chipsOf('pal').length));

    ok('prose is still text', badgeOf('prose') === 'text', badgeOf('prose'));

    // the colour is assigned through CSSOM, so nothing can escape into markup
    ok('a quote-bearing rgb string does not read as a colour',
       badgeOf('evil') === 'text', badgeOf('evil'));
    ok('and injects no attribute anywhere',
       ![...document.querySelectorAll('*')].some(e => e.hasAttribute('onerror')), '');

    return out;
  })()`;

  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('RENDERER: ' + msg));
  let rendered;
  try {
    rendered = await win.webContents.executeJavaScript(
      // wrapped so a throw inside the probe comes back as a failing assertion
      // with its message, rather than as an opaque "script failed to execute"
      '(async()=>{try{ return await ' + probe + ' }catch(e){ return [{name:\"probe threw: \"+e.message, pass:false, detail:\""}] }})()', true);
  } catch (err) {
    console.log('PROBE THREW: ' + err.message);
    app.exit(1);
    return;
  }

  let failed = 0;
  for (const r of rendered) {
    if (!r.pass) failed++;
    console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
  }
  console.log(String.fromCharCode(10) + '' + (rendered.length - failed) + '/' + rendered.length + ' passed');
  app.exit(failed ? 1 : 0);
});

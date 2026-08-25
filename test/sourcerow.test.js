// How the app a clip came from reads on the row: its logo where there is one,
// its name where there is not. Drives the real drawer, because the claim is
// about what a person sees rather than about what is stored.
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
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      expandWindow: async () => {}, onOcrProgress: () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    const row = (id) => document.querySelector('.item[data-id=\\"' + id + '\\"]');
    pinned = [];
    sessionClips = [];
    sourceIcons = { 'Figma': PNG, 'Guarded App': null };
    history = [
      { id: 'known', type: 'text', content: 'copied out of figma', sourceApp: 'Figma', ts: 3 },
      { id: 'unknown', type: 'text', content: 'from something with no icon',
        sourceApp: 'Guarded App', ts: 2 },
      { id: 'none', type: 'text', content: 'no source app at all', ts: 1 },
    ];
    render();
    await tick(10);

    // ---------- the logo, where there is one ----------
    const icon = row('known').querySelector('.from-icon');
    ok('an app with an icon shows the icon', !!icon, 'no icon on the row');
    ok('and not its name as well',
       !row('known').querySelector('.from-app'), 'the name is still there too');
    ok('the icon is the one held for that app', icon && icon.getAttribute('src') === PNG,
       icon ? icon.getAttribute('src').slice(0, 24) : 'none');
    // an icon with no words is unreadable to a screen reader, and unrecognisable
    // for an app whose logo you have not learned yet
    ok('the name survives as alt text', icon && icon.getAttribute('alt') === 'Figma',
       icon ? icon.getAttribute('alt') : 'none');
    ok('and as a tooltip', icon && icon.getAttribute('title') === 'Figma',
       icon ? icon.getAttribute('title') : 'none');

    // ---------- the name, where there is no logo ----------
    ok('an app whose icon could not be read falls back to its name',
       !!row('unknown').querySelector('.from-app'), 'no name on the row');
    ok('and shows no broken image in its place',
       !row('unknown').querySelector('.from-icon'), 'an icon was rendered anyway');
    ok('the name is the one recorded',
       row('unknown').querySelector('.from-app').textContent === 'Guarded App',
       row('unknown').querySelector('.from-app').textContent);

    // ---------- a clip that never got a source ----------
    ok('a clip with no source app shows neither',
       !row('none').querySelector('.from-icon') && !row('none').querySelector('.from-app'), '');

    // ---------- an icon arriving after the row was drawn ----------
    history.push({ id: 'later', type: 'text', content: 'sourced a moment later', ts: 0 });
    render();
    await tick(10);
    ok('before it is known, the row carries nothing',
       !row('later').querySelector('.from-icon') && !row('later').querySelector('.from-app'), '');
    applySourceApp('later', 'Terminal', PNG);
    await tick(10);
    ok('once known, the logo appears without another copy',
       !!row('later').querySelector('.from-icon'), 'no icon after being told');
    ok('and the icon is remembered for every other row from that app',
       sourceIcons['Terminal'] === PNG, 'not cached');

    // a name with no icon still lands
    history.push({ id: 'nameonly', type: 'text', content: 'named but iconless', ts: -1 });
    render();
    applySourceApp('nameonly', 'Some App', null);
    await tick(10);
    ok('a source with no icon still shows its name',
       row('nameonly').querySelector('.from-app').textContent === 'Some App',
       row('nameonly').querySelector('.from-app')
         ? row('nameonly').querySelector('.from-app').textContent : 'nothing');

    // ---------- an app name is not a way into the markup ----------
    history = [{ id: 'evil', type: 'text', content: 'x',
                 sourceApp: '"><img src=x onerror=alert(1)>', ts: 1 }];
    sourceIcons = {};
    render();
    await tick(10);
    ok('an app name is escaped rather than parsed',
       row('evil').querySelectorAll('img').length === 0,
       row('evil').querySelectorAll('img').length + ' images rendered');
    ok('and shows as the text it is',
       row('evil').querySelector('.from-app').textContent === '"><img src=x onerror=alert(1)>',
       row('evil').querySelector('.from-app').textContent);

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

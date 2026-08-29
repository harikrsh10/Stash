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

    // ---------- a vector shows as the thing, not as its source ----------
    const SVG = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140">',
                 '<title>Storm cloud</title><rect width="10" height="10"/></svg>'].join('');
    sourceIcons = { 'Figma': PNG };
    history = [
      { id: 'vec', type: 'code', content: SVG, asset: 'svg', sourceApp: 'Figma', ts: 3 },
      { id: 'frame', type: 'text', content: ['Frame 12', 'lots of frame text'].join(String.fromCharCode(10)),
        asset: 'figma', sourceApp: 'Figma', ts: 2 },
    ];
    render();
    await tick(10);

    ok('a vector badges as an asset, not as code',
       row('vec').querySelector('.type-badge').textContent === 'assets',
       row('vec').querySelector('.type-badge').textContent);
    ok('a frame badges the same way',
       row('frame').querySelector('.type-badge').textContent === 'assets',
       row('frame').querySelector('.type-badge').textContent);
    ok('the name the drawing tool gave it is the headline',
       row('vec').querySelector('.asset-name').textContent === 'Storm cloud',
       row('vec').querySelector('.asset-name').textContent);

    const prev = row('vec').querySelector('.asset-preview');
    ok('the vector is drawn', !!prev, 'no preview');
    ok('through an img, so the clipboard cannot run anything',
       prev && prev.tagName === 'IMG', prev ? prev.tagName : 'none');
    ok('from a data url', prev && prev.src.startsWith('data:image/svg+xml;base64,'),
       prev ? prev.src.slice(0, 32) : 'none');
    // The row's own buttons are inline SVG icons, which is fine — they are
    // ours. What must never be live is the clipboard's SVG, so the check is
    // scoped to where that would land.
    ok('the clipboard svg is never put in the page as live markup',
       row('vec').querySelectorAll('.asset-stage svg').length === 0,
       row('vec').querySelectorAll('.asset-stage svg').length + ' live svg in the stage');
    ok('and a script inside a copied svg does not become a script tag',
       row('vec').querySelectorAll('.asset-stage script').length === 0, '');

    ok('the size is shown', row('vec').querySelector('.asset-when').textContent.includes('240×140'),
       row('vec').querySelector('.asset-when').textContent);
    ok('the source logo sits in the card foot',
       !!row('vec').querySelector('.asset-from .from-icon'), 'no logo');

    ok('a frame says it cannot be drawn rather than faking a preview',
       !!row('frame').querySelector('.asset-stage.empty'), 'no placeholder');
    // A sentence of instructions where the artwork should be reads as an error
    // message. A mark meaning "a thing you made" sits there better.
    ok('showing a mark rather than a sentence where the artwork would be',
       !!row('frame').querySelector('.asset-glyph'), 'no glyph');
    ok('and naming the kind of thing it is',
       (row('frame').querySelector('.asset-kind') || {}).textContent === 'Figma asset',
       (row('frame').querySelector('.asset-kind') || {}).textContent);
    ok('and shows no preview image',
       !row('frame').querySelector('.asset-preview'), 'a preview appeared');
    ok('and does not dump its text on the row',
       !row('frame').textContent.includes('lots of frame text'), 'frame text is on the row');

    // a name the user gave it wins over the one in the file
    history[0].name = 'My icon';
    render(); await tick(10);
    ok('a name you gave it wins',
       row('vec').querySelector('.asset-name').textContent === 'My icon',
       row('vec').querySelector('.asset-name').textContent);

    // the renderer copies of the asset helpers must not drift from the module
    ok('assetTitle agrees with the module', assetTitle(SVG) === 'Storm cloud', assetTitle(SVG));
    ok('assetSize agrees with the module', assetSize(SVG) === '240×140', assetSize(SVG));
    ok('previewable refuses something enormous', previewable('x'.repeat(600000)) === false, '');
    ok('and accepts an ordinary one', previewable(SVG) === true, '');

    // ---------- a picture from a drawing tool is artwork ----------
    // Figma offers only image/png when you copy an icon: no payload, no marker.
    // Where it came from is the only thing separating that from a screenshot.
    sourceIcons = { 'Figma': PNG };
    history = [
      { id: 'art', type: 'img', content: 'clip-1.png', meta: '64×64', dataUrl: PNG,
        asset: 'artwork', sourceApp: 'Figma', ts: 3 },
      { id: 'shot', type: 'img', content: 'clip-2.png', meta: '1920×1080', dataUrl: PNG,
        sourceApp: 'Google Chrome', ts: 2 },
    ];
    render();
    await tick(10);

    ok('a picture from a drawing tool badges as an asset',
       row('art').querySelector('.type-badge').textContent === 'assets',
       row('art').querySelector('.type-badge').textContent);
    ok('and is drawn on the asset stage', !!row('art').querySelector('.asset-preview'),
       'no preview');
    ok('named after where it came from, having no name of its own',
       row('art').querySelector('.asset-name').textContent === 'Figma asset',
       row('art').querySelector('.asset-name').textContent);
    ok('showing its pixel size',
       row('art').querySelector('.asset-when').textContent.includes('64×64'),
       row('art').querySelector('.asset-when').textContent);
    ok('an ordinary screenshot is still just an image',
       row('shot').querySelector('.type-badge').textContent === 'img',
       row('shot').querySelector('.type-badge').textContent);
    ok('and gets no asset card', !row('shot').querySelector('.asset-stage'), 'got one');

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

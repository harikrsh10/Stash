// The colour side of the inspector: quantisation on synthetic bitmaps, then
// the wiring that has to exist for a person to reach it.
//
// Pure node — the quantiser is lifted out of the real main.js rather than
// reimplemented here, so a change to the algorithm shows up as a failure.
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
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  [grab('samplePixels'), grab('histogramOf'), grab('medianCut'), grab('hexOf'), grab('luminanceOf'), grab('extractPalette')].join('\n')
  + '\nthis.api={samplePixels,histogramOf,medianCut,hexOf,luminanceOf,extractPalette};', ctx);
const api = ctx.api;

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// Electron hands back BGRA, so the bitmap builder writes in that order too —
// getting this backwards is exactly the bug the tests should catch.
function bitmapOf(colors) {
  const buf = Buffer.alloc(colors.length * 4);
  colors.forEach(([r, g, b, a], i) => {
    buf[i * 4] = b;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = r;
    buf[i * 4 + 3] = a === undefined ? 255 : a;
  });
  return buf;
}
const repeat = (color, n) => Array.from({ length: n }, () => color);

// ---------- reading the buffer ----------

const rgbOnly = api.samplePixels(bitmapOf([[255, 0, 0], [0, 255, 0], [0, 0, 255]]), 100);
ok('BGRA from the OS comes back as RGB',
   JSON.stringify(rgbOnly) === JSON.stringify([[255, 0, 0], [0, 255, 0], [0, 0, 255]]),
   JSON.stringify(rgbOnly));

const withAlpha = api.samplePixels(bitmapOf([[255, 0, 0, 255], [0, 255, 0, 0], [0, 0, 255, 127]]), 100);
ok('transparent pixels are not colours', withAlpha.length === 1, withAlpha.length + ' kept');

const big = api.samplePixels(bitmapOf(repeat([10, 20, 30], 50000)), 1000);
ok('a large image is strided, not walked whole', big.length <= 1100, big.length + ' samples');
ok('striding still returns the colour', big.length > 0 && big[0][0] === 10, JSON.stringify(big[0]));

ok('an empty buffer yields nothing', api.samplePixels(Buffer.alloc(0), 100).length === 0, '');

// ---------- the quantiser ----------

const solid = api.extractPalette(repeat([34, 68, 102], 500), 8);
ok('a solid colour is one swatch, not eight', solid.length === 1, solid.length + ' swatches');
ok('and it reports that colour', solid[0] && solid[0].hex === '#224466', solid[0] && solid[0].hex);
ok('a single colour is the whole image', solid[0] && Math.abs(solid[0].share - 1) < 0.001,
   solid[0] && solid[0].share);

// two halves, one clearly larger — proportions have to survive
const halves = api.extractPalette(repeat([255, 0, 0], 750).concat(repeat([0, 0, 255], 250)), 8);
ok('two distinct colours come back as two', halves.length === 2, halves.length + ' swatches');
ok('the dominant colour is listed first', halves[0] && halves[0].hex === '#FF0000',
   halves.map(c => c.hex).join(' '));
ok('shares reflect how much of the picture each covers',
   halves[0] && Math.abs(halves[0].share - 0.75) < 0.02 && Math.abs(halves[1].share - 0.25) < 0.02,
   halves.map(c => Math.round(c.share * 100) + '%').join(' '));

// The reason median cut is here at all: a screenshot is thousands of shades of
// almost the same background, and a palette of eight of them is useless.
const nearlySame = api.extractPalette(
  repeat([40, 40, 40], 200).concat(repeat([42, 41, 43], 200), repeat([38, 39, 41], 200)), 8);
ok('near-identical shades collapse into one swatch', nearlySame.length === 1,
   nearlySame.length + ': ' + nearlySame.map(c => c.hex).join(' '));

const merged = api.extractPalette(
  repeat([40, 40, 40], 300).concat(repeat([41, 41, 41], 300), repeat([220, 30, 30], 400)), 8);
ok('merging keeps distinct colours apart', merged.length === 2, merged.map(c => c.hex).join(' '));
ok('a merged swatch carries the share of everything folded into it',
   merged.find(c => c.share > 0.55) !== undefined,
   merged.map(c => Math.round(c.share * 100) + '%').join(' '));

// asking for more swatches than the image contains must not invent any
const three = api.extractPalette(
  repeat([255, 0, 0], 100).concat(repeat([0, 255, 0], 100), repeat([0, 0, 255], 100)), 8);
ok('a three-colour image gives three swatches', three.length === 3, three.map(c => c.hex).join(' '));

ok('nothing in, nothing out', api.extractPalette([], 8).length === 0, '');

const shares = api.extractPalette(
  repeat([200, 10, 10], 400).concat(repeat([10, 200, 10], 300), repeat([10, 10, 200], 300)), 8);
const shareSum = shares.reduce((n, c) => n + c.share, 0);
ok('shares add up to the whole image', Math.abs(shareSum - 1) < 0.02, shareSum.toFixed(3));
ok('swatches are ordered by how much of the image they are',
   shares.every((c, i) => i === 0 || shares[i - 1].share >= c.share),
   shares.map(c => Math.round(c.share * 100) + '%').join(' '));

// ---------- the values a swatch carries ----------

ok('hex is padded and upper case', api.hexOf(0, 10, 255) === '#000AFF', api.hexOf(0, 10, 255));
ok('hex rounds rather than truncates', api.hexOf(0.6, 0, 0) === '#010000', api.hexOf(0.6, 0, 0));
ok('hex clamps out-of-range values', api.hexOf(300, -20, 128) === '#FF0080', api.hexOf(300, -20, 128));

const white = api.extractPalette(repeat([255, 255, 255], 50), 4)[0];
const black = api.extractPalette(repeat([0, 0, 0], 50), 4)[0];
ok('a light swatch is flagged light, so its hex prints in ink', white && white.light === true, '');
ok('a dark swatch is not', black && black.light === false, '');
ok('green counts as brighter than blue at the same value',
   api.luminanceOf(0, 255, 0) > api.luminanceOf(0, 0, 255), '');

const rgbCarried = api.extractPalette(repeat([12, 34, 56], 50), 4)[0];
ok('rgb comes back alongside the hex',
   rgbCarried && JSON.stringify(rgbCarried.rgb) === JSON.stringify([12, 34, 56]),
   JSON.stringify(rgbCarried && rgbCarried.rgb));

// ---------- the wiring a person actually clicks ----------

const preload = fs.readFileSync(path.join(SRCDIR, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(SRCDIR, 'renderer.html'), 'utf8');

ok('main answers palette:run', /ipcMain\.handle\('palette:run'/.test(MAIN), '');
ok('it refuses anything that is not an image on disk',
   /palette:run[\s\S]*?type !== 'img'[\s\S]*?fs\.existsSync/.test(MAIN), '');
ok('it sends the full image, not the preview thumbnail',
   /palette:run[\s\S]*?pathToFileURL\(entry\.filepath\)/.test(MAIN), '');
ok('preload exposes palette', /palette:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('palette:run'/.test(preload), '');

ok('an image row offers colour beside text', /data-act="palette"/.test(renderer), '');
ok('the button is wired', /\[data-act="palette"\][\s\S]{0,120}runPalette/.test(renderer), '');
ok('colour only appears on images',
   /c\.type === 'img' \?[^\n]*data-act="palette"/.test(renderer), '');
ok('the inspector has a colour mode', /data-mode="color"/.test(renderer), '');
ok('swatches render into their own list', /inspSwatches/.test(renderer), '');
ok('picking colours feeds the same output panel',
   /inspMode === 'color'[\s\S]{0,200}inspPickedColors/.test(renderer), '');
ok('closing resets the mode so text opens as text',
   /closeInspector[\s\S]{0,400}inspMode = 'text'/.test(renderer), '');
ok('one job at a time — colour shares the busy guard with text',
   /async function runPalette[\s\S]{0,120}if \(ocrBusyId\) return/.test(renderer), '');

// ---------- the panel itself, in the real renderer ----------

const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 340, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

    let written = [], promptsCreated = [], paletteCalledWith = null;
    const colors = [
      { hex: '#1E1E1E', rgb: [30, 30, 30], share: 0.62, light: false },
      { hex: '#F8F4EC', rgb: [248, 244, 236], share: 0.28, light: true },
      { hex: '#C46A6A', rgb: [196, 106, 106], share: 0.10, light: false },
    ];

    window.api = {
      write: async (e) => { written.push(e); }, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true,
      ocr: async () => ({ ok: true, imageUrl: PNG, width: 4, height: 4, blocks: [
        { id: 'b0', text: 'hello', lineCount: 1, bbox: { x0: 0, y0: 0, x1: 4, y1: 4 } },
      ] }),
      palette: async (id) => { paletteCalledWith = id; await tick(10); return { ok: true, imageUrl: PNG, width: 4, height: 4, colors }; },
      expandWindow: async () => {},
      createPrompt: async (c) => { promptsCreated.push(c); return true; },
      onOcrProgress: () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
    };

    pinned = [];
    history = [
      { id: 'img1', type: 'img', content: 'image', meta: '900x560', ts: Date.now(), filepath: 'C:/x/a.png' },
      { id: 't1', type: 'text', content: 'just text', ts: Date.now() },
    ];
    render();

    const imgRow = document.querySelector('.item[data-id=\\"img1\\"]');
    const txtRow = document.querySelector('.item[data-id=\\"t1\\"]');
    ok('an image row offers colour', !!imgRow.querySelector('[data-act=\\"palette\\"]'), '');
    ok('a text row does not', !txtRow.querySelector('[data-act=\\"palette\\"]'), '');
    ok('colour sits beside text, not instead of it', !!imgRow.querySelector('[data-act=\\"ocr\\"]'), '');

    const insp = document.getElementById('inspector');
    imgRow.querySelector('[data-act=\\"palette\\"]').click();
    await tick(60);

    ok('the button asks main for that clip', paletteCalledWith === 'img1', String(paletteCalledWith));
    ok('the inspector opens', insp.classList.contains('show'), '');
    ok('and opens in colour mode', insp.dataset.mode === 'color', insp.dataset.mode);
    ok('the title says what this is', /colour/i.test(document.getElementById('inspTitle').textContent),
       document.getElementById('inspTitle').textContent);

    const swatches = [...document.querySelectorAll('.swatch')];
    ok('every colour gets a swatch', swatches.length === 3, swatches.length + '');
    ok('the swatch shows its hex', swatches[0].textContent.includes('#1E1E1E'), swatches[0].textContent);
    ok('and how much of the image it is', swatches[0].textContent.includes('62%'), swatches[0].textContent);
    ok('the chip is painted the colour it names',
       swatches[0].querySelector('.swatch-chip').style.background.replace(/ /g, '') === 'rgb(30,30,30)',
       swatches[0].querySelector('.swatch-chip').style.background);
    ok('a light colour prints its hex in ink, not white',
       swatches[1].querySelector('.swatch-chip').style.color.includes('--bg'),
       swatches[1].querySelector('.swatch-chip').style.color);
    ok('the count is in the hint', /3 colours found/.test(document.getElementById('inspHint').textContent),
       document.getElementById('inspHint').textContent);

    const outEl = document.getElementById('inspOut');
    const copyEl = document.getElementById('inspCopy');
    ok('nothing is picked to begin with', copyEl.disabled, '');
    ok('the copy button says what it copies', copyEl.textContent === 'copy hex', copyEl.textContent);

    // pick the third, then the first — the output should still read top-down
    swatches[2].click();
    swatches[0].click();
    await tick(10);
    ok('picking marks the swatch', swatches[2].classList.contains('picked'), '');
    ok('picked colours come out in palette order, not tap order',
       outEl.textContent === '#1E1E1E\\n#C46A6A', JSON.stringify(outEl.textContent));
    ok('copy is now available', !copyEl.disabled, '');
    ok('the hint counts the selection', /2 of 3 selected/.test(document.getElementById('inspHint').textContent),
       document.getElementById('inspHint').textContent);

    swatches[2].click();
    await tick(10);
    ok('tapping again unpicks', outEl.textContent === '#1E1E1E', JSON.stringify(outEl.textContent));

    copyEl.click();
    await tick(10);
    ok('copying writes the hex to the clipboard',
       written.length === 1 && written[0].content === '#1E1E1E', JSON.stringify(written));

    document.getElementById('inspPrompt').click();
    await tick(10);
    ok('a palette can be kept as a prompt',
       promptsCreated.length === 1 && promptsCreated[0] === '#1E1E1E', JSON.stringify(promptsCreated));

    // and the panel has to go back to being the text one afterwards
    document.getElementById('inspClose').click();
    await tick(10);
    ok('closing hides it', !insp.classList.contains('show'), '');
    ok('closing clears the swatches', document.querySelectorAll('.swatch').length === 0, '');

    imgRow.querySelector('[data-act=\\"ocr\\"]').click();
    await tick(60);
    ok('text still opens as text after a colour run', insp.dataset.mode === 'text', insp.dataset.mode);
    ok('and draws regions, not swatches',
       document.querySelectorAll('.region').length === 1 && document.querySelectorAll('.swatch').length === 0,
       document.querySelectorAll('.region').length + ' regions');
    ok('the copy button goes back to text', document.getElementById('inspCopy').textContent === 'copy text',
       document.getElementById('inspCopy').textContent);

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

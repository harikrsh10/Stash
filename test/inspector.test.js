// Part 1: the clustering pipeline from the real main.js, on synthetic geometry
// Part 2: the real renderer driven through the extracted-text sheet
const { app, BrowserWindow } = require('electron');
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
vm.runInContext([grab('wordsFrom'), grab('runsFromWords'), grab('clusterLines')].join('\n')
  + '\nthis.api={wordsFrom,runsFromWords,clusterLines};', ctx);

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// a word as the OS engines report it. `line` is the engine's own line grouping;
// -1 means the engine didn't say, which exercises the geometry fallback.
const W = (text, x0, y0, x1, y1, line = -1) => ({ text, line, x0, y0, x1, y1 });
const wrap = (words) => ({ words });

// two stat cards side by side, each label/value/note stacked
const cards = wrap([
  W('Total', 20, 100, 70, 115), W('Sales', 74, 100, 124, 115),
  W('48210', 20, 130, 110, 160),
  W('up', 20, 172, 36, 186), W('12%', 40, 172, 70, 186),
  W('New', 300, 100, 340, 115), W('Users', 344, 100, 396, 115),
  W('1394', 300, 130, 372, 160),
  W('down', 300, 172, 344, 186), W('3%', 348, 172, 372, 186),
]);
const blocks = ctx.api.clusterLines(ctx.api.runsFromWords(ctx.api.wordsFrom(cards)));
ok('side-by-side cards become separate blocks', blocks.length === 2, blocks.length + ' blocks');
ok('first card keeps its three lines together',
   blocks[0] && blocks[0].text === 'Total Sales\n48210\nup 12%', JSON.stringify(blocks[0] && blocks[0].text));
ok('second card is intact and separate',
   blocks[1] && blocks[1].text === 'New Users\n1394\ndown 3%', JSON.stringify(blocks[1] && blocks[1].text));

// a wide gap on one visual line is a column break, not a space
const row = wrap([W('Overview', 20, 20, 100, 34), W('Reports', 200, 20, 268, 34), W('Settings', 380, 20, 452, 34)]);
const navBlocks = ctx.api.clusterLines(ctx.api.runsFromWords(ctx.api.wordsFrom(row)));
ok('a spaced-out nav row splits into separate blocks', navBlocks.length === 3, navBlocks.length + '');

// ordinary word spacing must NOT split
const sentence = wrap([W('the', 20, 20, 48, 34), W('quick', 54, 20, 100, 34), W('brown', 106, 20, 160, 34)]);
const sentenceBlocks = ctx.api.clusterLines(ctx.api.runsFromWords(ctx.api.wordsFrom(sentence)));
ok('normal spacing stays one block', sentenceBlocks.length === 1 && sentenceBlocks[0].text === 'the quick brown',
   JSON.stringify(sentenceBlocks.map(b => b.text)));

// a paragraph of body copy groups into one block
const para = wrap([
  W('This', 20, 300, 56, 314), W('report', 60, 300, 110, 314),
  W('covers', 20, 320, 72, 334), W('everything', 76, 320, 160, 334),
  W('issued', 20, 340, 64, 354), W('later', 68, 340, 104, 354),
]);
const paraBlocks = ctx.api.clusterLines(ctx.api.runsFromWords(ctx.api.wordsFrom(para)));
ok('a paragraph stays one block', paraBlocks.length === 1, paraBlocks.length + '');
ok('paragraph keeps its line breaks', paraBlocks[0].lineCount === 3, paraBlocks[0].lineCount + '');

// the engine's own line grouping wins over geometry: heavily letter-spaced
// capitals have word gaps as wide as their glyphs, and guessing splits them
const tracked = wrap([
  W('SUPPORT', 20, 100, 90, 114, 0), W('YOUR', 112, 100, 160, 114, 0),
  W('GROWTH', 182, 100, 250, 114, 0), W('EVERY', 272, 100, 330, 114, 0),
]);
const trackedBlocks = ctx.api.clusterLines(ctx.api.runsFromWords(ctx.api.wordsFrom(tracked)));
ok('letter-spaced words on one engine line stay together',
   trackedBlocks.length === 1 && trackedBlocks[0].text === 'SUPPORT YOUR GROWTH EVERY',
   JSON.stringify(trackedBlocks.map(b => b.text)));

// but a genuine column break still splits, even inside one engine line
const columns = wrap([
  W('Total', 20, 100, 70, 114, 0), W('Sales', 74, 100, 124, 114, 0),
  W('New', 600, 100, 640, 114, 0), W('Users', 644, 100, 696, 114, 0),
]);
const columnBlocks = ctx.api.clusterLines(ctx.api.runsFromWords(ctx.api.wordsFrom(columns)));
ok('a wide column gap splits an engine line', columnBlocks.length === 2,
   JSON.stringify(columnBlocks.map(b => b.text)));

// mixed type sizes: a 70px headline and a 12px caption in one image
const mixed = wrap([
  W('HEADLINE', 20, 20, 300, 90), W('HERE', 320, 20, 470, 90),
  W('tiny', 20, 400, 44, 412), W('caption', 48, 400, 92, 412),
]);
const mixedBlocks = ctx.api.clusterLines(ctx.api.runsFromWords(ctx.api.wordsFrom(mixed)));
ok('big and small text on one image both group correctly',
   mixedBlocks.length === 2 && mixedBlocks[0].text === 'HEADLINE HERE'
   && mixedBlocks[1].text === 'tiny caption', JSON.stringify(mixedBlocks.map(b => b.text)));

// junk handling
ok('malformed boxes are dropped',
   ctx.api.wordsFrom(wrap([W('ok', 0, 0, 10, 10), W('bad', 10, 10, 5, 5)])).length === 1, '');
ok('empty words are dropped', ctx.api.wordsFrom(wrap([W('  ', 0, 0, 10, 10)])).length === 0, '');
ok('no words yields no blocks', ctx.api.clusterLines(ctx.api.runsFromWords([])).length === 0, '');
ok('blocks carry a bbox', !!(blocks[0] && blocks[0].bbox && typeof blocks[0].bbox.x0 === 'number'), '');
ok('blocks are ordered top to bottom', navBlocks[0].text === 'Overview', navBlocks[0].text);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 340, height: 900, show: false });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
    let ocrCalledWith = null, written = [], expandCalls = [], promptsCreated = [];
    // a 4x4 red png, so the image actually loads and has natural dimensions
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
    // The displayed png is 4x4 but OCR reports an 8x8 image, mimicking the real
    // mismatch between the drawer's 240px preview and the full-size file. Boxes
    // must scale against the OCR size; using the element's natural size would
    // double every percentage and throw them off the picture.
    let respond = { ok: true, imageUrl: PNG, width: 8, height: 8, blocks: [
      { id: 'b0', text: 'Total Sales\\n48210', lineCount: 2, bbox: { x0: 0, y0: 0, x1: 4, y1: 4 } },
      { id: 'b1', text: 'New Users\\n1394', lineCount: 2, bbox: { x0: 4, y0: 4, x1: 8, y1: 8 } },
    ] };
    window.api = {
      write: async (e) => { written.push(e); }, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      updatePrompt: async () => true,
      ocr: async (id) => { ocrCalledWith = id; await tick(10); return respond; },
      expandWindow: async (v) => { expandCalls.push(v); },
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
    ok('every row can be opened', !!imgRow.querySelector('[data-act=\\"name\\"]')
       && !!txtRow.querySelector('[data-act=\\"name\\"]'), '');
    // Extraction moved into the preview panel — you press it beside the image
    // rather than on a row where you cannot see what you are extracting from.
    const extract = async (what) => {
      imgRow.querySelector('[data-act=\\"name\\"]').click();
      await tick(60);
      document.getElementById(what).click();
    };


    const sheet = document.getElementById('ocrSheet');
    ok('sheet starts hidden', !sheet.classList.contains('show'), '');

    const insp = document.getElementById('inspector');
    ok('inspector starts hidden', !insp.classList.contains('show'), '');
    await extract('detailText');
    ok('progress sheet opens immediately', sheet.classList.contains('show'), '');
    ok('shows progress while working', !!document.querySelector('.ocr-status'), '');
    await tick(120);
    ok('ocr called with the clip id', ocrCalledWith === 'img1', String(ocrCalledWith));

    // the panel opens beside the drawer and the window is widened for it
    ok('inspector opens on success', insp.classList.contains('show'), '');
    ok('progress sheet steps aside', !sheet.classList.contains('show'), '');
    ok('window was expanded', expandCalls[0] === true, JSON.stringify(expandCalls));
    ok('the image is shown', !!document.querySelector('#inspStage img'), '');

    // one clickable region per block, positioned from its bbox
    const regions = () => [...document.querySelectorAll('.region')];
    ok('one region per block', regions().length === 2, regions().length + '');
    // positions must be resolution-independent percentages of the image, so a
    // box lands on its text no matter how the picture is scaled to fit
    const s0 = regions()[0].style;
    ok('regions sized as percentages, not measured pixels',
       s0.width.endsWith('%') && s0.height.endsWith('%'), s0.width + ' x ' + s0.height);
    ok('boxes scale against the OCR image size, not the displayed one',
       s0.left === '0%' && s0.width === '50%' && s0.height === '50%',
       'left ' + s0.left + ', ' + s0.width + ' x ' + s0.height + ' (100% here would mean it used naturalWidth)');
    ok('the second box is offset to its own corner',
       regions()[1].style.left === '50%' && regions()[1].style.top === '50%',
       regions()[1].style.left + ', ' + regions()[1].style.top);
    ok('region carries its text as a tooltip', regions()[0].title === 'Total Sales\\n48210', regions()[0].title);
    const blocks = () => [...document.querySelectorAll('.out-block')];
    const blockText = () => blocks().map(b => b.querySelector('.out-block-text').textContent);
    ok('output starts empty', document.getElementById('inspOut').classList.contains('empty'), '');
    ok('with nothing to act on', blocks().length === 0, String(blocks().length));

    // Each region you pick becomes a row of its own carrying its own actions,
    // rather than being folded into one blob with a shared pair of buttons.
    regions()[1].click();
    ok('clicking a region marks it', regions()[1].classList.contains('picked'), '');
    ok('the picked text becomes a block',
       blockText().join('|') === 'New Users\\n1394', JSON.stringify(blockText()));
    ok('the block carries its own two actions',
       blocks()[0].querySelectorAll('.out-act').length === 2,
       String(blocks()[0].querySelectorAll('.out-act').length));

    regions()[0].click();
    ok('a second selection is added in visual order',
       blockText().join('|') === 'Total Sales\\n48210|New Users\\n1394',
       JSON.stringify(blockText()));
    ok('hint reflects the count', document.getElementById('inspHint').textContent === '2 of 2 selected',
       document.getElementById('inspHint').textContent);

    regions()[0].click();
    ok('clicking again deselects', !regions()[0].classList.contains('picked')
       && blockText().join('|') === 'New Users\\n1394', JSON.stringify(blockText()));

    // the two actions, now belonging to the block rather than the panel
    blocks()[0].querySelectorAll('.out-act')[0].click();
    await tick(10);
    ok('copy writes only that block',
       written.length === 1 && written[0].content === 'New Users\\n1394', JSON.stringify(written));
    blocks()[0].querySelectorAll('.out-act')[1].click();
    await tick(10);
    ok('add to prompts sends that block',
       promptsCreated.length === 1 && promptsCreated[0] === 'New Users\\n1394', JSON.stringify(promptsCreated));

    // escape closes the inspector and shrinks the window back
    let hidden = false; window.api.hide = () => { hidden = true; };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok('esc closes the inspector first', !insp.classList.contains('show') && !hidden, 'hidden=' + hidden);
    ok('window collapsed again', expandCalls[expandCalls.length - 1] === false, JSON.stringify(expandCalls));
    ok('regions cleared out', document.querySelectorAll('.region').length === 0, '');

    // hiding the drawer must also collapse it
    respond = { ok: true, imageUrl: PNG, width: 8, height: 8, blocks: [{ text: 'x', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] };
    await extract('detailText');
    await tick(120);
    ok('inspector open again', insp.classList.contains('show'), '');
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    ok('hiding the drawer collapses the window', !insp.classList.contains('show')
       && expandCalls[expandCalls.length - 1] === false, JSON.stringify(expandCalls));
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });

    // empty result
    respond = { ok: true, imageUrl: PNG, width: 8, height: 8, blocks: [] };
    await extract('detailText');
    await tick(120);
    ok('empty result still opens the panel and says so',
       insp.classList.contains('show') && document.getElementById('inspHint').textContent === 'no text found',
       document.getElementById('inspHint').textContent);
    closeInspector();

    // failure path
    respond = { ok: false, error: 'that image is no longer on disk' };
    await extract('detailText');
    await tick(120);
    ok('errors are surfaced, not silent',
       document.querySelector('.ocr-empty').textContent.includes('no longer on disk'),
       document.querySelector('.ocr-empty').textContent);
    ok('a failure leaves the picture up rather than closing on you',
       insp.classList.contains('show') && insp.dataset.mode === 'detail', insp.dataset.mode);

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


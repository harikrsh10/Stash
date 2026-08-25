// Recognising the things designers copy: a Figma frame, which lives in the
// HTML flavour and is useless if it does not go back to Figma unchanged, and
// SVG, which is text but is a picture.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const { sniffAsset, looksLikeFigma, looksLikeSvg, extensionFor, htmlCapFor,
        DESIGN_HTML_MAX } = require('../src/design-assets');

const checks = [];
const ok = (name, pass, detail = '') => checks.push([name, pass, detail]);

// What Figma actually puts on the clipboard: a span carrying a base64 blob,
// with comment markers its own paste handler looks for.
const FIGMA_HTML = '<meta charset="utf-8"><span data-metadata="<!--(figmeta)eyJmaWxlS2V5IjoiYWJjIn0=(/figmeta)-->"'
  + ' data-buffer="<!--(figma)ZmlnbWEtY2xpcGJvYXJkLWRhdGE=(/figma)-->"></span>';

// ---------- Figma ----------
ok('a figma payload is recognised', looksLikeFigma(FIGMA_HTML), '');
ok('by its buffer attribute', looksLikeFigma('<span data-buffer="x"></span>'), '');
ok('and by its comment marker', looksLikeFigma('<!--(figma)abc(/figma)-->'), '');
ok('ordinary styled text is not a figma frame',
   !looksLikeFigma('<p style="font-weight:bold">hello</p>'), '');
ok('and neither is nothing', !looksLikeFigma(''), '');
ok('a page that merely says the word figma is not a frame',
   !looksLikeFigma('<p>I use Figma every day</p>'), '');

// ---------- the cap, which is the whole point ----------
// Word puts hundreds of kilobytes of scaffolding around a paragraph, so styled
// text is capped. A Figma frame *is* its payload, and the same cap silently
// turned a frame into the word "Frame".
const ORDINARY = 256 * 1024;
ok('ordinary html keeps the small cap',
   htmlCapFor('<p>hello</p>', ORDINARY) === ORDINARY, String(htmlCapFor('<p>x</p>', ORDINARY)));
ok('a figma payload gets room to survive',
   htmlCapFor(FIGMA_HTML, ORDINARY) === DESIGN_HTML_MAX, String(htmlCapFor(FIGMA_HTML, ORDINARY)));
ok('and a big one is under that ceiling rather than over it',
   1024 * 1024 < DESIGN_HTML_MAX, String(DESIGN_HTML_MAX));
// the ceiling is still a ceiling: one copy must not be able to fill the store
ok('but the room is bounded', DESIGN_HTML_MAX < 64 * 1024 * 1024, String(DESIGN_HTML_MAX));

// a frame bigger than the old cap would have been dropped; now it is kept
const bigFrame = FIGMA_HTML + 'A'.repeat(400 * 1024);
ok('a frame past the old cap would have been thrown away',
   bigFrame.length > ORDINARY, String(bigFrame.length));
ok('and is now kept', bigFrame.length <= htmlCapFor(bigFrame, ORDINARY), '');

// ---------- SVG ----------
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
ok('svg source is recognised', looksLikeSvg(SVG), '');
ok('with an xml prolog in front',
   looksLikeSvg('<?xml version="1.0"?>\n' + SVG), '');
ok('and with a comment in front',
   looksLikeSvg('<!-- made by hand -->\n' + SVG), '');
ok('with whitespace around it', looksLikeSvg('\n\n  ' + SVG + '  \n'), '');
ok('an unclosed fragment is not svg',
   !looksLikeSvg('<svg viewBox="0 0 10 10"><rect/>'), '');
ok('a document that merely mentions svg is not svg',
   !looksLikeSvg('I exported it as an <svg> and it broke'), '');
ok('html containing an svg somewhere is not svg source',
   !looksLikeSvg('<div><svg viewBox="0 0 1 1"></svg></div>'), '');
ok('and prose is not svg', !looksLikeSvg('the nav spacing feels tight'), '');
ok('nothing is not svg', !looksLikeSvg(''), '');

// ---------- which one wins ----------
ok('a figma frame is a figma frame', sniffAsset('Frame 12', FIGMA_HTML) === 'figma', '');
ok('svg on the clipboard as text is svg', sniffAsset(SVG, '') === 'svg', '');
ok('ordinary text is neither', sniffAsset('hello', '<p>hello</p>') === null, '');
// Figma copies carry a text flavour too; the HTML is what makes it a frame
ok('a frame whose text happens to be svg-ish is still a frame',
   sniffAsset(SVG, FIGMA_HTML) === 'figma', '');

// ---------- how it leaves ----------
ok('svg drags out as .svg', extensionFor('svg') === '.svg', extensionFor('svg'));
ok('anything else drags out as .txt', extensionFor(null) === '.txt', extensionFor(null));
ok('including a figma frame, whose use is the clipboard rather than a file',
   extensionFor('figma') === '.txt', extensionFor('figma'));

// ---------- the real materializeForDrag, from main.js ----------
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const fn = MAIN.match(/function materializeForDrag[\s\S]*?\n\}/);
if (!fn) { console.log('FAIL: could not find materializeForDrag in main.js'); process.exit(1); }
const TMP_DIR = path.join(os.tmpdir(), 'stash-design-test');
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
const ctx = { fs, path, TMP_DIR, console, extensionFor };
vm.createContext(ctx);
vm.runInContext(fn[0] + '\nthis.materializeForDrag = materializeForDrag;', ctx);

const svgFile = ctx.materializeForDrag({ type: 'code', content: SVG, asset: 'svg' }, 0);
ok('an svg clip is written to a real .svg file', svgFile.endsWith('.svg'), svgFile);
ok('with the source intact', fs.readFileSync(svgFile, 'utf8') === SVG, '');

const textFile = ctx.materializeForDrag({ type: 'text', content: 'just words' }, 1);
ok('a text clip is still a .txt', textFile.endsWith('.txt'), textFile);

// ---------- dragging a frame ----------
// A frame is not a file and cannot be made into one: its payload is a clipboard
// flavour only Figma's paste handler reads. Dragging one used to write a .txt of
// the frame's *text*, and the first anyone heard about it was Figma refusing to
// import it. The drag now does what the gesture meant instead.
const dragHandler = MAIN.match(/ipcMain\.on\('ondragstart',[\s\S]*?\n\}\);/);
ok('the single-clip drag handler is still findable', !!dragHandler, '');
if (dragHandler) {
  const wrote = [];
  const sent = [];
  const dctx = {
    fs, path, TMP_DIR, console, extensionFor,
    process: { platform: 'darwin' },
    writeClip: (entry, plain) => wrote.push({ id: entry.id, plain }),
    materializeForDrag: () => { throw new Error('a frame must not be made into a file'); },
    dragIcon: () => ({}),
    mainWindow: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
    ipcMain: { on: (_name, fn) => { dctx.handler = fn; } },
  };
  vm.createContext(dctx);
  vm.runInContext(dragHandler[0], dctx);

  const dragged = [];
  const event = { sender: { startDrag: (o) => dragged.push(o) } };
  dctx.handler(event, { id: 'frame1', type: 'text', content: 'Frame 12', asset: 'figma' });

  ok('dragging a frame does not start a file drag', dragged.length === 0,
     JSON.stringify(dragged));
  ok('it puts the frame back on the clipboard instead',
     wrote.length === 1 && wrote[0].id === 'frame1', JSON.stringify(wrote));
  ok('with its formatting, which is where the frame lives',
     wrote[0] && wrote[0].plain === false, JSON.stringify(wrote[0]));
  ok('and the drawer is told to say so',
     sent.length === 1 && sent[0][0] === 'clip:pasteInstead', JSON.stringify(sent));
  ok('naming the key that finishes the job',
     sent[0] && sent[0][1] && sent[0][1].key === '⌘V', JSON.stringify(sent[0] && sent[0][1]));

  // everything else still drags as a file
  dctx.materializeForDrag = (e) => path.join(TMP_DIR, 'x.txt');
  dctx.handler(event, { id: 'plain1', type: 'text', content: 'just words' });
  ok('an ordinary clip still drags out as a file', dragged.length === 1,
     JSON.stringify(dragged.length));
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

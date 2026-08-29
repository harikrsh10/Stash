// Recognising the things designers copy: a Figma frame, which lives in the
// HTML flavour and is useless if it does not go back to Figma unchanged, and
// SVG, which is text but is a picture.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const { sniffAsset, looksLikeFigma, looksLikePaper, looksLikeScene, paperScene,
        looksLikeSvg, extensionFor, htmlCapFor,
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

// ---------- Paper ----------
// The shape below is what Paper actually put on a clipboard, trimmed. It is
// here because the first version of this file knew only about Figma: copying
// out of Paper produced a row headlined "Node IDs: 4QE-0" and nothing else,
// and no amount of reasoning about Figma would have found that.
const PAPER_HTML = '<meta charset="utf-8"><!--<paper-paste-start data-embed="'
  + JSON.stringify({
      id: '01M129KCDSX16K5FKB86X1B4BT',
      fileId: '01M08FJ7WP16MN9H7ZCCD65NNH',
      topLevelNodeIds: ['temp_0'],
      nodes: { temp_0: { id: 'temp_0', label: 'Rectangle', component: 'Rectangle',
                         styles: { width: 512, height: 512, left: 5929, top: 7114 } } },
    })
  + '"></paper-paste-start>--><span style="white-space:pre-wrap;">Node IDs: 4QA-0</span>';

ok('a paper payload is recognised', looksLikePaper(PAPER_HTML), '');
ok('and counts as a scene, so it gets the bigger ceiling',
   looksLikeScene(PAPER_HTML) && htmlCapFor(PAPER_HTML, 256 * 1024) === DESIGN_HTML_MAX, '');
ok('it is not mistaken for figma', !looksLikeFigma(PAPER_HTML), '');
ok('and sniffs as paper', sniffAsset('Node IDs: 4QA-0', PAPER_HTML) === 'paper',
   String(sniffAsset('Node IDs: 4QA-0', PAPER_HTML)));

const scene = paperScene(PAPER_HTML);
ok('the layer name is read out of the payload', scene && scene.name === 'Rectangle',
   JSON.stringify(scene));
ok('and its size', scene && scene.size === '512×512', JSON.stringify(scene));
ok('which is what the row shows instead of "Node IDs: 4QA-0"',
   scene && scene.name !== 'Node IDs: 4QA-0', '');
ok('a payload that will not parse gives nothing rather than throwing',
   paperScene('<!--<paper-paste-start data-embed="{not json}"></paper-paste-start>-->') === null, '');
ok('and so does html that is not paper at all', paperScene('<p>hello</p>') === null, '');

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

  // a Paper selection is the same story with a different tool named
  sent.length = 0; wrote.length = 0;
  dctx.handler(event, { id: 'p1', type: 'text', content: 'Node IDs: 4QA-0', asset: 'paper' });
  ok('dragging a paper selection does not write a file either', dragged.length === 0,
     JSON.stringify(dragged.length));
  ok('and the toast names Paper rather than Figma',
     sent[0] && sent[0][1] && sent[0][1].tool === 'Paper',
     JSON.stringify(sent[0] && sent[0][1]));

  // everything else still drags as a file
  dctx.materializeForDrag = (e) => path.join(TMP_DIR, 'x.txt');
  dctx.handler(event, { id: 'plain1', type: 'text', content: 'just words' });
  ok('an ordinary clip still drags out as a file', dragged.length === 1,
     JSON.stringify(dragged.length));
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });

// ---------- one copy arriving in pieces ----------
// Reported from a real desk: one Figma frame became three rows, all stamped the
// same second, and the same prompt became two. Apps do not always fill the
// clipboard in one go -- the text lands, the HTML follows -- and because the
// signature covers every flavour, each stage looked like a fresh copy.
const coalesceFn = MAIN.match(/function coalesceRecent[\s\S]*?\n\}/);
ok('the coalescing step is findable', !!coalesceFn, '');
if (coalesceFn) {
  const cctx = { console, history: [], historyStore: { add() {} } };
  vm.createContext(cctx);
  vm.runInContext(MAIN.match(/const COALESCE_MS = \d+;/)[0] + '\n' + coalesceFn[0]
    + '\nthis.coalesceRecent = coalesceRecent;', cctx);

  const now = Date.now();
  cctx.history = [{ id: 'a', type: 'text', content: 'Frame 12', ts: now - 200 }];
  const up = cctx.coalesceRecent('Frame 12', { html: '<span data-buffer="x"></span>' }, 'figma');
  ok('the same text moments later upgrades the clip', up === cctx.history[0], String(!!up));
  ok('rather than making a second one', cctx.history.length === 1, cctx.history.length + '');
  ok('and the richer flavour is the one kept',
     cctx.history[0].html === '<span data-buffer="x"></span>', String(cctx.history[0].html));
  ok('and it is now known to be a frame', cctx.history[0].asset === 'figma', String(cctx.history[0].asset));

  // the fuller version wins, not merely the latest
  cctx.history = [{ id: 'a', type: 'text', content: 'x', html: '<b>a fuller one</b>', ts: Date.now() }];
  cctx.coalesceRecent('x', { html: '<b>t</b>' }, null);
  ok('a thinner later flavour does not overwrite a fuller one',
     cctx.history[0].html === '<b>a fuller one</b>', cctx.history[0].html);

  // a genuinely separate copy, later, is its own clip
  cctx.history = [{ id: 'a', type: 'text', content: 'Frame 12', ts: Date.now() - 60000 }];
  ok('the same text a minute later is a new copy, not an upgrade',
     cctx.coalesceRecent('Frame 12', {}, null) === null, '');

  // different text is never coalesced
  cctx.history = [{ id: 'a', type: 'text', content: 'Frame 12', ts: Date.now() }];
  ok('different text is left alone', cctx.coalesceRecent('Frame 13', {}, null) === null, '');

  // an image clip is never absorbed into a text one
  cctx.history = [{ id: 'i', type: 'img', content: 'shot.png', ts: Date.now() }];
  ok('a picture is not upgraded by text that happens to match',
     cctx.coalesceRecent('shot.png', {}, null) === null, '');
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

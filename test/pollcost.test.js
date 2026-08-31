// What the clipboard poll does when nothing has changed.
//
// It used to encode the image to PNG and hash it before it could tell whether
// anything was different -- every 600ms, for as long as the image sat on the
// clipboard. An image stays there until something replaces it, so that was not
// a cost per copy but a permanent one: 336ms per poll for a 4K screenshot,
// which is 56% of a core, indefinitely, while nobody is doing anything. It is
// the likeliest thing behind "Stash is eating my CPU", and it is worst for the
// people this is built for -- a designer copying Retina screenshots and Figma
// frames always has a big image sitting there.
//
// So the guarantee this file exists to hold: an unchanged clipboard costs no
// encode at all, and a changed one is still noticed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

function lift(opening) {
  const at = MAIN.indexOf(opening);
  if (at === -1) throw new Error('could not find ' + opening + ' in main.js');
  const rest = MAIN.slice(at);
  const first = rest.slice(0, rest.indexOf('\n'));
  if (first.trimEnd().endsWith(';')) return first;
  const m = rest.match(/\n(\}|\];|\};)/);
  return rest.slice(0, m.index + m[0].length);
}

// A clipboard holding one image, and an image that counts what is asked of it.
function fakeWorld(pixels) {
  const counts = { toPNG: 0, resize: 0, readImage: 0 };
  let current = pixels;

  const makeImage = (data) => ({
    isEmpty: () => false,
    getSize: () => ({ width: 3840, height: 2160 }),
    toPNG() { counts.toPNG++; return Buffer.from('png:' + data); },
    resize() {
      counts.resize++;
      // a thumbnail of different pixels is different; of the same, the same
      return { toPNG: () => Buffer.from('thumb:' + data) };
    },
  });

  const clipboard = {
    availableFormats: () => ['image/png'],
    readImage() { counts.readImage++; return makeImage(current); },
    readText: () => '',
    readHTML: () => '',
    readRTF: () => '',
  };
  return { clipboard, counts, copy(next) { current = next; } };
}

function run(world) {
  const ctx = {
    clipboard: world.clipboard,
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Buffer,
    hash: (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 16),
    lastFormatsKey: '', lastSig: '', clipboardLog: [], assetLog: [],
    isPaused: false,
    rememberPausedClipboard() {}, shouldIgnorePausedClipboard: () => false,
    clipboardIsBusy() {},
    readStyled: () => ({ html: '', rtf: '' }),
    sniffAsset: () => null,
    looksSecret: () => false,
    ingested: 0,
  };
  ctx.ingestImage = () => { ctx.ingested++; return 'img:new'; };
  vm.createContext(ctx);
  vm.runInContext(
    lift('let lastImageFingerprint') + '\n'
    + lift('function imageFingerprint(') + '\n'
    + lift('function pollClipboard(')
    + '\nthis.poll = pollClipboard;', ctx);
  return ctx;
}

// ---------- an unchanged clipboard ----------
{
  const world = fakeWorld('screenshot-a');
  const ctx = run(world);

  ctx.poll();
  const afterFirst = { ...world.counts, ingested: ctx.ingested };
  ok('the first sight of an image encodes it', afterFirst.toPNG >= 1, JSON.stringify(afterFirst));
  ok('and keeps it', afterFirst.ingested === 1, String(afterFirst.ingested));

  const encodesBefore = world.counts.toPNG;
  for (let i = 0; i < 20; i++) ctx.poll();
  const encodedSince = world.counts.toPNG - encodesBefore;

  // The thumbnail is an encode too, so it is counted separately from the one
  // that matters: the full-size image.
  ok('twenty more polls of the same image do not encode it again',
     encodedSince === 0, encodedSince + ' full encodes across 20 polls');
  ok('and nothing new was kept', ctx.ingested === 1, String(ctx.ingested));
  ok('but it did keep looking, rather than going blind',
     world.counts.resize >= 20, world.counts.resize + ' fingerprints taken');
}

// ---------- a clipboard that changes ----------
{
  const world = fakeWorld('screenshot-a');
  const ctx = run(world);
  ctx.poll();
  for (let i = 0; i < 5; i++) ctx.poll();
  ok('one image, one clip', ctx.ingested === 1, String(ctx.ingested));

  world.copy('screenshot-b');
  ctx.poll();
  ok('a different image is noticed', ctx.ingested === 2, String(ctx.ingested));

  for (let i = 0; i < 5; i++) ctx.poll();
  ok('and then settles again', ctx.ingested === 2, String(ctx.ingested));
}

// ---------- the shape of the fix, so it cannot quietly regress ----------
const poll = lift('function pollClipboard(');
const fpAt = poll.indexOf('imageFingerprint(');
const pngAt = poll.indexOf('img.toPNG()');
ok('the cheap check comes before the expensive one',
   fpAt !== -1 && pngAt !== -1 && fpAt < pngAt, `fingerprint at ${fpAt}, encode at ${pngAt}`);
ok('and the poll returns early when nothing changed',
   /if \(fp === lastImageFingerprint\) return;/.test(poll), '');

// The other half: not polling as hard when nothing is happening.
ok('polling slows down when the clipboard has been quiet',
   MAIN.includes('POLL_IDLE_INTERVAL') && MAIN.includes('POLL_CALM_AFTER_MS'), '');
ok('and goes back to full speed the moment something happens',
   /function clipboardIsBusy\(\)[\s\S]{0,200}startPolling\(POLL_INTERVAL\)/.test(MAIN), '');
// Latency is given back where it would otherwise be noticed.
ok('opening the drawer catches up immediately',
   /on\('show'[\s\S]{0,120}pollClipboard\(\)/.test(MAIN), '');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

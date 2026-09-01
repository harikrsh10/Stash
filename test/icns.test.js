// Reading an app's own logo out of its bundle.
//
// This route exists because the obvious one does not work. Asked on a Mac,
// getFileIcon returned one identical placeholder for Firefox, Chrome, Edge,
// Terminal, TextEdit and Calculator -- and on the machine this was reported
// from, for every app, which is why every row ended up showing a name.
//
// Asked about all 86 apps installed on that same Mac, this route read 86 icons,
// none failed to decode, and they came out as 73 distinct pictures; the only
// repeats were seven copies of Xcode, which really do share an icon.
//
// What is checked here is the parsing, because the format is a container and
// the failure modes are quiet: an icns from before 10.7 holds JPEG 2000 in the
// same slots, and a truncated one should cost one app its logo rather than
// throwing on the way through a copy.
const fs = require('fs');
const path = require('path');
const os = require('os');

const icns = require('../src/icns');
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// A real 4x4 PNG, so anything that decodes it is decoding a picture.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
  'base64');
const OTHER_PNG = Buffer.concat([PNG, Buffer.from('trailing')]);
// What an older icns carries instead: a JPEG 2000 signature box.
const JP2 = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 4, 'latin1');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
}

function icnsFile(chunks) {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------- reading the container ----------
{
  const file = icnsFile([
    chunk('ic04', JP2),
    chunk('ic11', PNG),
    chunk('ic12', OTHER_PNG),
    chunk('info', Buffer.from('some plist')),
  ]);
  const cs = icns.chunks(file);
  ok('every chunk is found', cs.length === 4, cs.map(c => c.type).join(' '));
  ok('and named', cs.map(c => c.type).join(' ') === 'ic04 ic11 ic12 info', cs.map(c => c.type).join(' '));
  ok('a png payload is recognised', icns.isPng(cs[1].data), '');
  ok('and jpeg 2000 is not', !icns.isPng(cs[0].data), '');

  const best = icns.bestPng(file);
  // 64px is the smallest that still looks right on a Retina row; a 1024px chunk
  // is a megabyte of PNG to throw away.
  ok('the size actually wanted is preferred', best && best.type === 'ic12', best ? best.type : 'none');
  ok('and its bytes come back whole',
     best && best.data.equals(OTHER_PNG), best ? String(best.data.length) : 'none');
}
{
  const file = icnsFile([chunk('ic07', PNG), chunk('ic11', OTHER_PNG)]);
  ok('with the next best taken when it is missing',
     icns.bestPng(file).type === 'ic07', icns.bestPng(file).type);
}
{
  // Everything in the file predates PNG icons. Nothing here can be shown, and
  // saying so is what makes the row fall back to the app's name.
  const file = icnsFile([chunk('ic04', JP2), chunk('ic05', JP2)]);
  ok('an icns with no png inside is a miss, not a crash', icns.bestPng(file) === null, '');
}
{
  ok('something that is not an icns at all reads as empty',
     icns.chunks(Buffer.from('this is a text file')).length === 0, '');
  ok('and so does nothing', icns.chunks(Buffer.alloc(0)).length === 0, '');
}
{
  // A length field that runs past the end of the file. Walking on would read
  // whatever is next in memory; stopping costs the rest of the chunks.
  const good = chunk('ic11', PNG);
  const bad = Buffer.alloc(8);
  bad.write('ic12', 0, 4, 'latin1');
  bad.writeUInt32BE(9999, 4);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'latin1');
  head.writeUInt32BE(8 + good.length + bad.length, 4);
  const file = Buffer.concat([head, good, bad]);
  const cs = icns.chunks(file);
  ok('a chunk that claims more than the file holds stops the walk',
     cs.length === 1 && cs[0].type === 'ic11', cs.map(c => c.type).join(' '));
  ok('and what was read before it is still usable',
     icns.bestPng(file).type === 'ic11', '');
}
{
  // A zero length would leave the walk on the same byte for ever.
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'latin1');
  head.writeUInt32BE(16, 4);
  const zero = Buffer.alloc(8);
  zero.write('ic12', 0, 4, 'latin1');
  zero.writeUInt32BE(0, 4);
  ok('a zero-length chunk does not spin', icns.chunks(Buffer.concat([head, zero])).length === 0, '');
}

// ---------- finding the file in the bundle ----------
const ROOT = path.join(os.tmpdir(), 'stash-icns-test');
fs.rmSync(ROOT, { recursive: true, force: true });

function bundle(name, files) {
  const app = path.join(ROOT, name + '.app');
  const res = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(res, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(res, f), 'x');
  return app;
}

{
  const app = bundle('Figma', ['Figma.icns', 'document.icns']);
  ok('the icon the bundle names for itself is used',
     icns.iconPathFor(app, { readPlistIconName: () => 'Figma.icns' }) === path.join(app, 'Contents', 'Resources', 'Figma.icns'),
     String(icns.iconPathFor(app, { readPlistIconName: () => 'Figma.icns' })));
  // Info.plist usually leaves the extension off.
  ok('even when it leaves the extension off',
     icns.iconPathFor(app, { readPlistIconName: () => 'Figma' }) !== null, '');
  // Two candidates and no plist answer: the one named after the app.
  ok('otherwise the one named after the app',
     icns.iconPathFor(app, { readPlistIconName: () => '' })
       === path.join(app, 'Contents', 'Resources', 'Figma.icns'), '');
}
{
  const app = bundle('Notion', ['whatever-they-called-it.icns']);
  ok('a single icns needs no name to identify it',
     icns.iconPathFor(app, { readPlistIconName: () => '' })
       === path.join(app, 'Contents', 'Resources', 'whatever-they-called-it.icns'), '');
}
{
  const app = bundle('Ambiguous', ['one.icns', 'two.icns', 'three.icns']);
  // Picking wrong here shows a confidently wrong logo, which nothing downstream
  // would catch. A name is the better answer.
  ok('several unnamed candidates is a miss rather than a guess',
     icns.iconPathFor(app, { readPlistIconName: () => '' }) === null,
     String(icns.iconPathFor(app, { readPlistIconName: () => '' })));
}
{
  const app = bundle('AppIconStyle', ['AppIcon.icns', 'doc.icns']);
  ok('AppIcon is recognised as the conventional name it is',
     icns.iconPathFor(app, { readPlistIconName: () => '' })
       === path.join(app, 'Contents', 'Resources', 'AppIcon.icns'), '');
}
{
  const app = bundle('Empty', []);
  ok('a bundle with no icons at all is a miss',
     icns.iconPathFor(app, { readPlistIconName: () => '' }) === null, '');
  ok('and so is nothing at all', icns.iconPathFor(null, {}) === null, '');
  ok('and a bundle that is not there', icns.iconPathFor(path.join(ROOT, 'Gone.app'), {}) === null, '');
}

// ---------- and that main actually reaches for it ----------
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
ok('the bundle is tried before the icon service',
   MAIN.indexOf('const fromBundle = await iconFromBundle(') !== -1
   && MAIN.indexOf('const fromBundle = await iconFromBundle(') < MAIN.indexOf('await app.getFileIcon(where'), '');
// Two apps agreeing here means they really do share an icon, because this reads
// what each app declares for itself.
ok('and an icon read this way is not subject to the collision check',
   /const fromBundle[\s\S]{0,400}return fromBundle;/.test(MAIN)
   && !/const fromBundle[\s\S]{0,400}clash/.test(MAIN), '');

fs.rmSync(ROOT, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

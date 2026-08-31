// The stores, and what happens to them when things go wrong.
//
// Two bugs lived here, and they compounded. Every store was written with one
// writeFileSync straight over the live file, so a process that died part-way
// through left a truncated file behind. And a store that would not parse was
// reset to empty in memory and then written back over the file by the next
// ordinary save -- so a corrupt library became a deleted one, silently, through
// the app's own normal operation. Reproduced before the fix: three prompts in,
// zero out, nothing said to anyone.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

function lift(name) {
  const at = MAIN.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('could not find ' + name + ' in main.js');
  const rest = MAIN.slice(at);
  return rest.slice(0, rest.indexOf('\n}') + 2);
}

const STORE = path.join(os.tmpdir(), 'stash-durability-test');
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });
const pinnedStorePath = path.join(STORE, 'pinned.json');

function freshContext() {
  const ctx = {
    fs, path, console, pinnedStorePath,
    pinned: [], history: [],
    refreshTrayMenu() {},
    historyStore: { add() {}, remove() {}, clear() {} },
    unreadableStores: new Set(),
    // notifications are the app's business, not this suite's
    Notification: { isSupported: () => false },
    // loadPinned rehydrates previews from the thumbnail cache; that cache has
    // its own suite, and a lifted copy without these throws
    recallThumb() {}, rememberThumb() {}, forgetThumb() {}, thumbDir: null,
  };
  vm.createContext(ctx);
  vm.runInContext([
    lift('writeStoreAtomically'),
    lift('preserveUnreadableStore'),
    lift('loadPinned'),
    lift('savePinned'),
  ].join('\n') + '\nthis.api = { loadPinned, savePinned, writeStoreAtomically };', ctx);
  return ctx;
}

const library = [
  { id: 'p1', type: 'text', isPrompt: true, content: 'act as a staff engineer', tags: ['review'], ts: 1 },
  { id: 'p2', type: 'text', isPrompt: true, content: 'write a changelog', ts: 2 },
  { id: 'k1', type: 'text', content: 'something pinned', ts: 3 },
];

// ---------- the write leaves nothing half-done ----------
{
  const ctx = freshContext();
  const target = path.join(STORE, 'atomic.json');
  ctx.api.writeStoreAtomically(target, JSON.stringify(library));
  ok('an atomic write puts the content where it belongs',
     JSON.parse(fs.readFileSync(target, 'utf8')).length === 3, '');
  // The temp file is the mechanism; leaving one behind after a clean write
  // would mean the rename never happened.
  ok('and leaves no temp file behind it',
     !fs.existsSync(target + '.tmp'), '');

  // Writing over an existing file is the case that matters: the old content
  // must survive right up until the new content is complete.
  ctx.api.writeStoreAtomically(target, JSON.stringify([library[0]]));
  ok('writing over an existing store replaces it wholesale',
     JSON.parse(fs.readFileSync(target, 'utf8')).length === 1, '');
}

// ---------- a store that will not parse ----------
{
  const ctx = freshContext();
  fs.writeFileSync(pinnedStorePath, JSON.stringify(library, null, 2));
  const whole = fs.readFileSync(pinnedStorePath, 'utf8');
  // exactly what a process killed part-way through a full-file write leaves
  fs.writeFileSync(pinnedStorePath, whole.slice(0, Math.floor(whole.length * 0.6)));

  ctx.api.loadPinned();
  ok('a library that cannot be read loads as empty', ctx.pinned.length === 0, '');
  ok('and the app knows it could not be read',
     ctx.unreadableStores.has('library'), [...ctx.unreadableStores].join(','));

  const kept = fs.readdirSync(STORE).filter(f => f.startsWith('pinned.json.unreadable-'));
  ok('the bytes are kept rather than dropped', kept.length === 1, kept.join(','));
  ok('and they are the original bytes, not a rewritten stub',
     fs.readFileSync(path.join(STORE, kept[0]), 'utf8').includes('staff engineer'), '');

  // The heart of it. This save is what used to make the loss permanent.
  ctx.api.savePinned();
  ok('an ordinary save does not write an empty library over it',
     !fs.existsSync(pinnedStorePath), '');
  ok('so the kept bytes are still there afterwards',
     fs.existsSync(path.join(STORE, kept[0])), '');
}

// ---------- and the ordinary path still works ----------
{
  fs.rmSync(pinnedStorePath, { force: true });
  const ctx = freshContext();
  ctx.pinned = library.slice();
  ctx.api.savePinned();
  ok('a healthy library saves normally',
     JSON.parse(fs.readFileSync(pinnedStorePath, 'utf8')).length === 3, '');

  const back = freshContext();
  back.api.loadPinned();
  ok('and loads back intact', back.pinned.length === 3, back.pinned.length + '');
  ok('with nothing marked unreadable', back.unreadableStores.size === 0, '');
}

// ---------- every store, not just this one ----------
// A helper that only one of four call sites uses is not a fix.
for (const store of ['pinnedStorePath', 'sessionStorePath', 'settingsStorePath', 'sourceIconStorePath']) {
  ok(`${store} is written atomically`,
     !new RegExp('fs\\.writeFileSync\\(' + store).test(MAIN)
     && new RegExp('writeStoreAtomically\\(' + store).test(MAIN), '');
}
// and the ones a person made by hand refuse to be written over
for (const [fn, which] of [['savePinned', 'library'], ['saveSessions', 'collections']]) {
  const body = MAIN.slice(MAIN.indexOf('function ' + fn + '('));
  ok(`${fn} refuses to overwrite a store it could not read`,
     body.slice(0, body.indexOf('\n}')).includes(`unreadableStores.has('${which}')`), '');
}

fs.rmSync(STORE, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

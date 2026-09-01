// Preview thumbnails, and why they are not in the stores.
//
// Every image clip carries a 240px preview so a row can draw without decoding
// the full picture. Those previews were being written into the stores as
// base64, and they were the overwhelming majority of what was in them: a real
// sessions.json here was 13.66MB, of which 11.22MB was thumbnails for 177
// clips and 0.78MB was the actual text of 462 clips. All of it parsed at
// startup, and all of it rewritten -- and fsynced -- every time a collection
// changed.
//
// A thumbnail is a cache of a picture already on disk, so it lives in a cache.
// Not rebuilt on load instead: at 25ms each that is four and a half seconds of
// startup for a library that size.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

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

const STORE = path.join(os.tmpdir(), 'stash-thumb-test');
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(path.join(STORE, 'thumbs'), { recursive: true });
const sessionStorePath = path.join(STORE, 'sessions.json');

// a believable preview: 40KB of base64, which is what a 240px PNG comes to
const FAKE_THUMB = 'data:image/png;base64,' + Buffer.alloc(30000, 7).toString('base64');

function context() {
  const ctx = {
    fs, path,
    console: { log() {}, warn() {}, error() {} },
    sessionStorePath,
    sessions: [], sessionClips: [],
    unreadableStores: new Set(),
    Notification: { isSupported: () => false },
    thumbDir: path.join(STORE, 'thumbs'),
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    Buffer, Date, JSON, String,
    thumbsToRebuild: [],
    storeCarriedThumbs: false,
  };
  vm.createContext(ctx);
  vm.runInContext([
    lift('function writeStoreAtomically('),
    lift('function preserveUnreadableStore('),
    lift('function thumbPathFor('),
    lift('function rememberThumb('),
    lift('function forgetThumb('),
    lift('function saveSessions('),
  ].join('\n') + '\nthis.api = { saveSessions, rememberThumb, forgetThumb, thumbPathFor };', ctx);
  return ctx;
}

const clips = [
  { id: 'img:aaa', type: 'img', filepath: '/x/a.png', dataUrl: FAKE_THUMB, ts: 1 },
  { id: 'img:bbb', type: 'img', filepath: '/x/b.png', dataUrl: FAKE_THUMB, ts: 2 },
  { id: 'txt:ccc', type: 'text', content: 'a short clip', ts: 3 },
];

const ctx = context();
ctx.sessions = [{ id: 's1', name: 'Momento' }];
ctx.sessionClips = clips.map(c => ({ ...c }));
ctx.api.saveSessions();

const written = fs.readFileSync(sessionStorePath, 'utf8');
const parsed = JSON.parse(written);

ok('the store no longer carries the previews',
   parsed.clips.every(c => !c.dataUrl), '');
ok('but it still carries the clips themselves',
   parsed.clips.length === 3 && parsed.clips[2].content === 'a short clip', '');
ok('and the collections',
   parsed.sessions.length === 1 && parsed.sessions[0].name === 'Momento', '');

// The whole point: the file is a fraction of what it was.
const withThumbs = JSON.stringify({ sessions: ctx.sessions, clips }, null, 2).length;
ok('which makes it far smaller than it was',
   written.length < withThumbs / 4,
   Math.round(withThumbs / 1024) + 'KB with previews, ' + Math.round(written.length / 1024) + 'KB without');

// Cached before dropped, never after. The store is about to stop being the
// only place a preview exists, so the other place has to exist first --
// exactly the mistake that lost a library earlier in this project.
const cached = fs.readdirSync(path.join(STORE, 'thumbs'));
ok('every dropped preview was cached first', cached.length === 2, cached.join(','));
ok('and a text clip did not get one', cached.length === 2, cached.join(','));

// ids are not filenames
ok('an id with a colon in it becomes a usable filename',
   cached.every(f => !f.includes(':')), cached.join(','));
ok('and the cached bytes are the picture, not the base64 of it',
   fs.statSync(path.join(STORE, 'thumbs', cached[0])).size === 30000,
   String(fs.statSync(path.join(STORE, 'thumbs', cached[0])).size));

// deleting a clip takes its cache with it
ctx.api.forgetThumb('img:aaa');
ok('deleting a clip drops its cached preview',
   fs.readdirSync(path.join(STORE, 'thumbs')).length === 1, '');

// ---------- an older store migrates itself ----------
// Caching on save alone is not enough: a library from before this change keeps
// its previews in the store, so nothing needs rebuilding and nothing triggers
// a save. Left like that, someone goes on parsing a thirteen megabyte store on
// every launch until they happen to edit a collection. Loading one has to
// notice and write the smaller file back once.
{
  const ctx2 = context();
  ctx2.thumbsToRebuild = [];
  vm.runInContext(lift('function recallThumb(') + '\nthis.recallThumb = recallThumb;', ctx2);

  const old = { id: 'img:zzz', type: 'img', filepath: '/x/z.png', dataUrl: FAKE_THUMB };
  ctx2.recallThumb(old);
  ok('a preview found in an old store is taken into the cache',
     fs.existsSync(path.join(STORE, 'thumbs', 'img_zzz.png')), '');
  ok('and the store is marked as needing rewriting',
     vm.runInContext('storeCarriedThumbs', ctx2) === true, '');

  // A clip whose preview is already cached must not set that flag, or every
  // launch rewrites the store for nothing.
  vm.runInContext('storeCarriedThumbs = false;', ctx2);
  ctx2.recallThumb({ id: 'img:zzz', type: 'img', filepath: '/x/z.png' });
  ok('but a store that is already migrated is left alone',
     vm.runInContext('storeCarriedThumbs', ctx2) === false, '');
}

ok('loading a store with previews in it writes the smaller one back',
   /if \(storeCarriedThumbs\)[\s\S]{0,160}saveSessions\(\);/.test(MAIN)
   && /if \(storeCarriedThumbs\)[\s\S]{0,160}savePinned\(\);/.test(MAIN), '');

// ---------- and the shape of it, so it cannot regress ----------
ok('the stores strip previews on the way out',
   /delete copy\.dataUrl;/.test(MAIN), '');
ok('the history log always did',
   /VOLATILE = \['_new', '_promoted', 'dataUrl'\]/.test(
     fs.readFileSync(path.join(__dirname, '..', 'src', 'history-store.js'), 'utf8')), '');
// Rebuilding 177 previews at 25ms each is 4.5 seconds; that cannot be startup.
ok('a missing cache is rebuilt after startup rather than during it',
   /thumbsToRebuild\.push\(entry\)/.test(MAIN)
   && /function rebuildThumbsInBackground\(\)/.test(MAIN), '');
ok('and a few at a time, so it never holds up a copy being captured',
   /i < 4 && thumbsToRebuild\.length/.test(MAIN), '');

fs.rmSync(STORE, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

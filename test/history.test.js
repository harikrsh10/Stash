// The log that makes history survive a quit. Drives the real module rather
// than a copy of it — it has no electron import precisely so this can.
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createHistoryStore } = require('../src/history-store');

const DIR = path.join(os.tmpdir(), 'stash-history-test');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const checks = [];
const ok = (name, pass, detail = '') => checks.push([name, pass, detail]);

let n = 0;
function freshFile() { return path.join(DIR, `history-${++n}.ndjson`); }
function open(filePath, opts = {}) {
  const s = createHistoryStore({ filePath, limit: 10000, ...opts });
  s.load();
  return s;
}
const clip = (id, content, ts) => ({ id, type: 'text', content, ts });

// ---------- a copy survives the process that made it ----------
const f1 = freshFile();
let s = open(f1);
s.add(clip('a', 'first', 1000));
s.add(clip('b', 'second', 2000));

// a second store on the same file is what a restart looks like
let out = createHistoryStore({ filePath: f1 }).load();
ok('both clips come back', out.entries.length === 2, out.entries.length + '');
ok('newest first', out.entries[0].id === 'b', out.entries.map(e => e.id).join(','));
ok('content round-trips', out.entries[1].content === 'first', out.entries[1].content);
ok('nothing is evicted under the cap', out.evicted.length === 0, out.evicted.length + '');

// ---------- a missing file is empty, not a crash ----------
out = createHistoryStore({ filePath: path.join(DIR, 'never-written.ndjson') }).load();
ok('a log that was never written reads as empty', out.entries.length === 0, out.entries.length + '');

// ---------- re-copying moves a clip without duplicating it ----------
const f2 = freshFile();
s = open(f2);
s.add(clip('a', 'x', 1000));
s.add(clip('b', 'y', 2000));
s.add(clip('a', 'x', 3000));   // copied again: same id, newer ts
out = createHistoryStore({ filePath: f2 }).load();
ok('a re-copied clip is stored once', out.entries.length === 2, out.entries.map(e => e.id).join(','));
ok('and comes back at the front', out.entries[0].id === 'a', out.entries[0].id);
ok('carrying its newer timestamp', out.entries[0].ts === 3000, out.entries[0].ts + '');

// ---------- deleting ----------
const f3 = freshFile();
s = open(f3);
s.add(clip('a', 'x', 1000));
s.add(clip('b', 'y', 2000));
ok('removing something held says so', s.remove('a') === true, '');
ok('removing something absent says so too', s.remove('zzz') === false, '');
out = createHistoryStore({ filePath: f3 }).load();
ok('a deleted clip does not come back', out.entries.length === 1 && out.entries[0].id === 'b',
   out.entries.map(e => e.id).join(','));

// ---------- clearing takes the content off disk, not just out of view ----------
const f4 = freshFile();
s = open(f4);
s.add(clip('a', 'something private', 1000));
s.add(clip('b', 'also private', 2000));
s.clear();
const afterClear = fs.readFileSync(f4, 'utf8');
ok('clearing empties the file itself', afterClear.trim() === '', JSON.stringify(afterClear.slice(0, 40)));
ok('the cleared text is nowhere in it', !afterClear.includes('private'), '');
out = createHistoryStore({ filePath: f4 }).load();
ok('and nothing comes back', out.entries.length === 0, out.entries.length + '');

// ---------- the cap ----------
const f5 = freshFile();
s = open(f5, { limit: 3 });
for (let i = 1; i <= 6; i++) s.add(clip('c' + i, 'clip ' + i, i * 1000));
out = createHistoryStore({ filePath: f5, limit: 3 }).load();
ok('the cap holds on reload', out.entries.length === 3, out.entries.length + '');
ok('it keeps the newest', out.entries.map(e => e.id).join(',') === 'c6,c5,c4',
   out.entries.map(e => e.id).join(','));
ok('and hands back what it dropped', out.evicted.map(e => e.id).join(',') === 'c3,c2,c1',
   out.evicted.map(e => e.id).join(','));

// ---------- thumbnails are not written to the log ----------
const f6 = freshFile();
s = open(f6);
s.add({ id: 'img1', type: 'img', content: 'shot.png', filepath: '/tmp/shot.png',
        dataUrl: 'data:image/png;base64,' + 'A'.repeat(5000), meta: '800×600', ts: 1000 });
const imgLine = fs.readFileSync(f6, 'utf8');
ok('the base64 thumbnail is left out', !imgLine.includes('dataUrl'), imgLine.slice(0, 60));
ok('so the line stays small', imgLine.length < 500, imgLine.length + ' bytes');
out = createHistoryStore({ filePath: f6 }).load();
ok('the file path is kept, which is what rebuilds it', out.entries[0].filepath === '/tmp/shot.png',
   out.entries[0].filepath);
ok('and the dimensions come back', out.entries[0].meta === '800×600', out.entries[0].meta);

// ---------- per-run flags never reach disk ----------
const f7 = freshFile();
s = open(f7);
s.add({ id: 'v', type: 'text', content: 'v', ts: 1, _new: true, _promoted: true });
const volatileLine = fs.readFileSync(f7, 'utf8');
ok('_new does not persist', !volatileLine.includes('_new'), volatileLine);
ok('_promoted does not persist', !volatileLine.includes('_promoted'), volatileLine);

// ---------- a half-written line costs one clip, not the history ----------
const f8 = freshFile();
s = open(f8);
s.add(clip('a', 'before', 1000));
s.add(clip('b', 'after', 2000));
// exactly what a process killed mid-append leaves behind
fs.appendFileSync(f8, '{"op":"add","e":{"id":"c","con', 'utf8');
out = createHistoryStore({ filePath: f8 }).load();
ok('a torn last line is skipped', out.entries.length === 2, out.entries.map(e => e.id).join(','));
ok('and the clips before it are intact', out.entries[1].content === 'before', out.entries[1].content);

// ---------- compaction folds away the dead weight ----------
const f9 = freshFile();
s = open(f9, { limit: 2 });
for (let i = 1; i <= 8; i++) s.add(clip('c' + i, 'clip ' + i, i * 1000));
ok('every write appended a line', s.lineCount === 8, s.lineCount + '');
const before = fs.readFileSync(f9, 'utf8').split('\n').filter(Boolean).length;
const reopened = createHistoryStore({ filePath: f9, limit: 2 });
reopened.load();
const after = fs.readFileSync(f9, 'utf8').split('\n').filter(Boolean).length;
ok('loading past the cap rewrites the log', after < before, before + ' -> ' + after);
ok('leaving one line per live clip', after === 2, after + '');
ok('and the clips are still right',
   reopened.load().entries.map(e => e.id).join(',') === 'c8,c7',
   reopened.load().entries.map(e => e.id).join(','));

// ---------- turned off, it writes nothing at all ----------
const f10 = freshFile();
s = createHistoryStore({ filePath: f10, enabled: false });
s.load();
s.add(clip('a', 'should not be written', 1000));
s.add(clip('b', 'nor this', 2000));
ok('a disabled store creates no file', !fs.existsSync(f10), 'file exists');
ok('and reports itself as off', s.enabled === false, '');

// ---------- a store with nowhere to write is harmless ----------
s = createHistoryStore({ filePath: null });
s.load();
s.add(clip('a', 'x', 1));
s.remove('a');
s.clear();
s.compact();
ok('a store with no path does nothing rather than throwing', true, '');

// ---------- restoreHistory: the wiring that puts the log back on screen ----------
// Lifted out of the real main.js. nativeImage is the only electron thing it
// touches, and only to rebuild a thumbnail, so a stub is enough to drive the
// decisions this function actually makes: what comes back and what is dropped.
const vm = require('vm');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const grab = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};

function runRestore({ log, userData, remember = true, presentFiles = [] }) {
  fs.mkdirSync(userData, { recursive: true });
  if (log !== null) fs.writeFileSync(path.join(userData, 'history.ndjson'), log, 'utf8');
  presentFiles.forEach(f => fs.writeFileSync(f, 'not really a png', 'utf8'));

  const ctx = {
    fs, path, console,
    createHistoryStore,
    HISTORY_LIMIT: 10000,
    history: [],
    historyStore: null,
    settings: { rememberHistory: remember },
    app: { getPath: () => userData },
    nativeImage: {
      createFromPath: (p) => ({
        isEmpty: () => !fs.existsSync(p),
        resize: () => ({ toDataURL: () => 'data:image/png;base64,STUB' }),
      }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(grab('restoreHistory') + '\nthis.restoreHistory = restoreHistory;', ctx);
  ctx.restoreHistory();
  return ctx;
}

const line = (e) => JSON.stringify({ op: 'add', e }) + '\n';
const shotPath = path.join(DIR, 'present-shot.png');

let r = runRestore({
  userData: path.join(DIR, 'ud1'),
  log: line({ id: 't1', type: 'text', content: 'a text clip', ts: 3000 })
     + line({ id: 'i1', type: 'img', content: 'shot.png', filepath: shotPath, meta: '10×10', ts: 2000 })
     + line({ id: 'i2', type: 'img', content: 'gone.png', filepath: path.join(DIR, 'gone.png'), ts: 1000 }),
  presentFiles: [shotPath],
});
ok('the text clip comes back', r.history.some(c => c.id === 't1'), r.history.map(c => c.id).join(','));
ok('an image whose file is still there comes back', r.history.some(c => c.id === 'i1'),
   r.history.map(c => c.id).join(','));
ok('an image whose file has gone is dropped', !r.history.some(c => c.id === 'i2'),
   r.history.map(c => c.id).join(','));
ok('the surviving image gets its thumbnail rebuilt',
   r.history.find(c => c.id === 'i1').dataUrl === 'data:image/png;base64,STUB',
   String(r.history.find(c => c.id === 'i1').dataUrl).slice(0, 30));
ok('and history comes back newest first', r.history.map(c => c.id).join(',') === 't1,i1',
   r.history.map(c => c.id).join(','));
ok('the dropped image is taken out of the log too',
   !fs.readFileSync(path.join(DIR, 'ud1', 'history.ndjson'), 'utf8').includes('gone.png'), '');

// turned off, nothing is restored and the log on disk is destroyed
const ud2 = path.join(DIR, 'ud2');
r = runRestore({
  userData: ud2,
  log: line({ id: 't1', type: 'text', content: 'private', ts: 1000 }),
  remember: false,
});
ok('with remembering off, nothing is restored', r.history.length === 0, r.history.length + '');
ok('and the log is deleted rather than merely ignored',
   !fs.existsSync(path.join(ud2, 'history.ndjson')), 'still there');

// a first run has no log at all
r = runRestore({ userData: path.join(DIR, 'ud3'), log: null });
ok('a first run restores nothing and does not throw', r.history.length === 0, r.history.length + '');

// ---------- keeping the pictures ----------
// A picture is the clip you cannot copy again, so it is the one worth keeping
// and the only one big enough to need a ceiling. These drive the real
// functions out of main.js against real files on disk.
function imageCtx({ budget = 1000, historyImageDir = null } = {}) {
  const ctx = {
    fs, path, console,
    HISTORY_IMAGE_BUDGET: budget,
    history: [], pinned: [], sessionClips: [],
    historyImageDir,
    historyStore: { add() {}, remove() {}, clear() {} },
  };
  vm.createContext(ctx);
  vm.runInContext([grab('dropImageFile'), grab('pruneHistoryImages'), grab('sizeOf'),
                   grab('gcHistoryImages')].join('\n')
    + '\nthis.api = { dropImageFile, pruneHistoryImages, gcHistoryImages };', ctx);
  return ctx;
}

// a file is only removed once nothing anywhere still wants it
const refDir = path.join(DIR, 'refs');
fs.mkdirSync(refDir, { recursive: true });
const shared = path.join(refDir, 'shared.png');
const lonely = path.join(refDir, 'lonely.png');
fs.writeFileSync(shared, 'x');
fs.writeFileSync(lonely, 'x');

let c = imageCtx();
c.pinned.push({ id: 'p', type: 'img', filepath: shared });
c.api.dropImageFile(shared);
ok('a picture a pinned clip still wants is left alone', fs.existsSync(shared), 'deleted');
c.api.dropImageFile(lonely);
ok('a picture nothing points at goes', !fs.existsSync(lonely), 'still there');

// the case that used to delete a file out from under the history row
const heldByHistory = path.join(refDir, 'held.png');
fs.writeFileSync(heldByHistory, 'x');
c = imageCtx();
c.history.push({ id: 'h', type: 'img', filepath: heldByHistory });
c.api.dropImageFile(heldByHistory);
ok('leaving a collection does not delete the history copy', fs.existsSync(heldByHistory), 'deleted');

// ---------- the byte budget ----------
const budDir = path.join(DIR, 'budget');
fs.mkdirSync(budDir, { recursive: true });
c = imageCtx({ budget: 250 });
// newest first, 100 bytes each — four of them is 400, over a 250 ceiling
for (let i = 4; i >= 1; i--) {
  const fp = path.join(budDir, `img${i}.png`);
  fs.writeFileSync(fp, 'z'.repeat(100));
  c.history.push({ id: 'i' + i, type: 'img', filepath: fp, bytes: 100, ts: i * 1000 });
}
c.history.push({ id: 'text', type: 'text', content: 'not a picture', ts: 9000 });
c.api.pruneHistoryImages();
ok('the budget drops enough to get under it',
   c.history.filter(h => h.type === 'img').length === 2,
   c.history.filter(h => h.type === 'img').length + '');
ok('and drops the oldest, keeping the newest',
   c.history.filter(h => h.type === 'img').map(h => h.id).join(',') === 'i4,i3',
   c.history.filter(h => h.type === 'img').map(h => h.id).join(','));
ok('their files go with them', !fs.existsSync(path.join(budDir, 'img1.png')), 'still there');
ok('the kept ones keep theirs', fs.existsSync(path.join(budDir, 'img4.png')), 'deleted');
ok('text clips are untouched by an image budget',
   c.history.some(h => h.id === 'text'), 'the text clip was dropped');

// under budget, nothing happens
c = imageCtx({ budget: 10000 });
const safe = path.join(budDir, 'safe.png');
fs.writeFileSync(safe, 'z'.repeat(100));
c.history.push({ id: 's', type: 'img', filepath: safe, bytes: 100, ts: 1 });
c.api.pruneHistoryImages();
ok('under the ceiling nothing is dropped', c.history.length === 1 && fs.existsSync(safe), '');

// a picture captured before sizes were recorded is measured rather than ignored
c = imageCtx({ budget: 50 });
const unsized = path.join(budDir, 'unsized.png');
fs.writeFileSync(unsized, 'z'.repeat(400));
c.history.push({ id: 'u', type: 'img', filepath: unsized, ts: 1 });
c.api.pruneHistoryImages();
ok('a picture with no recorded size is still measured', c.history.length === 0,
   'it was treated as costing nothing');

// ---------- sweeping what nothing points at ----------
const gcDir = path.join(DIR, 'gc');
fs.mkdirSync(gcDir, { recursive: true });
const referenced = path.join(gcDir, 'kept.png');
const orphan1 = path.join(gcDir, 'orphan1.png');
const orphan2 = path.join(gcDir, 'orphan2.png');
[referenced, orphan1, orphan2].forEach(f => fs.writeFileSync(f, 'x'));
c = imageCtx({ historyImageDir: gcDir });
c.history.push({ id: 'k', type: 'img', filepath: referenced });
c.api.gcHistoryImages();
ok('a picture a clip points at survives the sweep', fs.existsSync(referenced), 'swept');
ok('pictures nothing points at are swept',
   !fs.existsSync(orphan1) && !fs.existsSync(orphan2), 'left behind');

// no directory yet is not an error
c = imageCtx({ historyImageDir: path.join(DIR, 'does-not-exist') });
c.api.gcHistoryImages();
ok('sweeping a directory that is not there does nothing rather than throwing', true, '');

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
}
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

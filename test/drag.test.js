// Pulls materializeForDrag out of the real main.js source and runs it, so the
// multi-file naming/writing is tested as shipped rather than as a copy.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const fn = SRC.match(/function materializeForDrag[\s\S]*?\n\}/);
if (!fn) { console.log('FAIL: could not find materializeForDrag in main.js'); process.exit(1); }

const TMP_DIR = path.join(os.tmpdir(), 'stash-drag-test');
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const ctx = { fs, path, TMP_DIR, module: {}, console };
vm.createContext(ctx);
vm.runInContext(fn[0] + '\nthis.materializeForDrag = materializeForDrag;', ctx);

// two identical clips + an image: the identical pair is the collision case
const entries = [
  { type: 'text', content: 'same text' },
  { type: 'text', content: 'same text' },
  { type: 'code', content: 'const x = 1;' },
  { type: 'img', filepath: 'C:\\some\\pinned\\image.png' },
];

const files = entries.map((e, i) => ctx.materializeForDrag(e, i));
const unique = new Set(files);

console.log('paths produced:');
files.forEach(f => console.log('  ' + f));

const written = fs.readdirSync(TMP_DIR);
const checks = [
  ['4 paths returned', files.length === 4, files.length],
  ['all paths distinct', unique.size === 4, unique.size + ' unique'],
  ['identical clips do not collide', files[0] !== files[1], ''],
  ['3 .txt files written to disk', written.length === 3, written.join(', ')],
  ['image reuses its existing file, not a copy', files[3] === 'C:\\some\\pinned\\image.png', files[3]],
  ['text content round-trips', fs.readFileSync(files[0], 'utf8') === 'same text', ''],
  ['code content round-trips', fs.readFileSync(files[2], 'utf8') === 'const x = 1;', ''],
];

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
}
fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

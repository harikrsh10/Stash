// Reading the text in pictures so it can be searched for. The engine is
// injected into the indexer, so this drives the real queue without a real OCR
// run — the thing under test is the ordering, the throttling and what is
// allowed to reach disk, not whether Windows can read a PNG.
const { createOcrIndexer, sanitizeOcrText, needsIndexing } = require('../src/ocr-index');

const checks = [];
const ok = (name, pass, detail = '') => checks.push([name, pass, detail]);
const settle = () => new Promise(r => setImmediate(r));
// The queue schedules its next job on a timer. Driving that timer with
// setImmediate makes the ordering deterministic instead of a race against a
// real clock, and is why the module takes the timer as an argument.
const immediateTimers = { setTimer: (fn) => setImmediate(fn), clearTimer: clearImmediate };

// The real detector, lifted so the test cannot drift from what ships.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const grab = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};
const secretCtx = { console };
vm.createContext(secretCtx);
vm.runInContext(grab('looksSecret') + '\n' + grab('luhnCheck')
  + '\nthis.looksSecret = looksSecret;', secretCtx);
const looksSecret = secretCtx.looksSecret;

// ---------- what is allowed to be written down ----------
ok('ordinary text survives',
   sanitizeOcrText('Invalid token in request handler', looksSecret)
     === 'Invalid token in request handler', '');

const withKey = sanitizeOcrText('export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz012345', looksSecret);
ok('an api key in a screenshot is not indexed', !withKey.includes('sk-abcdefghij'), withKey);
ok('but the words around it are', withKey.includes('export'), withKey);

const withJwt = sanitizeOcrText('Authorization: Bearer eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSM', looksSecret);
ok('a jwt is not indexed', !withJwt.includes('eyJhbGciOi.'), withJwt);
ok('the header name is kept, so the shape is still searchable',
   withJwt.includes('Authorization'), withJwt);

ok('runs of whitespace collapse',
   sanitizeOcrText('a\t\t  b', looksSecret) === 'a b',
   JSON.stringify(sanitizeOcrText('a\t\t  b', looksSecret)));
ok('a wall of text is capped',
   sanitizeOcrText('x'.repeat(50000), looksSecret).length === 8000,
   sanitizeOcrText('x'.repeat(50000), looksSecret).length + '');
ok('nothing in, nothing out', sanitizeOcrText('', looksSecret) === '', '');
ok('null in, nothing out', sanitizeOcrText(null, looksSecret) === '', '');

// ---------- which clips are worth reading ----------
ok('a picture that has never been read needs it',
   needsIndexing({ type: 'img', filepath: '/a.png' }), '');
ok('a picture already read does not',
   !needsIndexing({ type: 'img', filepath: '/a.png', ocrText: 'already' }), '');
ok('a picture read and found empty does not',
   !needsIndexing({ type: 'img', filepath: '/a.png', ocrText: '' }), '');
ok('a picture that could not be read does not',
   !needsIndexing({ type: 'img', filepath: '/a.png', ocrTried: true }), '');
ok('text is not a picture', !needsIndexing({ type: 'text', content: 'x' }), '');
ok('a picture with no file is not readable',
   !needsIndexing({ type: 'img' }), '');

// ---------- the queue ----------
(async () => {
  const img = (id) => ({ id, type: 'img', filepath: '/' + id + '.png' });

  // one at a time, in the order given
  let order = [];
  let indexer = createOcrIndexer({
    gapMs: 0, ...immediateTimers,
    extract: async (fp) => { order.push(fp); return 'text of ' + fp; },
    onText: () => {},
    looksSecret,
  });
  const clips = [img('a'), img('b'), img('c')];
  indexer.queue(clips);
  for (let i = 0; i < 40; i++) await settle();
  ok('everything queued is read', order.length === 3, order.join(','));
  ok('in the order it was given', order.join(',') === '/a.png,/b.png,/c.png', order.join(','));
  ok('and the text lands on the clip', clips[0].ocrText === 'text of /a.png', clips[0].ocrText);

  // the newest picture jumps the backlog
  order = [];
  indexer = createOcrIndexer({
    gapMs: 0, ...immediateTimers,
    extract: async (fp) => { order.push(fp); return ''; },
    onText: () => {},
    looksSecret,
  });
  indexer.queue([img('old1'), img('old2')]);
  indexer.queueFirst(img('justCopied'));
  for (let i = 0; i < 40; i++) await settle();
  ok('a picture just copied is read first', order[0] === '/justCopied.png', order.join(','));

  // the same clip is never queued twice
  order = [];
  indexer = createOcrIndexer({
    gapMs: 0, ...immediateTimers,
    extract: async (fp) => { order.push(fp); return 'x'; },
    onText: () => {},
    looksSecret,
  });
  const dup = img('dup');
  indexer.queue([dup]);
  indexer.queue([dup]);
  indexer.queueFirst(dup);
  for (let i = 0; i < 40; i++) await settle();
  ok('queueing the same picture twice reads it once', order.length === 1, order.join(','));

  // a picture that cannot be read is marked, not retried for ever
  const broken = img('broken');
  let attempts = 0;
  indexer = createOcrIndexer({
    gapMs: 0, ...immediateTimers,
    extract: async () => { attempts++; throw new Error('no engine here'); },
    onText: () => {},
    looksSecret,
  });
  indexer.queue([broken]);
  for (let i = 0; i < 40; i++) await settle();
  ok('a picture that cannot be read is tried once', attempts === 1, attempts + '');
  ok('and marked so a later sweep leaves it alone', broken.ocrTried === true, '');
  ok('with no text written down', broken.ocrText === undefined, String(broken.ocrText));
  indexer.queue([broken]);
  for (let i = 0; i < 20; i++) await settle();
  ok('re-queueing it does not read it again', attempts === 1, attempts + '');

  // failures report null rather than an empty string, which means something else
  let reported = 'unset';
  indexer = createOcrIndexer({
    gapMs: 0, ...immediateTimers,
    extract: async () => { throw new Error('nope'); },
    onText: (_c, t) => { reported = t; },
    looksSecret,
  });
  indexer.queue([img('f')]);
  for (let i = 0; i < 20; i++) await settle();
  ok('a failure is reported as null, not as empty text', reported === null, String(reported));

  // secrets never reach the callback that writes to disk
  let written = null;
  indexer = createOcrIndexer({
    gapMs: 0, ...immediateTimers,
    extract: async () => 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here',
    onText: (_c, t) => { written = t; },
    looksSecret,
  });
  indexer.queue([img('s')]);
  for (let i = 0; i < 20; i++) await settle();
  ok('what reaches the store has the secret removed',
     written !== null && !written.includes('ghp_abcdefghij'), String(written));

  // stopping means stopping
  order = [];
  indexer = createOcrIndexer({
    gapMs: 5, ...immediateTimers,
    extract: async (fp) => { order.push(fp); return 'x'; },
    onText: () => {},
    looksSecret,
  });
  indexer.queue([img('x1'), img('x2'), img('x3')]);
  indexer.stop();
  for (let i = 0; i < 30; i++) await settle();
  ok('stopping empties the queue', indexer.size === 0, indexer.size + '');
  ok('and nothing more is read', order.length === 0, order.join(','));

  let failed = 0;
  for (const [name, pass, detail] of checks) {
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();

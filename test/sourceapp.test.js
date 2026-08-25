// Which app a clip was copied out of. The helper process is faked here: what
// is under test is the lazy start, the queueing, what gets ignored and what
// happens when the helper misbehaves — not whether Windows can name a window.
const { EventEmitter } = require('events');
const { createSourceApp, isIgnored, tidyAppName } = require('../src/source-app');

const checks = [];
const ok = (name, pass, detail = '') => checks.push([name, pass, detail]);
const settle = () => new Promise(r => setImmediate(r));

// A stand-in for the PowerShell helper: records what was written to it and
// lets the test answer whenever it likes.
function fakeHelper() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  child.killed = false;
  child.stdin = {
    write: (s) => { child.written.push(s); return true; },
    end: () => {},
  };
  child.kill = () => { child.killed = true; };
  child.say = (line) => child.stdout.emit('data', Buffer.from(line + '\n'));
  return child;
}

function harness(opts = {}) {
  const spawned = [];
  const written = [];
  const sa = createSourceApp({
    platform: 'win32',
    selfPid: 999,
    spawn: (cmd, args) => {
      const c = fakeHelper();
      spawned.push({ cmd, args, child: c });
      return c;
    },
    writeScript: (body) => { written.push(body); return 'C:\\tmp\\fg.ps1'; },
    ...opts,
  });
  return { sa, spawned, written, last: () => spawned[spawned.length - 1].child };
}

// ---------- what is not worth recording ----------
ok('stash itself is not provenance', isIgnored('Stash'), '');
ok('case does not matter', isIgnored('sTaSh'), '');
ok('the shell that draws the desktop is not an app', isIgnored('Windows Explorer'), '');
ok('an empty name is not an app', isIgnored(''), '');
ok('a real app is worth recording', !isIgnored('Figma'), '');

// ---------- what an app is called on a row ----------
// Windows 11's Notepad reports its own filename as its description, which is
// how "Notepad.exe" ended up on a row during the first real run of this.
ok('an app that describes itself by filename loses the extension',
   tidyAppName('Notepad.exe') === 'Notepad', tidyAppName('Notepad.exe'));
ok('a proper name is left alone',
   tidyAppName('Google Chrome') === 'Google Chrome', tidyAppName('Google Chrome'));
ok('a name that merely contains exe is left alone',
   tidyAppName('Executor') === 'Executor', tidyAppName('Executor'));
ok('surrounding whitespace goes', tidyAppName('  Figma  ') === 'Figma', '');

// ---------- nothing is started until something is copied ----------
(async () => {
  let h = harness();
  ok('supported on windows', h.sa.supported === true, '');
  ok('no helper before the first copy', h.sa.running === false, '');
  ok('and no script written yet', h.written.length === 0, h.written.length + '');

  const p = h.sa.current();
  ok('asking starts the helper', h.sa.running === true, '');
  ok('the script is written once', h.written.length === 1, h.written.length + '');
  ok('powershell is run with the script', h.spawned[0].args.includes('C:\\tmp\\fg.ps1'),
     h.spawned[0].args.join(' '));

  // the helper announces itself before it can answer
  h.last().say('ready');
  h.last().say('4321\tFigma');
  const answer = await p;
  ok('the app comes back with its name', answer && answer.name === 'Figma', JSON.stringify(answer));
  ok('and the pid it belongs to', answer && answer.pid === 4321, JSON.stringify(answer));

  // a second ask reuses the same helper rather than paying the startup again
  const before = h.spawned.length;
  const p2 = h.sa.current();
  h.last().say('4321\tFigma');
  await p2;
  ok('a second copy reuses the running helper', h.spawned.length === before, h.spawned.length + '');

  // ---------- what gets thrown away ----------
  let q = h.sa.current();
  h.last().say('999\tStash');
  ok('copying from inside stash records nothing', (await q) === null, '');

  q = h.sa.current();
  h.last().say('1234\tWindows Explorer');
  ok('the desktop shell records nothing', (await q) === null, '');

  q = h.sa.current();
  h.last().say('\t');
  ok('an answer the helper could not resolve records nothing', (await q) === null, '');

  // ---------- answers are matched to the copy that asked ----------
  h = harness();
  const first = h.sa.current();
  h.last().say('ready');
  const second = h.sa.current();
  h.last().say('11\tFigma');
  h.last().say('22\tGoogle Chrome');
  const [a1, a2] = await Promise.all([first, second]);
  ok('two copies in flight get their own answers, in order',
     a1.name === 'Figma' && a2.name === 'Google Chrome',
     JSON.stringify([a1, a2]));

  // ---------- a helper that never answers ----------
  let fired = null;
  h = harness({
    queryTimeoutMs: 50,
    setTimer: (fn, ms) => { if (ms === 50) { fired = fn; return 'T'; } return setTimeout(fn, ms); },
    clearTimer: (t) => { if (t !== 'T') clearTimeout(t); },
  });
  const hung = h.sa.current();
  h.last().say('ready');
  fired();                                  // the query timeout expires
  ok('a copy does not wait for ever on a silent helper', (await hung) === null, '');
  // and the late answer is not handed to the next copy that asks
  const next = h.sa.current();
  h.last().say('77\tLate Answer');
  // The abandoned query's answer arrives first and has to be swallowed rather
  // than handed to this one — otherwise every answer from here on is one
  // behind, for the rest of the session.
  h.last().say('88\tThe Right Answer');
  const nextAnswer = await next;
  ok('a late answer is swallowed, not given to the next copy',
     nextAnswer && nextAnswer.name === 'The Right Answer',
     JSON.stringify(nextAnswer));

  // ---------- a helper that dies ----------
  h = harness();
  const orphan = h.sa.current();
  h.last().say('ready');
  h.last().emit('exit', 1, null);
  ok('a copy waiting on a helper that died gets nothing rather than hanging',
     (await orphan) === null, '');
  ok('and the helper is no longer considered running', h.sa.running === false, '');
  // the next copy starts a fresh one
  const after = h.spawned.length;
  h.sa.current();
  ok('the next copy starts a new helper', h.spawned.length === after + 1,
     h.spawned.length + ' vs ' + after);

  // ---------- a helper that cannot be started at all ----------
  const boom = createSourceApp({
    platform: 'win32',
    spawn: () => { throw new Error('no powershell here'); },
    writeScript: () => 'C:\\tmp\\fg.ps1',
    onError: () => {},
  });
  ok('a helper that will not start answers null rather than throwing',
     (await boom.current()) === null, '');

  const noScript = createSourceApp({
    platform: 'win32',
    spawn: () => fakeHelper(),
    writeScript: () => { throw new Error('read-only disk'); },
    onError: () => {},
  });
  ok('a script that cannot be written answers null too',
     (await noScript.current()) === null, '');

  // ---------- platforms with no way to ask ----------
  const mac = createSourceApp({ platform: 'darwin', spawn: () => fakeHelper(), writeScript: () => 'x' });
  ok('an unsupported platform says so', mac.supported === false, '');
  ok('and answers null without starting anything', (await mac.current()) === null, '');
  ok('having spawned nothing', mac.running === false, '');

  // ---------- stopping ----------
  h = harness();
  const dangling = h.sa.current();
  h.last().say('ready');
  h.sa.stop();
  ok('stopping kills the helper', h.last().killed === true, '');
  ok('and releases anything waiting on it', (await dangling) === null, '');
  ok('asking after stopping answers null', (await h.sa.current()) === null, '');

  // ---------- the idle timer ----------
  let idleFn = null;
  h = harness({
    idleStopMs: 12345,
    setTimer: (fn, ms) => { if (ms === 12345) { idleFn = fn; return 'IDLE'; } return setTimeout(fn, ms); },
    clearTimer: (t) => { if (t !== 'IDLE') clearTimeout(t); },
  });
  const asked = h.sa.current();
  h.last().say('ready');
  h.last().say('5\tFigma');
  await asked;
  ok('the helper stays up between copies', h.sa.running === true, '');
  idleFn();
  ok('but is stopped once nothing has been copied for a while',
     h.sa.running === false, '');

  let failed = 0;
  for (const [name, pass, detail] of checks) {
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();

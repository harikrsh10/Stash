// Which app a clip was copied out of. The helper process is faked here: what
// is under test is the lazy start, the queueing, what gets ignored and what
// happens when the helper misbehaves — not whether Windows can name a window.
const { EventEmitter } = require('events');
const { createSourceApp, isIgnored, tidyAppName, parseLsAppInfoName,
        MAC_FRONT_CMD, MAC_FRONT_FULL_CMD, MAC_FRONT_PATH_CMD,
        parseLsAppInfoPath } = require('../src/source-app');

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
  h.last().say('4321\tFigma\tC:\\Apps\\Figma\\Figma.exe');
  const answer = await p;
  ok('the app comes back with its name', answer && answer.name === 'Figma', JSON.stringify(answer));
  ok('and the pid it belongs to', answer && answer.pid === 4321, JSON.stringify(answer));
  ok('and where it lives, so its icon can be asked for',
     answer && answer.path === 'C:\\Apps\\Figma\\Figma.exe', JSON.stringify(answer));

  // a protected process gives a name but no path; that costs an icon, not the row
  let noPath = h.sa.current();
  h.last().say('55\tSome Guarded App\t');
  const guarded = await noPath;
  ok('an app that will not give up its path still gives its name',
     guarded && guarded.name === 'Some Guarded App' && guarded.path === null,
     JSON.stringify(guarded));

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

  // ---------- macOS asks instead of keeping a helper ----------
  // Everything here is real except lsappinfo itself, which cannot run on the
  // machine this was written on. The command sent to the shell is asserted
  // exactly, so at least the thing that would be run is pinned down.
  // `reply` may be one answer for everything, or one per command.
  function macHarness(reply, opts = {}) {
    const calls = [];
    const sa = createSourceApp({
      platform: 'darwin',
      spawn: () => { throw new Error('macOS must not spawn a resident helper'); },
      writeScript: () => { throw new Error('macOS must not write a script'); },
      runOnce: (cmd, args) => {
        calls.push([cmd, args]);
        const out = typeof reply === 'function' ? reply(args[1]) : reply;
        return Promise.resolve(out);
      },
      onError: () => {},
      ...opts,
    });
    return { sa, calls };
  }
  const macReplies = (name, bundlePath) => (cmd) => {
    if (cmd === MAC_FRONT_CMD) return name ? '"LSDisplayName"="' + name + '"' : '';
    if (cmd === MAC_FRONT_PATH_CMD) return bundlePath ? '"bundlepath"="' + bundlePath + '"' : '';
    return '';
  };

  let m = macHarness('"LSDisplayName"="Figma"\n');
  const macAnswer = await m.sa.current();
  ok('macOS is supported', m.sa.supported === true, '');
  ok('and names the app in front', macAnswer && macAnswer.name === 'Figma', JSON.stringify(macAnswer));
  ok('without keeping anything alive', m.sa.running === false, '');
  ok('asking through a shell so lsappinfo can feed itself',
     m.calls[0][0] === '/bin/sh' && m.calls[0][1][0] === '-c'
       && m.calls[0][1][1] === MAC_FRONT_CMD,
     JSON.stringify(m.calls[0]));
  // lsappinfo prints its ASN already quoted and command substitution keeps the
  // quotes, so without stripping them the argument carries literal quote
  // characters. This is the one part of the macOS path that cannot be run here,
  // so the command itself is pinned rather than merely assumed.
  ok('the front-app ASN is stripped of the quotes lsappinfo prints around it',
     MAC_FRONT_CMD.includes("tr -d '\"'"), MAC_FRONT_CMD);

  m = macHarness('"LSDisplayName"="Google Chrome"\n');
  ok('a name with a space survives', (await m.sa.current()).name === 'Google Chrome', '');

  m = macHarness('"LSDisplayName"="Stash"\n');
  ok('stash in front records nothing on macOS too', (await m.sa.current()) === null, '');

  m = macHarness('');
  ok('nothing in front records nothing', (await m.sa.current()) === null, '');

  m = macHarness('some unexpected output');
  ok('output it cannot parse records nothing rather than guessing',
     (await m.sa.current()) === null, '');

  // lsappinfo missing or refusing
  const macBroken = createSourceApp({
    platform: 'darwin',
    runOnce: () => Promise.reject(new Error('lsappinfo: command not found')),
    onError: () => {},
  });
  ok('a mac where the command fails answers null rather than throwing',
     (await macBroken.current()) === null, '');

  const macNoRunner = createSourceApp({ platform: 'darwin' });
  ok('a mac with no way to run anything answers null',
     (await macNoRunner.current()) === null, '');

  // ---------- the bundle path, which is what an icon needs ----------
  // The full info block is asked for first because it carries the path. If it
  // answers with something unreadable the narrow command is tried instead, so
  // a Mac that only speaks the old shape still gets names.
  // The name and the path are asked the same narrow way. The first attempt at
  // this asked for the whole info block instead and got back something that
  // would not parse, which is how Macs ended up with names and no icons.
  m = macHarness(macReplies('Figma', '/Applications/Figma.app'));
  const withPath = await m.sa.current();
  ok('the name comes back', withPath && withPath.name === 'Figma', JSON.stringify(withPath));
  ok('and the bundle path with it', withPath && withPath.path === '/Applications/Figma.app',
     JSON.stringify(withPath));
  ok('the name is asked for first', m.calls[0][1][1] === MAC_FRONT_CMD, m.calls[0][1][1]);
  ok('and the path second, the same narrow way',
     m.calls[1] && m.calls[1][1][1] === MAC_FRONT_PATH_CMD,
     m.calls[1] ? m.calls[1][1][1] : 'never asked');

  // a path that will not come costs an icon and nothing else
  m = macHarness(macReplies('Safari', null));
  const noBundle = await m.sa.current();
  ok('an app whose path will not come still gives its name',
     noBundle && noBundle.name === 'Safari' && noBundle.path === null, JSON.stringify(noBundle));

  // and one that errors outright is the same
  {
    const sa = createSourceApp({
      platform: 'darwin',
      runOnce: (cmd, args) => args[1] === MAC_FRONT_CMD
        ? Promise.resolve('"LSDisplayName"="Notes"')
        : Promise.reject(new Error('lsappinfo: unknown key')),
      onError: () => {},
    });
    const errored = await sa.current();
    ok('a path lookup that fails outright still gives the name',
       errored && errored.name === 'Notes' && errored.path === null, JSON.stringify(errored));
  }

  // an app we already hold an icon for is not asked about twice
  m = macHarness(macReplies('Figma', '/Applications/Figma.app'), { needsPath: () => false });
  const cached = await m.sa.current();
  ok('an app whose icon is already held costs one process, not two',
     m.calls.length === 1, m.calls.length + ' calls');
  ok('and still names itself', cached && cached.name === 'Figma', JSON.stringify(cached));

  // Ground truth: this is what a Mac actually printed for
  // `lsappinfo info -only bundlepath`. The key asked for is `bundlepath` and
  // the key returned is `LSBundlePath`, which no amount of reasoning would
  // have produced.
  ok('the real thing a mac prints back parses',
     parseLsAppInfoPath('"LSBundlePath"="/System/Applications/Utilities/Terminal.app"')
       === '/System/Applications/Utilities/Terminal.app',
     parseLsAppInfoPath('"LSBundlePath"="/System/Applications/Utilities/Terminal.app"'));
  ok('and an ordinary app bundle the same way',
     parseLsAppInfoPath('"LSBundlePath"="/Applications/Comet.app"') === '/Applications/Comet.app',
     parseLsAppInfoPath('"LSBundlePath"="/Applications/Comet.app"'));

  // the path parser copes with the spellings lsappinfo has used
  ok('bundle path with a space in the key',
     parseLsAppInfoPath('bundle path="/Applications/Figma.app"') === '/Applications/Figma.app', '');
  ok('bundlepath without one',
     parseLsAppInfoPath('"bundlepath"="/Applications/Notes.app"') === '/Applications/Notes.app', '');
  ok('and an app bundle found anywhere in the block as a last resort',
     parseLsAppInfoPath('junk "/Applications/Some App.app" junk') === '/Applications/Some App.app',
     parseLsAppInfoPath('junk "/Applications/Some App.app" junk'));
  ok('nothing that looks like a path gives nothing',
     parseLsAppInfoPath('"LSDisplayName"="Figma"') === '', parseLsAppInfoPath('"LSDisplayName"="Figma"'));

  // the parser on its own
  ok('the parser reads the display name',
     parseLsAppInfoName('"LSDisplayName"="Terminal"') === 'Terminal', '');
  ok('and copes with spacing',
     parseLsAppInfoName('  "LSDisplayName" = "Notes"  ') === 'Notes',
     parseLsAppInfoName('  "LSDisplayName" = "Notes"  '));
  ok('and gives nothing back for nothing', parseLsAppInfoName('') === '', '');

  // ---------- a platform with no way to ask at all ----------
  const linux = createSourceApp({ platform: 'linux', spawn: () => fakeHelper(), writeScript: () => 'x' });
  ok('an unsupported platform says so', linux.supported === false, '');
  ok('and answers null without starting anything', (await linux.current()) === null, '');
  ok('having spawned nothing', linux.running === false, '');

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

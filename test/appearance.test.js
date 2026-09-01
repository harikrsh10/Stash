// The appearance switch, and the loop it used to arm.
//
// Reported: on a Mac, once appearance is set to "system" it cannot be moved to
// light or dark again. Asked on a Mac, the reason is that assigning
// nativeTheme.themeSource is not idempotent -- and only for one value:
//
//   setting themeSource to light again, same value    -> 'updated' fired 0 times
//   setting themeSource to system again, same value   -> 'updated' fired 1 time
//
// The handler for 'updated' called applyAppearance, which assigns themeSource,
// which emits 'updated'. Run for two seconds with appearance set to 'system',
// that shape executed 86,985 times and sent 86,985 messages to the drawer. The
// main process had nothing left with which to handle the click that would have
// changed the appearance -- and 'system' is the default, so this began at
// launch on every Mac and never stopped.
//
// The fake nativeTheme below reproduces exactly that: assigning 'system' emits
// even when nothing changed, assigning anything else only emits on a change.
const fs = require('fs');
const path = require('path');
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

// A hard cap, because the bug being tested for is unbounded: without this a
// regression hangs the suite instead of failing it.
const RUNAWAY = 500;

function makeWorld(appearance) {
  const sent = [];
  const assignments = [];
  let listeners = [];
  let source = 'system';
  let emitted = 0;

  const nativeTheme = {
    get themeSource() { return source; },
    set themeSource(v) {
      assignments.push(v);
      const changed = v !== source;
      source = v;
      // macOS, measured: 'system' emits whether or not anything changed.
      if (changed || v === 'system') {
        if (emitted++ < RUNAWAY) listeners.forEach(fn => fn());
      }
    },
    shouldUseDarkColors: false,
    on(event, fn) { if (event === 'updated') listeners.push(fn); },
  };

  const ctx = {
    nativeTheme,
    settings: { appearance },
    mainWindow: { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push({ ch, payload }) } },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(ctx);
  vm.runInContext([
    lift('function appearanceChoice('),
    lift("let lastAppearanceSent = '';"),
    lift('function notifyAppearance('),
    lift('function applyAppearance('),
    lift('function setAppearance('),
  ].join('\n')
    // saveSettings and refreshTrayMenu are somebody else's suite
    + '\nfunction saveSettings() {}\nfunction refreshTrayMenu() {}'
    + '\nthis.api = { applyAppearance, notifyAppearance, setAppearance };', ctx);

  // The handler main installs at startup, lifted verbatim so the test is about
  // the app's wiring rather than about a copy of it.
  const handlerBody = MAIN.slice(MAIN.indexOf("nativeTheme.on('updated', () => {"));
  vm.runInContext(handlerBody.slice(0, handlerBody.indexOf('});') + 3), ctx);

  return { ctx, sent, assignments, nativeTheme };
}

// ---------- the loop ----------
{
  const w = makeWorld('system');
  w.ctx.api.applyAppearance();
  ok('choosing to follow the system does not feed itself',
     w.assignments.length < 5, w.assignments.length + ' assignments to themeSource');
  ok('and does not flood the drawer',
     w.sent.length < 5, w.sent.length + ' appearance messages');
  ok('the drawer is still told once',
     w.sent.length >= 1 && w.sent[0].payload.choice === 'system',
     JSON.stringify(w.sent[0] && w.sent[0].payload));
}
{
  // The arm that was never broken, so it must stay quiet too.
  const w = makeWorld('light');
  w.ctx.api.applyAppearance();
  ok('and neither does a fixed choice', w.assignments.length === 1, String(w.assignments.length));
}

// ---------- getting back out of system ----------
{
  const w = makeWorld('system');
  w.ctx.api.applyAppearance();       // as at startup
  const before = w.assignments.length;
  const took = w.ctx.api.setAppearance('light');
  ok('light can be chosen while following the system', took === true, String(took));
  ok('and it reaches the OS',
     w.nativeTheme.themeSource === 'light', w.nativeTheme.themeSource);
  ok('and the drawer hears about it',
     w.sent[w.sent.length - 1].payload.choice === 'light',
     JSON.stringify(w.sent[w.sent.length - 1].payload));
  ok('without a storm of assignments on the way',
     w.assignments.length - before <= 2, String(w.assignments.length - before));

  w.ctx.api.setAppearance('dark');
  ok('and dark after it', w.nativeTheme.themeSource === 'dark', w.nativeTheme.themeSource);
  w.ctx.api.setAppearance('system');
  ok('and back to following the system', w.nativeTheme.themeSource === 'system', w.nativeTheme.themeSource);
  ok('with the cycle still bounded', w.assignments.length < 12, String(w.assignments.length));
}

// ---------- what the handler is allowed to do ----------
{
  const w = makeWorld('system');
  w.ctx.api.applyAppearance();
  const assignmentsBefore = w.assignments.length;
  const sentBefore = w.sent.length;
  // The OS itself flipping, which is the event this handler exists for.
  w.nativeTheme.shouldUseDarkColors = true;
  w.nativeTheme.themeSource = 'system';   // how macOS announces it
  ok('an OS flip tells the drawer',
     w.sent.length > sentBefore && w.sent[w.sent.length - 1].payload.dark === true,
     JSON.stringify(w.sent[w.sent.length - 1] && w.sent[w.sent.length - 1].payload));
  ok('and the handler assigns nothing of its own',
     w.assignments.length === assignmentsBefore + 1, // the one this test made
     `${w.assignments.length - assignmentsBefore} assignments after one event`);
}
{
  // A choice that is not 'system' means the OS flipping is not our business.
  const w = makeWorld('dark');
  w.ctx.api.applyAppearance();
  const sentBefore = w.sent.length;
  w.nativeTheme.shouldUseDarkColors = true;
  w.nativeTheme.themeSource = 'system';
  ok('an OS flip under a fixed choice changes nothing',
     w.sent.length === sentBefore, String(w.sent.length - sentBefore));
}

// ---------- and the shape, so it cannot come back ----------
ok('themeSource is only assigned when it actually changes',
   /if \(nativeTheme\.themeSource !== choice\) nativeTheme\.themeSource = choice;/.test(MAIN), '');
ok('and the updated handler notifies rather than applies',
   /nativeTheme\.on\('updated'[\s\S]{0,200}notifyAppearance\(\)/.test(MAIN)
   && !/nativeTheme\.on\('updated'[\s\S]{0,200}applyAppearance\(\)/.test(MAIN), '');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

// What happens when a renderer dies.
//
// Before this existed, nothing noticed. Killing every renderer of a healthy
// instance left the main process running, the tray sitting there and the
// shortcut still registered, with not one line logged — the drawer would open
// as a window with nothing in it while clipboard polling carried on behind it.
// The person keeps copying and finds out later.
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
  const firstLine = rest.slice(0, rest.indexOf('\n'));
  if (firstLine.trimEnd().endsWith(';')) return firstLine;
  const m = rest.match(/\n(\}|\];|\};)/);
  return rest.slice(0, m.index + m[0].length);
}

// A window that can be crashed on demand, standing in for a real one.
function fakeWindow() {
  const handlers = {};
  let reloads = 0;
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    destroy() { destroyed = true; },
    webContents: {
      on(event, fn) { handlers[event] = fn; },
      reload() { reloads++; },
    },
    crash(reason = 'crashed', exitCode = -1) {
      handlers['render-process-gone'](null, { reason, exitCode });
    },
    hang() { handlers['unresponsive'](); },
    get reloads() { return reloads; },
  };
}

function freshContext() {
  const ctx = { console: { log() {}, error() {} }, Date, Math, Map, Number, String };
  vm.createContext(ctx);
  vm.runInContext([
    lift('const crashLog = [];'),
    lift('function noteCrash('),
    lift('const RELOAD_LIMIT ='),
    lift('const RELOAD_WINDOW_MS ='),
    lift('const reloadTimes = new Map();'),
    lift('function watchForCrashes('),
  ].join('\n') + '\nthis.watchForCrashes = watchForCrashes; this.crashLog = crashLog;', ctx);
  return ctx;
}

// ---------- a crash is noticed and recovered ----------
{
  const ctx = freshContext();
  const win = fakeWindow();
  ctx.watchForCrashes(win, 'drawer');

  ok('nothing is wrong before anything crashes', ctx.crashLog.length === 0, '');
  win.crash();
  ok('a dead renderer is noticed', ctx.crashLog.length === 1, ctx.crashLog.length + '');
  ok('and the window is brought back', win.reloads === 1, win.reloads + '');
  ok('the record says which window it was',
     /drawer/.test(ctx.crashLog[0].what), ctx.crashLog[0].what);
  ok('and why it went', /crashed/.test(ctx.crashLog[0].detail), ctx.crashLog[0].detail);
}

// ---------- a window closed on purpose is not a crash ----------
{
  const ctx = freshContext();
  const win = fakeWindow();
  ctx.watchForCrashes(win, 'drawer');
  win.crash('clean-exit', 0);
  ok('closing a window does not trigger a reload', win.reloads === 0, win.reloads + '');
}

// ---------- a destroyed window is left alone ----------
{
  const ctx = freshContext();
  const win = fakeWindow();
  ctx.watchForCrashes(win, 'drawer');
  win.destroy();
  win.crash();
  ok('a window that is already gone is not reloaded', win.reloads === 0, win.reloads + '');
}

// ---------- and it does not reload for ever ----------
// A window whose renderer keeps dying will keep dying. Reloading it in a loop
// burns CPU, hides the problem, and is worse than stopping.
{
  const ctx = freshContext();
  const win = fakeWindow();
  ctx.watchForCrashes(win, 'drawer');
  for (let i = 0; i < 6; i++) win.crash();
  ok('reloading stops after a few tries in quick succession',
     win.reloads === 3, win.reloads + ' reloads');
  ok('and giving up is recorded rather than being silent',
     ctx.crashLog.some(c => /keeps crashing/.test(c.what)),
     ctx.crashLog.map(c => c.what).join(' | '));
}

// ---------- a window that stops responding ----------
{
  const ctx = freshContext();
  const win = fakeWindow();
  ctx.watchForCrashes(win, 'drawer');
  win.hang();
  ok('a hung window is recorded too',
     ctx.crashLog.some(c => /stopped responding/.test(c.what)), '');
  ok('but hanging is not a crash, so it is not reloaded out from under itself',
     win.reloads === 0, win.reloads + '');
}

// ---------- both windows are watched, and the app says so ----------
ok('the drawer is watched', MAIN.includes("watchForCrashes(mainWindow, 'drawer')"), '');
ok('and so is the quick dock', MAIN.includes("watchForCrashes(dockWindow, 'quick dock')"), '');
ok('an error escaping the main process does not take the tray with it',
   MAIN.includes("process.on('uncaughtException'") && MAIN.includes("process.on('unhandledRejection'"), '');
ok('a dead GPU or utility process is attributed',
   MAIN.includes("app.on('child-process-gone'"), '');
// This is what gets pasted back when someone says it stopped working.
ok('diagnostics reports crashes, and says so when there were none',
   MAIN.includes('crashes: none since launch') && MAIN.includes('crashes: ${crashLog.length} since launch'), '');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

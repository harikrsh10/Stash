// Which screen the drawer opens on, and stays on. A drawer dragged onto a
// second monitor used to snap back to the built-in display the moment the
// inspector opened, because the bounds were always computed from
// getPrimaryDisplay. These run the real functions from main.js against faked
// displays, since a test machine has one screen.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const grab = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// a laptop on the left, a taller monitor to its right
const LAPTOP = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
const MONITOR = { id: 2, workArea: { x: 1440, y: -300, width: 2560, height: 1440 } };

const inside = (p, d) => p.x >= d.workArea.x && p.x < d.workArea.x + d.workArea.width
                      && p.y >= d.workArea.y && p.y < d.workArea.y + d.workArea.height;

const ctx = {
  console,
  DRAWER_W: 466,
  INSPECTOR_W: 520,
  mainWindow: null,
  cursor: { x: 200, y: 200 },
  screen: {
    getPrimaryDisplay: () => LAPTOP,
    getAllDisplays: () => [LAPTOP, MONITOR],
    getCursorScreenPoint: () => ctx.cursor,
    getDisplayNearestPoint: (p) => inside(p, MONITOR) ? MONITOR : LAPTOP,
  },
};
vm.createContext(ctx);
vm.runInContext([grab('drawerDisplay'), grab('drawerBounds')].join(String.fromCharCode(10))
  + String.fromCharCode(10) + 'this.api = { drawerDisplay, drawerBounds };', ctx);
const { drawerDisplay, drawerBounds } = ctx.api;

// ---------- sizing to a screen ----------
const onLaptop = drawerBounds(LAPTOP);
ok('the drawer is as tall as the screen it is on', onLaptop.height === 900, String(onLaptop.height));
ok('and welded to that screen right edge', onLaptop.x + onLaptop.width === 1440,
   String(onLaptop.x + onLaptop.width));

const onMonitor = drawerBounds(MONITOR);
ok('a taller screen gets a taller drawer', onMonitor.height === 1440, String(onMonitor.height));
ok('welded to that screen right edge too', onMonitor.x + onMonitor.width === 4000,
   String(onMonitor.x + onMonitor.width));
ok('and starts at that screen top, not at zero', onMonitor.y === -300, String(onMonitor.y));
ok('width is the same on either screen', onLaptop.width === onMonitor.width,
   onLaptop.width + ' vs ' + onMonitor.width);

// ---------- room for the panel, always ----------
// The window is wide enough for the side panel whether or not it is showing,
// so opening one never changes the window. It is welded to the right edge,
// which is the half the drawer occupies; the other half is transparent.
ok('there is room for the panel without resizing',
   onMonitor.width === 466 + 520, String(onMonitor.width));
ok('and the drawer half still lands on the screen edge',
   onMonitor.x + onMonitor.width === 4000, String(onMonitor.x + onMonitor.width));

// ---------- which screen ----------
ctx.cursor = { x: 200, y: 200 };
ok('with no window up, it follows the pointer to the laptop',
   drawerDisplay(true).id === 1, String(drawerDisplay(true).id));
ctx.cursor = { x: 2000, y: 100 };
ok('and to the monitor', drawerDisplay(true).id === 2, String(drawerDisplay(true).id));

// a drawer parked on the monitor, with the pointer back on the laptop
ctx.mainWindow = {
  isDestroyed: () => false,
  isVisible: () => true,
  getBounds: () => drawerBounds(MONITOR),
};
ctx.cursor = { x: 200, y: 200 };
ok('an open drawer stays on its own screen, wherever the pointer is',
   drawerDisplay(false).id === 2, String(drawerDisplay(false).id));
ok('which is what stops expanding from teleporting it home',
   drawerBounds(drawerDisplay(false), true).x + drawerBounds(drawerDisplay(false), true).width === 4000, '');

// hidden, it comes back to wherever you are working
ctx.mainWindow.isVisible = () => false;
ok('a hidden drawer is summoned to the pointer instead',
   drawerDisplay(false).id === 1, String(drawerDisplay(false).id));

// One width, always. The window used to grow leftward when a panel opened,
// and reading back whether it had was where a fractional display scale bit:
// 466 came back as 468 and a collapsed drawer reported itself expanded. None
// of that exists to get wrong now — asking for the bounds twice gets the same
// answer whatever the panel is doing.
const a = drawerBounds(MONITOR);
const b = drawerBounds(MONITOR);
ok('the drawer has one width', a.width === 466 + 520, String(a.width));
ok('and asking again gives the same window',
   a.x === b.x && a.width === b.width, JSON.stringify(a));
ok('welded to the right edge of its screen',
   a.x + a.width === MONITOR.workArea.x + MONITOR.workArea.width, String(a.x));

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
}
console.log(String.fromCharCode(10) + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

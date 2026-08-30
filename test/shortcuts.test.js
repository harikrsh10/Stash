// A global shortcut belongs to whichever app asked for it first, so another
// app -- or a second copy of Stash -- can simply have it. Registering then
// fails with a plain false, and until this was fixed that false went nowhere
// except a console line: every press of the key did nothing, and the app
// looked broken with no way to tell why. An afternoon went into exactly that,
// with a packaged copy holding the key while a dev build was being "fixed".
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// Lift a declaration out of main.js by finding where it starts and where its
// body closes at column 0. Done by index rather than by regex: the escaping in
// a pattern that has to match braces and newlines is its own small hazard.
function lift(opening) {
  const at = MAIN.indexOf(opening);
  if (at === -1) throw new Error('could not find ' + opening + ' in main.js');
  const end = MAIN.indexOf('\n}', at);
  if (end === -1) throw new Error('could not find the end of ' + opening);
  return MAIN.slice(at, end + 2);
}

// The keys are configurable now, so the message is built from whatever is
// actually in force rather than read off a constant.
const KEYS = { drawer: 'CommandOrControl+Shift+V', dock: 'CommandOrControl+Shift+Space' };
function contextFor(platform) {
  const ctx = { process: { platform } };
  vm.createContext(ctx);
  vm.runInContext(
    lift('const DEFAULT_SHORTCUTS = ') + '\n'
    + lift('function humanAccelerator(') + '\n'
    + lift('function shortcutTrouble(')
    + '\nthis.shortcutTrouble = shortcutTrouble;', ctx);
  return ctx;
}
const ctx = contextFor('win32');
const trouble = (state) => ctx.shortcutTrouble({ ...state, keys: KEYS });

// nothing to say when both are held
ok('holding both shortcuts is not worth reporting',
   trouble({ drawer: true, dock: true }) === null, '');

const drawerLost = trouble({ drawer: false, dock: true });
ok('a lost drawer shortcut is reported', !!drawerLost, '');
ok('and it names the key, so it can be hunted down in the other app',
   drawerLost.label.includes('Ctrl+Shift+V'), drawerLost.label);
ok('the notification says what stopped working',
   /will not open Stash/.test(drawerLost.body), drawerLost.body);
// The whole point: the key is gone, so the way in has to be somewhere else.
ok('and points at the way in that still works',
   /tray/i.test(drawerLost.body), drawerLost.body);
ok('it does not mention the shortcut that is fine',
   !drawerLost.label.includes('Space') && !drawerLost.body.includes('Space'),
   drawerLost.label + ' / ' + drawerLost.body);

const dockLost = trouble({ drawer: true, dock: false });
ok('a lost dock shortcut is reported on its own', !!dockLost, '');
ok('naming the dock key rather than the drawer one',
   dockLost.label.includes('Ctrl+Shift+Space') && !dockLost.label.includes('Shift+V'),
   dockLost.label);

const bothLost = trouble({ drawer: false, dock: false });
ok('losing both says so once rather than twice',
   /both/i.test(bothLost.label), bothLost.label);
ok('and still names both keys',
   bothLost.body.includes('Ctrl+Shift+V') && bothLost.body.includes('Ctrl+Shift+Space'),
   bothLost.body);

// CommandOrControl is the right thing to register and the wrong thing to show:
// nobody has that key on their keyboard.
const mac = contextFor('darwin');
const macLost = mac.shortcutTrouble({ drawer: false, dock: true, keys: KEYS });
ok('a Mac is told about the key a Mac actually has',
   macLost.label.includes('Cmd+Shift+V'), macLost.label);

// A key someone chose themselves has to come back out the same way, or the
// warning names a shortcut they never set.
const chosen = { drawer: 'CommandOrControl+Alt+K', dock: KEYS.dock };
const chosenLost = ctx.shortcutTrouble({ drawer: false, dock: true, keys: chosen });
ok('a chosen key is what gets reported, not the shipped one',
   chosenLost.label.includes('Ctrl+Alt+K'), chosenLost.label);

// The tray is the only way in once the key is gone, so it must not go on
// advertising a key it does not hold — that is the app telling you to press
// something that does nothing.
ok('the tray stops advertising a shortcut it lost',
   MAIN.includes('...(shortcutState.drawer ? { accelerator:'), '');
ok('and offers to try claiming it again',
   MAIN.includes('Try to claim it again'), '');

// Warning on every health check would be worse than not warning at all:
// registerShortcuts runs every 30 seconds, on resume, on unlock and on a
// display change.
ok('the warning fires on the way into trouble, not every 30 seconds',
   MAIN.includes('if (trouble && !warnedAboutShortcuts)'), '');
ok('and arms again once the key comes back',
   MAIN.includes('if (!trouble) warnedAboutShortcuts = false;'), '');

// A notification that never appears looks exactly like one that was never
// raised — and this is precisely the moment someone is trying to work out why
// nothing works, so the log has to carry it too.
ok('the warning is logged as well as shown',
   MAIN.includes('console.warn(`[Stash] ${trouble.label}'), '');
ok('and a notification that cannot be raised says so rather than vanishing',
   MAIN.includes('notifications are not available to say so')
   && MAIN.includes('could not raise the shortcut notification'), '');

// what gets pasted back when someone says "nothing happens"
ok('diagnostics says whether the shortcuts are held',
   MAIN.includes('TAKEN BY ANOTHER APP'), '');

// Windows attributes a notification to whoever claims the id; without this it
// arrives as the runtime rather than as Stash.
ok('the notification comes from Stash, not from electron',
   MAIN.includes("app.setAppUserModelId('com.harikrish.stash')"), '');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

// Where an app's logo comes from, and the two ways it can be a picture of
// nothing.
//
// Reported from a Mac: no app showed a logo. The row did not fall back to the
// name either -- it showed a small grey square, which is what an <img> looks
// like when the picture is there and is not the app's.
//
// That rules out the obvious reading. A missing icon shows a name; a square
// means getFileIcon answered, and answered with something. It does: for a path
// macOS cannot place it hands back the generic blank icon rather than failing,
// and a generic icon is a real, non-empty image. isEmpty() is false, so it was
// remembered as though it were the logo -- once, permanently, for every app.
//
// So the fix is not "handle the failure" but "notice that the success is not
// one", and the second half is a route to the bundle that does not depend on
// lsappinfo answering at all: the name. Mac apps are named after themselves and
// live in about six places.
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

// ---------- a Mac, in a temp directory ----------
const ROOT = path.join(os.tmpdir(), 'stash-icons-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const APPS = path.join(ROOT, 'Applications');
const SYSAPPS = path.join(ROOT, 'System', 'Applications');
const TEMP = path.join(ROOT, 'tmp');
for (const d of [APPS, SYSAPPS, TEMP]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(APPS, 'Figma.app'));
fs.mkdirSync(path.join(SYSAPPS, 'Terminal.app'));
// the shape that needs the second pass: an app inside a folder of its own
fs.mkdirSync(path.join(APPS, 'Microsoft Office', 'Word.app'), { recursive: true });
// something that is not an app bundle, sitting where one would be
fs.writeFileSync(path.join(APPS, 'notes.txt'), 'not an app');

// What macOS actually hands back. The generics are what every path it cannot
// place resolves to, and they differ by the shape of the path -- a bare name, an
// unknown extension, and a bundle that is not there.
const GENERIC_FILE = 'data:image/png;base64,' + 'R'.repeat(900);
const GENERIC_UNKNOWN = 'data:image/png;base64,' + 'U'.repeat(900);
const GENERIC_APP = 'data:image/png;base64,' + 'G'.repeat(900);
const FIGMA = path.join(APPS, 'Figma.app');
const TERMINAL = path.join(SYSAPPS, 'Terminal.app');
const WORD = path.join(APPS, 'Microsoft Office', 'Word.app');
const REAL = {
  [FIGMA]: 'data:image/png;base64,' + 'F'.repeat(1200),
  [TERMINAL]: 'data:image/png;base64,' + 'T'.repeat(1200),
  [WORD]: 'data:image/png;base64,' + 'W'.repeat(1200),
};

function makeWorld(opts = {}) {
  const asked = [];
  const saves = { count: 0 };
  const image = (url) => ({ isEmpty: () => !url, toDataURL: () => url });

  const ctx = {
    fs, path,
    console: { log() {}, warn() {}, error() {} },
    process: { platform: 'darwin' },
    sourceIcons: opts.sourceIcons || {},
    // The bundle route has a suite of its own (icns.test.js); what is under test
    // here is what happens when it comes back with nothing, which on a Mac that
    // ships only pre-10.7 icons is the case that falls through to the OS.
    iconFromBundle: opts.iconFromBundle || (async () => null),
    saveSourceIcons: () => { saves.count++; },
    broadcastState: () => {},
    app: {
      getPath: (which) => (which === 'temp' ? TEMP : ROOT),
      getFileIcon: async (p) => {
        asked.push(p);
        if (opts.getFileIcon) {
          const forced = opts.getFileIcon(p);
          if (forced !== undefined) return image(forced);
        }
        if (REAL[p]) return image(REAL[p]);
        // Everything else is a path macOS cannot place, which is not an error.
        if (p.endsWith('.app')) return image(GENERIC_APP);
        if (path.extname(p)) return image(GENERIC_UNKNOWN);
        return image(GENERIC_FILE);
      },
    },
  };
  vm.createContext(ctx);

  // MAC_APP_DIRS is absolute by nature, so the test moves it rather than
  // building a fake /Applications on the machine running the suite.
  const dirs = lift('const MAC_APP_DIRS')
    .replace(/\[[\s\S]*\]/, JSON.stringify([APPS, SYSAPPS]));

  vm.runInContext([
    lift('let genericIcons = null;'),
    lift('async function genericIconSet('),
    lift('let sweptGenericIcons = false;'),
    lift('async function dropRememberedGenericIcons('),
    lift('function usableAppPath('),
    dirs,
    lift('function findAppBundle('),
    lift('const iconMisses = new Set();'),
    lift('async function iconFor('),
  ].join('\n') + '\nthis.api = { iconFor, findAppBundle, usableAppPath, genericIconSet };', ctx);

  return { ctx, asked, saves };
}

(async () => {
  // ---------- the generic icon is not an answer ----------
  {
    const w = makeWorld();
    const icon = await w.ctx.api.iconFor('Figma', FIGMA);
    ok('a real app keeps its own logo', icon === REAL[FIGMA], String(icon).slice(0, 30));
    ok('and it is written down', w.ctx.sourceIcons['Figma'] === icon, '');
    ok('a real logo is not mistaken for a generic one',
       !(await w.ctx.api.genericIconSet()).has(icon), '');
  }
  {
    // An app whose bundle path has gone stale: the path is a .app, it is simply
    // not there any more. This is the case that produced the grey square.
    const w = makeWorld();
    const icon = await w.ctx.api.iconFor('Ghost App', path.join(APPS, 'Ghost App.app'));
    ok('a bundle that is not there gives no icon', icon === null, String(icon).slice(0, 30));
    ok('and the generic icon it resolves to is not kept',
       !('Ghost App' in w.ctx.sourceIcons), JSON.stringify(Object.keys(w.ctx.sourceIcons)));
    // The miss is in memory, not on disk: a store full of remembered misses is
    // what made the first version of this permanent.
    ok('nothing was saved for it', w.saves.count === 0, String(w.saves.count));
  }
  {
    // The other way a placeholder reaches a row: a data URL with nothing in it.
    const w = makeWorld({ getFileIcon: (p) => (p === FIGMA ? 'data:image/png;base64,' : undefined) });
    const icon = await w.ctx.api.iconFor('Figma', FIGMA);
    ok('an empty data url is refused too', icon === null, String(icon));
  }

  // ---------- a store already full of generic icons ----------
  {
    const w = makeWorld({ sourceIcons: { Figma: GENERIC_APP, Notion: GENERIC_APP, Arc: GENERIC_FILE } });
    // Everyone upgrading has one of these, and nothing would ever ask again:
    // the store says the answer is known.
    const icon = await w.ctx.api.iconFor('Figma', FIGMA);
    ok('an icon remembered from before the check is dropped',
       icon === REAL[FIGMA], String(icon).slice(0, 30));
    ok('and so are the others, in one sweep',
       !('Notion' in w.ctx.sourceIcons) && !('Arc' in w.ctx.sourceIcons),
       JSON.stringify(Object.keys(w.ctx.sourceIcons)));
    ok('the sweep happens once, not per lookup',
       vm.runInContext('sweptGenericIcons', w.ctx) === true, '');
  }

  // ---------- the bundle answers first ----------
  {
    const OWN = 'data:image/png;base64,' + 'B'.repeat(1400);
    const w = makeWorld({ iconFromBundle: async () => OWN });
    const icon = await w.ctx.api.iconFor('Figma', FIGMA);
    ok('an icon read out of the bundle is the one used', icon === OWN, String(icon).slice(0, 24));
    ok('and the icon service is not asked at all',
       !w.asked.some(p => p === FIGMA), w.asked.join(' '));
  }
  {
    // Seven copies of Xcode really do share an icon, and this route reads what
    // each app declares for itself -- so agreeing is not evidence of a
    // placeholder the way it is when the OS is doing the answering.
    const SHARED = 'data:image/png;base64,' + 'X'.repeat(1400);
    const w = makeWorld({ iconFromBundle: async () => SHARED });
    await w.ctx.api.iconFor('Xcode', FIGMA);
    const second = await w.ctx.api.iconFor('Xcode 26.5', TERMINAL);
    ok('two apps that genuinely share an icon both keep it', second === SHARED, String(second).slice(0, 24));
    ok('and neither is taken back',
       Object.keys(w.ctx.sourceIcons).length === 2, JSON.stringify(Object.keys(w.ctx.sourceIcons)));
  }

  // ---------- two apps cannot have the same logo ----------
  // Asked on a real Mac: getFileIcon returned one identical picture for
  // Terminal, TextEdit, Calculator, Chrome and Firefox. That picture is not the
  // one an unplaceable path returns, so the learned set never matches it and
  // 0.7.4's check did nothing. A collision needs nothing learned in advance.
  {
    const SAME = 'data:image/png;base64,' + 'S'.repeat(1200);
    // only the real bundles: the probes must still answer as they would,
    // or SAME lands in the learned generic set and the collision never happens
    const w = makeWorld({ getFileIcon: (p) => (p.includes('stash-icon-probe') ? undefined : SAME) });
    const first = await w.ctx.api.iconFor('Terminal', TERMINAL);
    ok('the first app is believed, there being nothing to compare it against',
       first === SAME, String(first).slice(0, 24));
    const second = await w.ctx.api.iconFor('Figma', FIGMA);
    ok('a second app with the identical picture is refused', second === null, String(second));
    ok('and the first one is taken back, because it was never a logo either',
       !('Terminal' in w.ctx.sourceIcons), JSON.stringify(Object.keys(w.ctx.sourceIcons)));
    ok('a third app is refused without having to collide again',
       (await w.ctx.api.iconFor('Word', WORD)) === null, '');
  }
  {
    // The store everyone upgrading has: every app pointing at one picture, and
    // nothing that would ever ask again.
    const dupe = 'data:image/png;base64,' + 'D'.repeat(1000);
    const w = makeWorld({ sourceIcons: { Notion: dupe, Arc: dupe, Slack: dupe } });
    await w.ctx.api.iconFor('Figma', FIGMA);
    ok('a store already full of one repeated picture is swept',
       !('Notion' in w.ctx.sourceIcons) && !('Arc' in w.ctx.sourceIcons)
       && !('Slack' in w.ctx.sourceIcons),
       JSON.stringify(Object.keys(w.ctx.sourceIcons)));
    ok('and the real logo found afterwards is kept',
       w.ctx.sourceIcons['Figma'] === REAL[FIGMA], '');
  }

  // ---------- the second route: the name ----------
  {
    const w = makeWorld();
    // lsappinfo said nothing at all, which is how the Mac in question behaved.
    const icon = await w.ctx.api.iconFor('Terminal', null);
    ok('an app with no path is still found by its name',
       icon === REAL[TERMINAL], String(icon).slice(0, 30));
  }
  {
    const w = makeWorld();
    const icon = await w.ctx.api.iconFor('Word', '');
    ok('including one that lives inside a folder of its own',
       icon === REAL[WORD], String(icon).slice(0, 30));
  }
  {
    const w = makeWorld();
    const icon = await w.ctx.api.iconFor('Some Private Tool', null);
    ok('an app that is nowhere standard shows its name instead', icon === null, String(icon));
  }

  // ---------- what is worth asking about ----------
  {
    const w = makeWorld();
    ok('a path that is not there is not asked about',
       w.ctx.api.usableAppPath(path.join(APPS, 'Nope.app')) === null, '');
    ok('nor a file that is not a bundle',
       w.ctx.api.usableAppPath(path.join(APPS, 'notes.txt')) === null, '');
    ok('a real bundle is', w.ctx.api.usableAppPath(FIGMA) !== null, '');
    ok('and nothing at all is not', w.ctx.api.usableAppPath(null) === null, '');
  }
  {
    // The bundle it names must be asked about, not the stale one it was given.
    const w = makeWorld();
    await w.ctx.api.iconFor('Terminal', path.join(APPS, 'Wrong Place.app'));
    ok('a stale path does not stop the name being tried',
       w.asked.includes(TERMINAL),
       w.asked.filter(p => p.endsWith('.app')).join(' '));
  }

  // ---------- and the shape of it, so it cannot regress ----------
  ok('the generic icons are learned rather than guessed at',
     /stash-icon-probe/.test(MAIN) && /\$\{stem\}\.app/.test(MAIN), '');
  ok('a row whose icon will not load falls back to the name',
     /addEventListener\('error'[\s\S]{0,400}from-icon/.test(
       fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.html'), 'utf8')), '');

  fs.rmSync(ROOT, { recursive: true, force: true });

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();

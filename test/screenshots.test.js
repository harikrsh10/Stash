// macOS drops screenshots into a folder instead of onto the clipboard, so the
// ones people actually take never reach Stash. This covers the watching side:
// the settle-before-reading rule, what counts as a screenshot, and the wiring
// that keeps it off until someone asks for it.
//
// Pure node. The timing logic runs against real files in a temp directory —
// the failure it exists to prevent is reading a PNG mid-write, which no amount
// of mocking would reproduce honestly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');
const grab = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};

const ctx = { console, fs, path, os, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(grab('whenFileSettles') + '\nthis.api={whenFileSettles};', ctx);

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-shot-test-'));
const after = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- waiting for the file to finish being written ----------

  // A file that is still growing must not be read: macOS can publish the
  // directory entry before the bytes are all there, and hashing a half-written
  // PNG stores a broken clip that looks fine until you open it.
  const growing = path.join(TMP, 'growing.png');
  fs.writeFileSync(growing, Buffer.alloc(100));
  let firedAt = null;
  ctx.api.whenFileSettles(growing, () => { firedAt = Date.now(); });

  const startedGrowing = Date.now();
  for (let i = 0; i < 4; i++) {
    await after(150);
    fs.appendFileSync(growing, Buffer.alloc(100));
  }
  ok('a file still being written is not read yet', firedAt === null, String(firedAt));

  await after(700);
  ok('once it stops growing, it is read', firedAt !== null, '');
  ok('and only after it settled, not on first sight',
     firedAt !== null && firedAt - startedGrowing >= 400, String(firedAt - startedGrowing) + 'ms');

  // the ordinary case: written in one go before anyone looks at it
  const settled = path.join(TMP, 'settled.png');
  fs.writeFileSync(settled, Buffer.alloc(2048));
  let quickFired = false;
  ctx.api.whenFileSettles(settled, () => { quickFired = true; });
  await after(700);
  ok('a file that was already complete is read promptly', quickFired, '');

  // a screenshot the user cancels, or a preview file that is swapped out
  const vanishing = path.join(TMP, 'vanishing.png');
  fs.writeFileSync(vanishing, Buffer.alloc(500));
  let vanishFired = false;
  ctx.api.whenFileSettles(vanishing, () => { vanishFired = true; });
  await after(220);
  fs.unlinkSync(vanishing);
  await after(700);
  ok('a file that disappears is quietly dropped', !vanishFired, '');

  // zero bytes is not a picture yet, however long it sits there
  const empty = path.join(TMP, 'empty.png');
  fs.writeFileSync(empty, Buffer.alloc(0));
  let emptyFired = false;
  ctx.api.whenFileSettles(empty, () => { emptyFired = true; });
  await after(800);
  ok('an empty file is never treated as settled', !emptyFired, '');

  // ---------- what counts as a screenshot ----------

  const extMatch = MAIN.match(/const SHOT_EXT = (\/.*\/i);/);
  ok('there is a file-type guard', !!extMatch, '');
  if (extMatch) {
    const re = new RegExp(extMatch[1].slice(1, -2), 'i');
    const yes = ['Screenshot 2026-08-19 at 10.14.02.png', 'Screen Shot.jpg', 'shot.heic', 'shot.PNG'];
    const no = ['notes.txt', 'archive.zip', 'Screenshot.png.download', 'video.mov'];
    ok('image files are accepted', yes.every(f => re.test(f)), yes.filter(f => !re.test(f)).join(' '));
    ok('everything else is ignored', no.every(f => !re.test(f)), no.filter(f => re.test(f)).join(' '));
  }

  // ---------- the wiring ----------

  ok('the watcher is macOS-only',
     /process\.platform !== 'darwin'[\s\S]{0,80}return/.test(MAIN), '');
  // On by default: leaving it off meant the default experience on a Mac was
  // the broken one, and only people who went looking ever got the feature.
  ok('it is on unless someone turns it off',
     /watchScreenshots: true/.test(MAIN), '');
  ok('and can still be turned off from the tray',
     /settings\.watchScreenshots = item\.checked[\s\S]{0,400}stopScreenshotWatcher\(\)/.test(MAIN), '');
  ok('toggling it on starts the watcher there and then',
     /settings\.watchScreenshots[\s\S]{0,200}startScreenshotWatcher\(\)/.test(MAIN), '');

  // The cost of defaulting on is a permission prompt, and some people will say
  // no. That has to be survivable rather than fatal — the folder read and the
  // watch both sit inside their own try/catch, and the app carries on either way.
  ok('a refused folder does not take the app down',
     /try \{[\s\S]{0,80}fs\.readdirSync\(dir\)[\s\S]{0,220}catch \(err\)[\s\S]{0,160}return;/.test(MAIN), '');
  ok('and neither does a watch that cannot be established',
     /screenshotWatcher = fs\.watch\([\s\S]{0,400}catch \(err\)/.test(MAIN), '');
  ok('the toggle only appears on macOS',
     /process\.platform === 'darwin' \? \[\{[\s\S]{0,200}watchScreenshots/.test(MAIN), '');

  ok('files already in the folder are not swept up',
     /readdirSync\(dir\)\.forEach\(f => seenShots\.add/.test(MAIN), '');
  ok('a screenshot is only handled once',
     /seenShots\.has\(filepath\)\)\s*return;[\s\S]{0,40}seenShots\.add\(filepath\)/.test(MAIN), '');
  ok('only files macOS named as a screenshot are considered',
     /!filename\.startsWith\(prefix\)\)\s*return/.test(MAIN), '');

  ok('pausing capture pauses screenshots too',
     /whenFileSettles\(filepath, \(\) => \{[\s\S]{0,120}if \(isPaused\) return/.test(MAIN), '');

  ok('the folder and the name are read from macOS, not assumed',
     /defaults', \['read', 'com\.apple\.screencapture'/.test(MAIN), '');
  ok('a tilde in the configured path is expanded',
     /dir\.startsWith\('~'\)/.test(MAIN), '');
  ok('an unset preference falls back to the documented default',
     /readPref\('location', path\.join\(os\.homedir\(\), 'Desktop'\)\)/.test(MAIN), '');

  ok('the watcher is torn down on quit',
     /will-quit[\s\S]{0,200}stopScreenshotWatcher\(\)/.test(MAIN), '');
  ok('it starts at launch, so the setting survives a restart',
     /registerShortcuts\(\);[\s\S]{0,200}startScreenshotWatcher\(\)/.test(MAIN), '');

  // ---------- one way in for pictures ----------
  // A screenshot has to behave like a copied image: same de-duplication, same
  // promote-on-recopy, same session collection. Two code paths would drift.
  ok('there is a single ingest path for images',
     /function ingestImage\(png\)/.test(MAIN), '');
  ok('the clipboard poller uses it',
     /lastSig = sig;\s*\n\s*ingestImage\(png\);/.test(MAIN), '');
  ok('the screenshot watcher uses it too',
     /if \(png && png\.length\) ingestImage\(png\)/.test(MAIN), '');
  ok('ingest still promotes an image that is already pinned',
     /function ingestImage[\s\S]{0,700}pinned\.findIndex\(p => p\.id === sig\)/.test(MAIN), '');
  ok('and one already in history',
     /function ingestImage[\s\S]{0,900}history\.findIndex\(h => h\.id === sig\)/.test(MAIN), '');

  // ---------- the permission strings the folder access needs ----------
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const info = (pkg.build && pkg.build.mac && pkg.build.mac.extendInfo) || {};
  ok('Info.plist explains why Stash reads the Desktop',
     typeof info.NSDesktopFolderUsageDescription === 'string' && info.NSDesktopFolderUsageDescription.length > 20,
     info.NSDesktopFolderUsageDescription || 'missing');
  ok('and the other folders a screenshot can be sent to',
     !!info.NSDocumentsFolderUsageDescription && !!info.NSDownloadsFolderUsageDescription, '');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();

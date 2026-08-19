// Updates used to mean: notice a new tag, send the user to GitHub, hope they
// come back after fetching 90MB by hand. This covers the pieces that have to
// line up for the app to update itself instead — most of which fail silently
// if they're wrong, which is exactly why they're asserted rather than trusted.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer.html'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-downloads.yml'), 'utf8');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// ---------- the dependency ----------

ok('electron-updater is a runtime dependency, not a dev one',
   !!(PKG.dependencies && PKG.dependencies['electron-updater']),
   JSON.stringify(PKG.dependencies || {}));
ok('and is not also listed as a dev dependency',
   !(PKG.devDependencies && PKG.devDependencies['electron-updater']), '');

// ---------- what the build has to produce ----------
// An update feed nobody publishes is the same as no updater at all.

ok('a publish provider is configured, or no feed is generated',
   Array.isArray(PKG.build.publish) && PKG.build.publish[0].provider === 'github',
   JSON.stringify(PKG.build.publish));
ok('it points at the repo the releases actually go to',
   PKG.build.publish[0].owner === 'harikrsh10' && PKG.build.publish[0].repo === 'Stash',
   JSON.stringify(PKG.build.publish[0]));

const macTargets = (PKG.build.mac.target || []).map(t => t.target || t);
ok('the mac build still ships a dmg for a first install',
   macTargets.includes('dmg'), macTargets.join(' '));
// Squirrel installs from a zip. A release with only a dmg gives the Mac app an
// update it can see and cannot apply — the worst of both.
ok('and a zip, which is the only thing Squirrel can install',
   macTargets.includes('zip'), macTargets.join(' '));
ok('both architectures are covered by both targets',
   (PKG.build.mac.target || []).every(t => Array.isArray(t.arch) && t.arch.includes('x64') && t.arch.includes('arm64')),
   JSON.stringify(PKG.build.mac.target));

// ---------- what CI has to upload ----------

ok('the windows feed is published', /dist\/latest\.yml/.test(WORKFLOW), '');
ok('the mac feed is published', /dist\/latest-mac\.yml/.test(WORKFLOW), '');
ok('the mac zip is published', /dist\/\*\.zip/.test(WORKFLOW), '');
ok('blockmaps go too, so an update is a delta not a whole installer',
   /dist\/\*\.blockmap/.test(WORKFLOW), '');
ok('the installers are still published for people arriving fresh',
   /dist\/\*\.exe/.test(WORKFLOW) && /dist\/\*\.dmg/.test(WORKFLOW), '');

// ---------- the main process ----------

ok('main uses electron-updater', /require\('electron-updater'\)/.test(MAIN), '');
ok('the old hand-rolled tag check is gone',
   !/api\.github\.com\/repos\/harikrsh10\/Stash\/releases\/latest/.test(MAIN), '');
ok('the download happens on its own',
   /autoUpdater\.autoDownload = true/.test(MAIN), '');
ok('an update waiting at quit gets installed then',
   /autoUpdater\.autoInstallOnAppQuit = true/.test(MAIN), '');

for (const ev of ['update-available', 'download-progress', 'update-downloaded', 'error']) {
  ok(`it listens for ${ev}`, new RegExp(`autoUpdater\\.on\\('${ev}'`).test(MAIN), '');
}

// A dev checkout has no packaged app to replace and no feed to read; letting
// the updater run there produces errors that look like real failures.
ok('a dev run does not check for updates',
   /isDev \|\| !app\.isPackaged[\s\S]{0,140}return/.test(MAIN), '');
ok('a failed check is swallowed rather than shown',
   /autoUpdater\.on\('error'[\s\S]{0,220}console\.log/.test(MAIN), '');

ok('restarting into the new version is exposed over ipc',
   /ipcMain\.handle\('update:install'/.test(MAIN), '');
ok('and it refuses when nothing has finished downloading',
   /update:install'[\s\S]{0,160}status !== 'ready'[\s\S]{0,40}return false/.test(MAIN), '');
ok('quitting is what installs it',
   /quitAndInstall\(\)/.test(MAIN), '');
ok('a window opened late can still ask what the state is',
   /ipcMain\.handle\('update:get'/.test(MAIN), '');

// ---------- the bridge ----------

ok('preload exposes installUpdate', /installUpdate:/.test(PRELOAD), '');
ok('preload exposes getUpdateState', /getUpdateState:/.test(PRELOAD), '');

// ---------- the badge ----------

ok('the badge reads the state it is sent', /function showUpdateState/.test(RENDERER), '');
ok('it shows progress while the download runs',
   /state\.percent[\s\S]{0,80}%/.test(RENDERER), '');
ok('it becomes a restart once the update is ready',
   /updateReady[\s\S]{0,120}'restart'/.test(RENDERER), '');
// Clicking mid-download would quit the app for nothing and take the clipboard
// history with it.
ok('clicking does nothing until it is ready',
   /if \(!updateReady\) return;/.test(RENDERER), '');
ok('a window opened after the download still finds out',
   /getUpdateState\(\)\.then\(showUpdateState\)/.test(RENDERER), '');
ok('the badge no longer just opens a browser',
   !/updateUrl/.test(RENDERER), '');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

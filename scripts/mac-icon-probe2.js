// The second round of questions, after the first round found something odd.
//
// Round one: getFileIcon does not fail for a path macOS cannot place -- it
// answers with a generic, and every unplaceable .app path gives the same one,
// so a set of known generics is a workable check. But it also showed Terminal
// and TextEdit coming back byte-identical, which real logos are not. That means
// getFileIcon is handing back a placeholder for real apps too, and a *different*
// placeholder from the one an unplaceable path produces -- so nothing the first
// check learned would ever match it.
//
// So: is there a size that works, and does reading the icns straight out of the
// bundle work instead? That route touches no icon service, no window server and
// no cache. It is just a file.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const out = [];
const say = (s) => out.push(s);
const sha = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 12);

const CANDIDATES = [
  '/System/Applications/Utilities/Terminal.app',
  '/System/Applications/TextEdit.app',
  '/System/Applications/Calculator.app',
  '/Applications/Safari.app',
  '/Applications/Google Chrome.app',
  '/Applications/Firefox.app',
];

// The icon a bundle names for itself. CFBundleIconFile is the old key and the
// one that points at a plain .icns; CFBundleIconName is the newer one and
// points into Assets.car, which is not a file anyone can just read.
function icnsFor(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const read = (key) => {
    try {
      return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist],
        { encoding: 'utf8', timeout: 4000 }).trim();
    } catch (_) { return ''; }
  };
  const named = read('CFBundleIconFile');
  if (named) {
    const file = named.endsWith('.icns') ? named : named + '.icns';
    const full = path.join(appPath, 'Contents', 'Resources', file);
    if (fs.existsSync(full)) return { icns: full, via: 'CFBundleIconFile' };
  }
  // Plenty of apps name no icon file at all and ship exactly one .icns; that is
  // unambiguous enough to use.
  const res = path.join(appPath, 'Contents', 'Resources');
  let icns = [];
  try { icns = fs.readdirSync(res).filter(n => n.endsWith('.icns')); } catch (_) {}
  if (icns.length === 1) return { icns: path.join(res, icns[0]), via: 'the only icns in Resources' };
  if (icns.length > 1) {
    // The one named after the app is the app's own more often than not.
    const base = path.basename(appPath, '.app');
    const match = icns.find(n => n.toLowerCase() === (base + '.icns').toLowerCase());
    if (match) return { icns: path.join(res, match), via: 'named after the app' };
    return { error: `${icns.length} icns files, none obviously the app's (${icns.slice(0, 4).join(', ')})` };
  }
  return { error: 'no icns in the bundle, ' + (named ? 'though it names ' + named : 'and it names none') };
}

app.whenReady().then(async () => {
  const bundles = CANDIDATES.filter(p => fs.existsSync(p));
  say(`apps present on this machine: ${bundles.length}`);

  say('');
  say('=== getFileIcon, at every size it offers ===');
  for (const size of ['small', 'normal', 'large']) {
    const shas = [];
    for (const b of bundles) {
      try {
        const img = await app.getFileIcon(b, { size });
        shas.push({ name: path.basename(b, '.app'), sha: sha(img.toDataURL()), px: img.getSize().width });
      } catch (err) {
        shas.push({ name: path.basename(b, '.app'), sha: 'THREW' });
      }
    }
    const distinct = new Set(shas.map(s => s.sha)).size;
    say(`  ${size}: ${shas.length} apps -> ${distinct} distinct icon(s)`
      + (distinct === shas.length ? '  ALL DIFFERENT' : '  <-- apps sharing an icon is not real logos'));
    shas.forEach(s => say(`      ${s.name}: ${s.sha}${s.px ? ' (' + s.px + 'px)' : ''}`));
  }

  say('');
  say('=== the other route: the icns inside the bundle ===');
  const icnsShas = [];
  for (const b of bundles) {
    const found = icnsFor(b);
    if (found.error) { say(`  ${path.basename(b, '.app')}: ${found.error}`); continue; }
    const img = nativeImage.createFromPath(found.icns);
    if (!img || img.isEmpty()) {
      say(`  ${path.basename(b, '.app')}: found ${path.basename(found.icns)} but it would not decode`);
      continue;
    }
    const url = img.resize({ width: 32, height: 32 }).toDataURL();
    icnsShas.push(sha(url));
    say(`  ${path.basename(b, '.app')}: ${path.basename(found.icns)} via ${found.via},`
      + ` ${img.getSize().width}px source -> ${url.length} chars, sha ${sha(url)}`);
  }
  const distinctIcns = new Set(icnsShas).size;
  say(`  ${icnsShas.length} apps -> ${distinctIcns} distinct icon(s)`
    + (icnsShas.length > 1 && distinctIcns === icnsShas.length
      ? '  ALL DIFFERENT -- this route gives real logos'
      : '  <-- this route does not distinguish them either'));

  say('');
  say('=== how long does that take? ===');
  // It reads a file off disk per app, once, and the answer is remembered. If it
  // is milliseconds it is cheaper than the two shells lsappinfo needs.
  if (bundles.length) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) {
      const f = icnsFor(bundles[0]);
      if (f.icns) nativeImage.createFromPath(f.icns).resize({ width: 32, height: 32 }).toDataURL();
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
    say(`  ${ms.toFixed(1)}ms per app, including reading Info.plist`);
  }

  console.log(out.join('\n'));
  app.exit(0);
});

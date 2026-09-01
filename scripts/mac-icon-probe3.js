// Does reading the icns out of the bundle actually produce real logos?
//
// Round two showed nativeImage.createFromPath returning empty for every .icns
// on the runner, which killed that route -- but createFromPath is being asked
// to decode a container format, not an image. The chunks inside hold PNG
// verbatim. This asks whether handing those bytes straight to createFromBuffer
// works, and whether the six apps then come out as six different pictures.
//
// The bar: every app distinct, and none of them matching what getFileIcon
// returns, since that is known to be a placeholder here.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const icns = require('../src/icns');

const out = [];
const say = (s) => out.push(s);
const sha = (b) => require('crypto').createHash('sha1').update(b).digest('hex').slice(0, 12);

const readPlistIconName = (appPath) => {
  try {
    return execFileSync('/usr/bin/plutil',
      ['-extract', 'CFBundleIconFile', 'raw', '-o', '-',
       path.join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8', timeout: 4000 }).trim();
  } catch (_) { return ''; }
};

app.whenReady().then(async () => {
  const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities'];
  const bundles = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter(n => n.endsWith('.app')); } catch (_) { continue; }
    for (const n of names) bundles.push(path.join(d, n));
  }
  say(`${bundles.length} apps installed on this machine`);

  say('');
  say('=== what is inside an icns ===');
  for (const b of bundles.slice(0, 3)) {
    const p = icns.iconPathFor(b, { readPlistIconName });
    if (!p) { say(`  ${path.basename(b, '.app')}: no icns found`); continue; }
    const buf = fs.readFileSync(p);
    const cs = icns.chunks(buf);
    say(`  ${path.basename(b, '.app')} (${path.basename(p)}, ${(buf.length / 1024).toFixed(0)}KB):`);
    say(`    ${cs.length} chunks: ${cs.map(c => c.type + (icns.isPng(c.data) ? '=png' : '')).join(' ')}`);
  }

  say('');
  say('=== does every app come out with a different picture? ===');
  const seen = new Map();
  let noIcns = 0, noPng = 0, wouldNotDecode = 0, ok = 0;
  const t0 = process.hrtime.bigint();
  for (const b of bundles) {
    const name = path.basename(b, '.app');
    const p = icns.iconPathFor(b, { readPlistIconName });
    if (!p) { noIcns++; continue; }
    let best;
    try { best = icns.bestPng(fs.readFileSync(p)); } catch (_) { best = null; }
    if (!best) { noPng++; continue; }
    const img = nativeImage.createFromBuffer(best.data);
    if (!img || img.isEmpty()) { wouldNotDecode++; continue; }
    const url = img.resize({ width: 32, height: 32 }).toDataURL();
    const key = sha(url);
    seen.set(key, (seen.get(key) || []).concat(name));
    ok++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  say(`  ${ok} icons read, ${seen.size} of them different`);
  say(`  no icns in bundle: ${noIcns}   icns with no png inside: ${noPng}   would not decode: ${wouldNotDecode}`);
  say(`  ${(ms / Math.max(bundles.length, 1)).toFixed(1)}ms per app, ${ms.toFixed(0)}ms for all of them`);
  const shared = [...seen.entries()].filter(([, names]) => names.length > 1);
  if (shared.length) {
    say(`  apps sharing a picture (each pair would lose its logo to the collision check):`);
    shared.slice(0, 8).forEach(([k, names]) => say(`    ${k}: ${names.join(', ')}`));
  } else {
    say('  no two apps share a picture -- every logo is its own');
  }

  say('');
  say('=== and is it a different answer from getFileIcon? ===');
  // getFileIcon is known to be a placeholder here; the new route has to differ
  // from it, or it is the same failure wearing a hat.
  for (const b of bundles.slice(0, 4)) {
    const name = path.basename(b, '.app');
    const viaOs = await app.getFileIcon(b, { size: 'normal' });
    const p = icns.iconPathFor(b, { readPlistIconName });
    const best = p ? icns.bestPng(fs.readFileSync(p)) : null;
    if (!best) { say(`  ${name}: no icns to compare`); continue; }
    const img = nativeImage.createFromBuffer(best.data);
    say(`  ${name}: getFileIcon ${sha(viaOs.toDataURL())}`
      + ` vs icns ${img.isEmpty() ? 'EMPTY' : sha(img.resize({ width: 32 }).toDataURL())}`
      + `  (${best.type}, ${best.size}px source)`);
  }

  console.log(out.join('\n'));
  app.exit(0);
});

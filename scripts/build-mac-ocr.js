#!/usr/bin/env node
// Compiles the macOS OCR helper before packaging. Runs only on macOS; on any
// other platform it is a no-op so the same npm scripts work everywhere.
//
// The binary is small and depends on nothing but system frameworks, so it is
// built during the Mac release rather than committed.
//
// It has to be universal, and for a long time it was not. `npm run dist:mac`
// builds x64 and arm64 from a single run of this script, and package.json
// ships the one file it produces into both as an extraResource. `swiftc` with
// no -target builds for the host, the runners have always been arm64, so the
// Intel app shipped an arm64 helper. macOS refuses to spawn it with EBADARCH,
// which libuv does not map, so it reached the drawer as "spawn Unknown system
// error -86" -- every release with text extraction in it, until 0.7.11.
//
// Hence the check at the bottom: if this ever stops producing both slices the
// build fails here, rather than quietly shipping half a feature again.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.log('[mac-ocr] not macOS, skipping');
  process.exit(0);
}

const src = path.join(__dirname, 'ocr-mac', 'StashOCR.swift');
const outDir = path.join(__dirname, '..', 'build', 'mac');
const out = path.join(outDir, 'stash-ocr');

// arm64 has no macOS before 11; x86_64 matches build.mac.minimumSystemVersion.
const SLICES = [
  { arch: 'arm64', target: 'arm64-apple-macos11' },
  { arch: 'x86_64', target: 'x86_64-apple-macos10.15' },
];

fs.mkdirSync(outDir, { recursive: true });

const parts = [];
for (const slice of SLICES) {
  const part = out + '-' + slice.arch;
  console.log('[mac-ocr] compiling ' + slice.arch + ' from ' + src);
  try {
    execFileSync('swiftc', ['-O', '-target', slice.target, '-o', part, src], { stdio: 'inherit' });
  } catch (err) {
    console.error('[mac-ocr] swiftc failed for ' + slice.arch
      + ' — the Mac build would ship without text extraction on that architecture');
    process.exit(1);
  }
  parts.push(part);
}

console.log('[mac-ocr] joining ' + parts.length + ' slices');
try {
  execFileSync('lipo', ['-create', ...parts, '-output', out], { stdio: 'inherit' });
} catch (err) {
  console.error('[mac-ocr] lipo failed');
  process.exit(1);
}
parts.forEach(p => fs.rmSync(p, { force: true }));

if (!fs.existsSync(out)) {
  console.error('[mac-ocr] no binary produced');
  process.exit(1);
}

// The whole point of the file. Ask the binary what it actually contains rather
// than trusting that the two compiles above did what they were told.
let info = '';
try {
  info = execFileSync('lipo', ['-info', out], { encoding: 'utf8' }).trim();
} catch (err) {
  console.error('[mac-ocr] could not inspect the binary');
  process.exit(1);
}
const missing = SLICES.map(s => s.arch).filter(a => !new RegExp('\\b' + a + '\\b').test(info));
if (missing.length) {
  console.error('[mac-ocr] not universal — missing ' + missing.join(', '));
  console.error('[mac-ocr] lipo said: ' + info);
  process.exit(1);
}

console.log('[mac-ocr] ' + info);
console.log('[mac-ocr] built ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB)');

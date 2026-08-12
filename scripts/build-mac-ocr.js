#!/usr/bin/env node
// Compiles the macOS OCR helper before packaging. Runs only on macOS; on any
// other platform it is a no-op so the same npm scripts work everywhere.
//
// The binary is small and depends on nothing but system frameworks, so it is
// built during the Mac release rather than committed.
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

fs.mkdirSync(outDir, { recursive: true });
console.log('[mac-ocr] compiling ' + src);

try {
  execFileSync('swiftc', ['-O', '-o', out, src], { stdio: 'inherit' });
} catch (err) {
  console.error('[mac-ocr] swiftc failed — the Mac build would ship without text extraction');
  process.exit(1);
}

if (!fs.existsSync(out)) {
  console.error('[mac-ocr] no binary produced');
  process.exit(1);
}
console.log('[mac-ocr] built ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB)');

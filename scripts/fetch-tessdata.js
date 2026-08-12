#!/usr/bin/env node
// Fetches the OCR language data that tesseract.js would otherwise download at
// runtime. Shipping it inside the app is what makes text extraction work with
// no network. It's ~10MB of binary, so it's fetched at build time and kept out
// of git — CI runs this through the same npm scripts a local build does.
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz';
const OUT_DIR = path.join(__dirname, '..', 'assets', 'tessdata');
const OUT = path.join(OUT_DIR, 'eng.traineddata.gz');
const MIN_BYTES = 5 * 1024 * 1024; // a truncated download is worse than none

if (fs.existsSync(OUT) && fs.statSync(OUT).size > MIN_BYTES) {
  console.log('[tessdata] already present, skipping');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('[tessdata] downloading ' + URL);

const tmp = OUT + '.part';
const file = fs.createWriteStream(tmp);

const fail = (msg) => {
  console.error('[tessdata] ' + msg);
  try { fs.unlinkSync(tmp); } catch (_) {}
  process.exit(1);
};

https.get(URL, (res) => {
  if (res.statusCode !== 200) return fail('unexpected status ' + res.statusCode);
  res.pipe(file);
  file.on('finish', () => {
    file.close(() => {
      const size = fs.statSync(tmp).size;
      if (size < MIN_BYTES) return fail(`download too small (${size} bytes)`);
      fs.renameSync(tmp, OUT);
      console.log(`[tessdata] saved ${(size / 1024 / 1024).toFixed(1)}MB to ${OUT}`);
    });
  });
}).on('error', (err) => fail(err.message));

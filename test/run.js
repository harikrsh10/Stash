#!/usr/bin/env node
// Runs every suite and sums up the result. Exits non-zero if any suite fails,
// so `npm test` is usable as a gate.
//
// Most suites need Electron: they load the real renderer.html in a hidden
// window and drive the actual DOM, rather than testing a copy of the logic.
// The pure ones run under plain node and take about a second.
const { spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron'); // resolves to the binary path

const SUITES = [
  { file: 'drag.test.js', runtime: 'node', what: 'drag-out file materialization' },
  { file: 'design.test.js', runtime: 'node', what: 'figma frames, svg and what keeps them intact' },
  { file: 'history.test.js', runtime: 'node', what: 'the history log and what survives a restart' },
  { file: 'durability.test.js', runtime: 'node', what: 'the stores surviving a crash mid-write' },
  { file: 'thumbnails.test.js', runtime: 'node', what: 'previews cached, not stored' },
  { file: 'crashrecovery.test.js', runtime: 'node', what: 'coming back when a renderer dies' },
  { file: 'pollcost.test.js', runtime: 'node', what: 'what watching the clipboard costs when idle' },
  { file: 'ocr-index.test.js', runtime: 'node', what: 'reading the text in pictures, in the background' },
  { file: 'sourceapp.test.js', runtime: 'node', what: 'which app a clip was copied out of' },
  { file: 'imagesearch.test.js', runtime: 'electron', what: 'finding a picture by the words inside it' },
  { file: 'sourcerow.test.js', runtime: 'electron', what: 'the app a clip came from, on the row' },
  { file: 'stack.test.js', runtime: 'electron', what: 'multi-select and the drag stack' },
  { file: 'prompts.test.js', runtime: 'electron', what: 'the prompt library and its store' },
  { file: 'tags.test.js', runtime: 'electron', what: 'prompt editing, tags and tag filtering' },
  { file: 'inspector.test.js', runtime: 'electron', what: 'text extraction and the image inspector' },
  { file: 'palette.test.js', runtime: 'electron', what: 'pulling colours out of an image' },
  { file: 'screenshots.test.js', runtime: 'node', what: 'catching macOS screenshots' },
  { file: 'updates.test.js', runtime: 'node', what: 'updating itself in the background' },
  { file: 'rename.test.js', runtime: 'electron', what: 'naming a clip yourself' },
  { file: 'sessions.test.js', runtime: 'electron', what: 'sessions, their store and the drawer' },
  { file: 'richtext.test.js', runtime: 'electron', what: 'keeping formatting, and pasting without it' },
  { file: 'theme.test.js', runtime: 'node', what: 'the light and dark palettes staying in step' },
  { file: 'order.test.js', runtime: 'electron', what: 'dragging clips into the order you want' },
  { file: 'filters.test.js', runtime: 'electron', what: 'the type filters, colour included' },
  { file: 'panelmotion.test.js', runtime: 'electron', what: 'the drawer holding still while the panel opens' },
  { file: 'displays.test.js', runtime: 'node', what: 'which screen the drawer opens on' },
  { file: 'shortcuts.test.js', runtime: 'node', what: 'saying so when the hotkey is taken' },
  { file: 'settings.test.js', runtime: 'electron', what: 'the settings panel and changing a shortcut' },
  { file: 'keyboard.test.js', runtime: 'electron', what: 'walking the list without a mouse' },
];

const verbose = process.argv.includes('--verbose');
let failed = 0;
let totalPassed = 0;
let totalRun = 0;

for (const suite of SUITES) {
  const cmd = suite.runtime === 'electron' ? electron : process.execPath;
  const res = spawnSync(cmd, [path.join(__dirname, suite.file)], {
    encoding: 'utf8',
    // electron chatters about security warnings and GPU state on stderr
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = (res.stdout || '') + (res.stderr || '');
  const tally = out.match(/(\d+)\/(\d+) passed/);
  const passed = tally ? Number(tally[1]) : 0;
  const ran = tally ? Number(tally[2]) : 0;
  totalPassed += passed;
  totalRun += ran;

  const bad = res.status !== 0 || !tally || passed !== ran;
  if (bad) failed++;

  console.log(`${bad ? 'FAIL' : 'pass'}  ${suite.file.padEnd(20)} ${String(passed) + '/' + String(ran)}`
    + `  ${suite.what}`);

  // only the failures are worth reading in full
  if (bad || verbose) {
    out.split('\n')
      .filter(l => verbose ? l.trim() : /FAIL|THREW|Error|error/.test(l))
      .forEach(l => console.log('      ' + l.trim()));
  }
}

console.log(`\n${totalPassed}/${totalRun} assertions across ${SUITES.length} suites`
  + (failed ? `, ${failed} suite${failed === 1 ? '' : 's'} failing` : ''));
process.exit(failed ? 1 : 0);

// Does the app's own appearance wiring feed itself?
//
// themeSource works: probe one showed all nine transitions reaching the page,
// including every exit from 'system'. So the mechanism is sound and the bug is
// in what main.js does around it, which is this:
//
//   nativeTheme.on('updated', () => {
//     if ((settings.appearance || 'system') === 'system') applyAppearance();
//   });
//
// applyAppearance sets nativeTheme.themeSource. If assigning themeSource emits
// 'updated' -- even when the value has not changed -- then choosing 'system'
// arms a loop that re-enters itself for ever, sending an appearance:changed to
// the drawer every time round and leaving the main process with no room to
// handle the IPC from the next click. Which is what "once I switch to system I
// cannot change it again" looks like.
//
// This runs that exact shape and counts.
const { app, nativeTheme } = require('electron');

const out = [];
const say = (s) => out.push(s);
const settle = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  say(`electron ${process.versions.electron}`);

  // ---------- does assigning themeSource emit 'updated' at all? ----------
  let fired = 0;
  const count = () => { fired++; };
  nativeTheme.on('updated', count);

  for (const [label, value] of [
    ['light (from system)', 'light'],
    ['light again, same value', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    ['system again, same value', 'system'],
  ]) {
    fired = 0;
    nativeTheme.themeSource = value;
    await settle(200);
    say(`  setting themeSource to ${label.padEnd(26)} -> 'updated' fired ${fired} time(s)`);
  }
  nativeTheme.off('updated', count);

  // ---------- now the app's actual shape ----------
  say('');
  say("=== main.js's own wiring, run for two seconds ===");
  const settings = { appearance: 'system' };
  let applies = 0;
  let sends = 0;

  function applyAppearance() {
    applies++;
    const choice = ['system', 'dark', 'light'].includes(settings.appearance) ? settings.appearance : 'system';
    nativeTheme.themeSource = choice;
    sends++;   // stands in for webContents.send('appearance:changed')
  }

  const handler = () => {
    if ((settings.appearance || 'system') === 'system') applyAppearance();
  };
  nativeTheme.on('updated', handler);

  applyAppearance();          // as the app does at startup
  await settle(2000);
  nativeTheme.off('updated', handler);

  say(`  appearance is 'system' for two seconds: applyAppearance ran ${applies} time(s),`
    + ` ${sends} message(s) to the drawer`);
  say(applies > 5
    ? '  IT FEEDS ITSELF -- every one of those is an appearance:changed to the renderer'
    : '  no runaway: the handler settles');

  // And the same with a fixed choice, which is the arm that was never reported
  // as broken -- so it should stay quiet.
  say('');
  settings.appearance = 'light';
  applies = 0; sends = 0;
  const handler2 = () => {
    if ((settings.appearance || 'system') === 'system') applyAppearance();
  };
  nativeTheme.on('updated', handler2);
  applyAppearance();
  await settle(1500);
  nativeTheme.off('updated', handler2);
  say(`  appearance is 'light' for a second and a half: applyAppearance ran ${applies} time(s)`);

  console.log(out.join('\n'));
  app.exit(0);
});

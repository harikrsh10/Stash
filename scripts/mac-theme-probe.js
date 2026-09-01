// Does setting nativeTheme.themeSource actually change the palette on a Mac?
//
// Reported: once appearance is set to "system", it cannot be moved to light or
// dark again. Every colour in the drawer comes from prefers-color-scheme --
// dark is the default palette and light sits under a media query -- so the
// entire switch is one assumption: that setting themeSource flips
// prefers-color-scheme inside an already-open window.
//
// That assumption has never been checked on a Mac. It is checked here, in the
// order the app actually does it, including the transitions out of 'system'
// that were reported as stuck.
const { app, BrowserWindow, nativeTheme } = require('electron');

const out = [];
const say = (s) => out.push(s);

const PAGE = 'data:text/html,' + encodeURIComponent(`
  <style>:root{--who:'dark'} @media (prefers-color-scheme: light){:root{--who:'light'}}</style>
  <body>hello</body>`);

app.whenReady().then(async () => {
  // Transparent and frameless, like the drawer, in case that is what matters.
  const win = new BrowserWindow({ width: 400, height: 300, show: false, transparent: true, frame: false });
  await win.loadURL(PAGE);

  const ask = () => win.webContents.executeJavaScript(`(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    light: matchMedia('(prefers-color-scheme: light)').matches,
    token: getComputedStyle(document.documentElement).getPropertyValue('--who').trim(),
  }))()`, true);

  const settle = (ms) => new Promise(r => setTimeout(r, ms));

  say(`electron ${process.versions.electron}, chrome ${process.versions.chrome}`);
  say(`the machine starts out: shouldUseDarkColors=${nativeTheme.shouldUseDarkColors}`);
  say('');
  say('themeSource        shouldUseDarkColors   page says   token   agrees?');

  // The sequence that was reported as stuck: into system, then out of it both
  // ways, twice over -- because a switch that works once and then sticks is a
  // different bug from one that never works.
  const sequence = ['dark', 'light', 'system', 'dark', 'system', 'light', 'system', 'system', 'dark'];
  let failures = 0;
  for (const choice of sequence) {
    nativeTheme.themeSource = choice;
    await settle(120);
    const page = await ask();
    const expected = choice === 'system' ? nativeTheme.shouldUseDarkColors : choice === 'dark';
    const agrees = page.dark === expected;
    if (!agrees) failures++;
    say(`  ${choice.padEnd(16)} ${String(nativeTheme.shouldUseDarkColors).padEnd(20)}`
      + ` ${(page.dark ? 'dark' : 'light').padEnd(11)} ${page.token.padEnd(7)} ${agrees ? 'yes' : 'NO'}`);
  }

  say('');
  say(failures
    ? `  ${failures} of ${sequence.length} changes did not reach the page -- themeSource is not enough on this platform`
    : `  all ${sequence.length} changes reached the page`);

  // The other half of the report: does a window created while themeSource is
  // already set open in the right palette, or only follow later changes?
  say('');
  say('=== a window opened while a choice is already in force ===');
  for (const choice of ['dark', 'light']) {
    nativeTheme.themeSource = choice;
    await settle(80);
    const w2 = new BrowserWindow({ width: 200, height: 200, show: false, transparent: true, frame: false });
    await w2.loadURL(PAGE);
    const page = await w2.webContents.executeJavaScript(
      `matchMedia('(prefers-color-scheme: dark)').matches`, true);
    const want = choice === 'dark';
    say(`  themeSource ${choice}: a fresh window says ${page ? 'dark' : 'light'} -- ${page === want ? 'right' : 'WRONG'}`);
    w2.destroy();
  }

  console.log(out.join('\n'));
  app.exit(0);
});

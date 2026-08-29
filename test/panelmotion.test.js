// Opening the side panel must not move anything else.
//
// This is measured rather than eyeballed because the failure was invisible in
// the CSS. The page was always laid out correctly; the window was not. It grew
// leftward by 520px when a panel opened, and a window whose left edge moves has
// its old contents shown at the new origin for the frame or two before the
// renderer catches up — so the eye saw the whole drawer slide left and snap
// back while every rule involved read as perfectly correct. Three rounds of
// stylesheet fixes changed nothing, because the frame at fault was never the
// stylesheet's to paint.
//
// The window is one size now. These assertions are here to keep it that way.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SRCDIR = path.join(__dirname, '..', 'src');
const DRAWER_W = 466;
const INSPECTOR_W = 520;
const WINDOW_W = DRAWER_W + INSPECTOR_W;
const SCREEN_RIGHT = 1900;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass, detail });

  const mainSrc = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(SRCDIR, 'renderer.html'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(SRCDIR, 'preload.js'), 'utf8');

  // ---------- the window cannot resize, so it cannot drag the layout ----------

  // Not "does not currently" — there is no way left to ask it to. A single
  // surviving call site is all it would take for the jump to come back.
  ok('nothing can widen the window for the panel',
     !/window:expand/.test(mainSrc) && !/window:expand/.test(preloadSrc)
     && !/expandWindow/.test(rendererSrc), '');
  ok('the drawer has one width, whatever the panel is doing',
     /const width = DRAWER_W \+ INSPECTOR_W;/.test(mainSrc), '');
  ok('and the empty half of it is see-through, not a slab',
     /transparent: true/.test(mainSrc), '');
  // Declaring the window transparent is not enough on its own. Setting a
  // window background anywhere paints it across the whole window, over the
  // half that has to stay see-through — which put a white slab beside the
  // drawer in light mode, from a theme handler nowhere near this CSS.
  ok('and nothing paints a background over it',
     !/setBackgroundColor/.test(mainSrc), '');

  // ---------- and the panel moves without disturbing anything ----------

  const win = new BrowserWindow({
    width: WINDOW_W, height: 700,
    x: SCREEN_RIGHT - WINDOW_W, y: 40, show: false,
  });
  await win.loadFile(path.join(SRCDIR, 'renderer.html'));

  // Where things sit on screen, which is what a person actually judges.
  const boxes = async () => {
    const b = win.getBounds();
    const r = await win.webContents.executeJavaScript(
      `(() => { const at = (sel) => { const q = document.querySelector(sel).getBoundingClientRect();
           return { left: Math.round(q.left), width: Math.round(q.width) }; };
         return { app: at('.app'), rail: at('.rail'), list: at('#list') }; })()`, true);
    const screenX = (v) => ({ left: b.x + v.left, width: v.width });
    return { app: screenX(r.app), rail: screenX(r.rail), list: screenX(r.list) };
  };

  const before = await boxes();
  await win.webContents.executeJavaScript(
    `document.getElementById('inspector').classList.add('show')`, true);
  await new Promise(r => setTimeout(r, 60));
  const during = await boxes();
  await new Promise(r => setTimeout(r, 400));
  const after = await boxes();

  const same = (k) => before[k].left === during[k].left && before[k].left === after[k].left
    && before[k].width === during[k].width && before[k].width === after[k].width;
  const trace = (k) => [before, during, after].map(s => `${s[k].left}+${s[k].width}`).join(' -> ');

  ok('the main content does not move when the panel opens', same('list'), trace('list'));
  ok('nor does the rail', same('rail'), trace('rail'));
  ok('nor the drawer around them', same('app'), trace('app'));

  // The reason they cannot: the panel's column is part of the layout whether
  // or not anything is in it, so showing the panel changes no box on the page.
  const geometry = await win.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('inspector');
       const wide = Math.round(el.getBoundingClientRect().width);
       el.classList.remove('show');
       const shut = Math.round(el.getBoundingClientRect().width);
       const shell = Math.round(document.querySelector('.shell').getBoundingClientRect().width);
       return JSON.stringify({ wide, shut, shell }); })()`, true);
  const g = JSON.parse(geometry);
  ok('the panel keeps its column even while it is shut',
     g.wide === INSPECTOR_W && g.shut === INSPECTOR_W, JSON.stringify(g));
  ok('and the page is laid out at the whole window width',
     g.shell === WINDOW_W, String(g.shell));

  // ---------- what the motion is made of ----------
  //
  // Read with transitions switched off, on purpose: this window is created
  // with show:false, it never paints, and a transition in a window that does
  // not paint never advances. Sampling mid-flight would only ever return the
  // starting value. Comparing the two end states is the part that can be
  // checked honestly without a visible window.
  const motion = await win.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('inspector');
       const card = el.querySelector('.insp-card');
       // Read the two end states, not the journey between them. Asking for a
       // computed style the instant a class changes returns the value the
       // transition is starting FROM, so without this both reads come back
       // shut and the assertions below pass or fail for the wrong reason.
       const props = getComputedStyle(el).transitionProperty;
       const cardProps = getComputedStyle(card).transitionProperty;
       const inDur = getComputedStyle(el).transitionDuration;
       const cardEase = getComputedStyle(card).transitionTimingFunction;
       el.style.transition = 'none';
       card.style.transition = 'none';
       el.classList.remove('show');
       const shut = { o: getComputedStyle(el).opacity, t: getComputedStyle(card).transform };
       el.classList.add('show');
       const open = { o: getComputedStyle(el).opacity, t: getComputedStyle(card).transform };
       el.style.transition = '';
       card.style.transition = '';
       return JSON.stringify({
         shut, open, panelProps: props, cardProps, inDur, cardEase,
       }); })()`, true);
  const m = JSON.parse(motion);

  ok('shut, the panel is invisible', m.shut.o === '0', m.shut.o);
  ok('open, it is fully there', m.open.o === '1', m.open.o);

  // Only opacity and transform. Anything else in this list is a property that
  // can cost layout, which is how this area went wrong the first time.
  const composited = (props) => props.split(',').map(p => p.trim())
    .every(p => p === 'opacity' || p === 'transform' || p === 'visibility');
  ok('the panel animates on composited properties only',
     composited(m.panelProps), m.panelProps);
  ok('and so does the card inside it',
     composited(m.cardProps), m.cardProps);

  // The travel: it starts to the right of where it belongs and moves left.
  // Going the other way is what made an earlier version read as the panel
  // appearing and then snapping back.
  const startX = Number((m.shut.t.match(/matrix\(([^)]+)\)/) || [, ''])[1].split(',')[4]);
  ok('the card starts to the right of its resting place', startX > 0, m.shut.t);
  ok('and ends exactly where it belongs', m.open.t === 'none', m.open.t);

  // and it is smaller on the way in, which is the whole of the scale
  const startScale = Number((m.shut.t.match(/matrix\(([^)]+)\)/) || [, ''])[1].split(',')[0]);
  ok('it comes up slightly undersized', startScale > 0.9 && startScale < 1, String(startScale));

  ok('on an ease-out curve', /cubic-bezier/.test(m.cardEase), m.cardEase);

  // Leaving should be quieter than arriving.
  const durs = rendererSrc.match(/--panel-in:\s*([\d.]+)s[\s\S]*?--panel-out:\s*([\d.]+)s/);
  const inMs = Math.round(parseFloat(durs[1]) * 1000);
  const outMs = Math.round(parseFloat(durs[2]) * 1000);
  ok('the exit is shorter than the entrance', outMs < inMs, `${inMs}ms in, ${outMs}ms out`);

  // The panel is emptied on a JS timer while it fades on a CSS duration. A
  // timer shorter than the fade empties the panel in front of the user.
  const jsMs = Number((rendererSrc.match(/INSPECTOR_EXIT_MS\s*=\s*(\d+)/) || [])[1]);
  ok('the panel is emptied only once it has finished leaving',
     jsMs >= outMs, `css ${outMs}ms, js ${jsMs}ms`);

  // ---------- the empty column ----------

  // The window is wider than the drawer at all times, so part of it is
  // transparent and empty. Clicks have to fall through it to whatever is
  // behind — dismissing the drawer on them instead made the shortcut look
  // broken, because clicking apparently-empty desktop closed what had just
  // been opened.
  ok('the empty column lets clicks through to what is behind',
     /setClickThrough\(!inspectorEl\.classList\.contains\('show'\) && e\.clientX < INSPECTOR_COL\)/.test(rendererSrc), '');
  ok('and it is switched off again the moment the panel fills that column',
     /if \(inspectorEl\.classList\.contains\('show'\)\) setClickThrough\(false\)/.test(rendererSrc), '');
  // Stuck on, nothing in the drawer could be clicked at all, and a hidden
  // window has no pointer to tell it otherwise.
  ok('showing the drawer always restores its own clicks',
     /on\('show', \(\) => mainWindow\.setIgnoreMouseEvents\(false\)\)/.test(mainSrc), '');

  // The background covers whatever half of the window is in use: clipped to
  // the drawer while the panel is shut, the whole window once it is out. It
  // was confined to the drawer's width first, and the open panel's card then
  // floated on the desktop with nothing behind it.
  const bg = await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.shader-bg');
       const insp = document.getElementById('inspector');
       el.style.transition = 'none';    // read the ends, not the journey
       insp.classList.remove('show');
       const shut = getComputedStyle(el).clipPath;
       insp.classList.add('show');
       const open = getComputedStyle(el).clipPath;
       el.style.transition = '';
       return JSON.stringify({ shut, open }); })()`, true);
  const bgc = JSON.parse(bg);
  ok('the background is clipped to the drawer while the panel is shut',
     bgc.shut.includes('520px'), bgc.shut);
  ok('and reaches under the panel once it is out',
     bgc.open === 'inset(0px)' || bgc.open === 'inset(0%)', bgc.open);

  // The drawer must not be scrollable as a page. The sheets are parked below
  // the panel on a translateY(100%) while they are shut, which is enough to
  // make the body scrollable — and `overflow: hidden` still makes a scroll
  // container, one nobody can scroll by hand and the browser scrolls anyway to
  // bring a focused field into view. Focusing the editor's textarea scrolled
  // the whole drawer up by the height of a sheet and took the top bar off the
  // window with it.
  const scrollable = await win.webContents.executeJavaScript(
    `(() => { const b = getComputedStyle(document.body).overflow;
       const h = getComputedStyle(document.documentElement).overflow;
       // prove it, rather than trusting the keyword: ask it to scroll
       document.body.scrollTop = 500;
       const moved = document.body.scrollTop;
       document.body.scrollTop = 0;
       return JSON.stringify({ b, h, moved }); })()`, true);
  const sy = JSON.parse(scrollable);
  ok('neither the page nor the body is a scroll container',
     sy.b === 'clip' && sy.h === 'clip', sy.b + ' / ' + sy.h);
  ok('and the drawer cannot be scrolled off its own window',
     sy.moved === 0, 'scrollTop became ' + sy.moved);

  // A scrollbar is wanted while scrolling and not otherwise.
  const scroll = await win.webContents.executeJavaScript(
    `(async () => {
       const wait = (ms) => new Promise(x => setTimeout(x, ms));
       const el = document.getElementById('list');
       const idle = el.classList.contains('scrolling');
       el.dispatchEvent(new Event('scroll'));
       await wait(20);
       const during = el.classList.contains('scrolling');
       await wait(1100);
       const after = el.classList.contains('scrolling');
       return JSON.stringify({ idle, during, after });
     })()`, true);
  const sc = JSON.parse(scroll);
  ok('the scrollbar stays out of sight until something is scrolled',
     sc.idle === false && sc.during === true && sc.after === false, scroll);

  // The dev panel turns these values by name. Rename one in the stylesheet and
  // the slider still slides, still writes a property, and changes nothing —
  // the worst kind of broken for a tool you use to judge by eye.
  const dials = fs.readFileSync(path.join(SRCDIR, 'motion-dials.js'), 'utf8');
  const named = [...dials.matchAll(/name: '(--[\w-]+)'/g)].map(m2 => m2[1]);
  const defined = await win.webContents.executeJavaScript(
    `JSON.stringify(${JSON.stringify(named)}.filter(n =>
       getComputedStyle(document.documentElement).getPropertyValue(n).trim() !== ''))`, true);
  const live = JSON.parse(defined);
  ok('every value the dials turn is a token that exists',
     named.length > 0 && live.length === named.length,
     named.filter(n => !live.includes(n)).join(' ') || `${named.length} tokens`);

  ok('the dials are not linked from the shipped page',
     !rendererSrc.includes('motion-dials'), '');
  ok('and are injected only in a dev run',
     /if \(isDev\)[\s\S]{0,400}motion-dials\.js/.test(mainSrc), '');

  let failed = 0;
  results.forEach(r => {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  });
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});

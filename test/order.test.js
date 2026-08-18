// Manual order: the reassignment in main, and the drag gesture in the drawer.
//
// The gesture is worth driving for real because the list the user sees is
// filtered — reordering three visible rows must not disturb the rows a search
// is hiding, and that is exactly the kind of thing that looks right in a
// screenshot and is wrong in the store.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRCDIR = path.join(__dirname, '..', 'src');
const MAIN = fs.readFileSync(path.join(SRCDIR, 'main.js'), 'utf8');
const RENDERER = path.join(SRCDIR, 'renderer.html');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const grab = (n) => {
  const m = MAIN.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing ' + n);
  return m[0];
};

// ---------- the store side ----------
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(grab('reorderWithin'), ctx);
const reorderWithin = ctx.reorderWithin;

const listOf = (...ids) => ids.map(id => ({ id }));
const idsOf = (l) => l.map(c => c.id);

{
  const l = listOf('a', 'b', 'c', 'd');
  const moved = reorderWithin(l, ['c', 'a', 'b', 'd']);
  ok('reorders a whole list', moved && idsOf(l).join('') === 'cabd', idsOf(l).join(''));
}
{
  // the drawer was showing a, c, e — b and d were filtered out and must not move
  const l = listOf('a', 'b', 'c', 'd', 'e');
  reorderWithin(l, ['e', 'c', 'a']);
  ok('a filtered subset only rearranges its own slots',
     idsOf(l).join('') === 'ebcda', idsOf(l).join(''));
}
{
  const l = listOf('a', 'b', 'c');
  ok('an unchanged order reports no move', reorderWithin(l, ['a', 'b', 'c']) === false, '');
}
{
  const l = listOf('a', 'b', 'c');
  reorderWithin(l, ['c', 'zz', 'a']);
  ok('an id that no longer exists is ignored, not dropped',
     idsOf(l).join('') === 'cba' && l.length === 3, idsOf(l).join(''));
}
{
  const l = listOf('a', 'b', 'c');
  ok('one id is not a reorder', reorderWithin(l, ['b']) === false, '');
}
{
  // two sessions share one array; reordering one must leave the other alone
  const l = [
    { id: 'a', sessionId: 's1' }, { id: 'x', sessionId: 's2' },
    { id: 'b', sessionId: 's1' }, { id: 'y', sessionId: 's2' },
  ];
  reorderWithin(l, ['b', 'a']);
  ok('reordering one session leaves the other in place',
     idsOf(l).join('') === 'bxay', idsOf(l).join(''));
}

// ---------- the gesture ----------
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 340, height: 900, show: false });
  await win.loadFile(RENDERER);

  const probe = `(async () => {
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass, detail });
    const tick = (ms) => new Promise(r => setTimeout(r, ms));

    let sentIds = null, sentSession = null;
    window.api = {
      write: async () => {}, delete: async () => {}, clear: async () => {}, hide: () => {},
      pin: async () => {}, unpin: async () => {}, markPrompt: async () => {}, unmarkPrompt: async () => {},
      startDrag: () => {}, startDragMulti: () => {}, drawerDragStart: () => {}, drawerDragEnd: () => {},
      reorderPinned: async (ids) => { sentIds = ids; return true; },
      reorderSession: async (sid, ids) => { sentSession = sid; sentIds = ids; return true; },
    };

    const rows = () => [...document.querySelectorAll('.item')];
    const ids = () => rows().map(r => r.dataset.id);

    // drag row \`i\` so the pointer sits past the middle of row \`j\`, using the
    // grip (which lifts at once) unless asked to press and hold the row body
    async function dragRow(i, j, viaHold) {
      const from = rows()[i], to = rows()[j];
      const a = from.getBoundingClientRect();
      if (viaHold) {
        from.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0,
          clientX: a.left + 120, clientY: a.top + 8 }));
        await tick(240); // let the hold mature into a lift
      } else {
        from.querySelector('.drag-handle').dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: a.top + 8 }));
      }
      const b = to.getBoundingClientRect();
      const y = j > i ? b.bottom - 2 : b.top + 2;
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: y }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await tick(320); // the drop animation settles before the row is read back
    }

    pinned = [
      { id: 'p1', type: 'text', isPrompt: true, ts: 1, content: 'alpha' },
      { id: 'p2', type: 'text', isPrompt: true, ts: 2, content: 'bravo' },
      { id: 'p3', type: 'text', isPrompt: true, ts: 3, content: 'charlie' },
    ];
    history = [{ id: 'h1', type: 'text', ts: 9, content: 'a copied thing' }];
    sessionClips = [];
    activeScope = 'prompts';
    render();

    ok('prompts can be reordered', rows().every(r => r.classList.contains('orderable')), '');
    ok('three prompt rows', rows().length === 3, rows().length + '');

    // The grip was reported as almost impossible to hit: the dots are 4px wide,
    // so the target has to be a strip laid over the row, not the dots.
    {
      const row = rows()[0];
      const strip = getComputedStyle(row.querySelector('.drag-handle'), '::before');
      const w = parseFloat(strip.width);
      ok('the grab target is a wide strip, not the dots', w >= 20, w + 'px');
      ok('and it runs the full height of the row',
         strip.top === '0px' && strip.bottom === '0px', strip.top + '/' + strip.bottom);

      // pressing the far corner of that strip must still lift the row
      const r = row.getBoundingClientRect();
      row.querySelector('.drag-handle').dispatchEvent(new MouseEvent('mousedown',
        { bubbles: true, button: 0, clientX: r.left + w - 2, clientY: r.top + 2 }));
      await tick(40);
      ok('a press at the strip corner lifts', document.querySelectorAll('.item.slot').length === 1, '');
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await tick(320);

      // and history rows, which keep no order, get no strip at all
      const wasScope = activeScope;
      activeScope = 'all';
      render();
      await tick(20);
      const hist = rows().find(r2 => r2.dataset.block === 'history');
      ok('history rows get no grab strip',
         !hist || getComputedStyle(hist.querySelector('.drag-handle'), '::before').content === 'none',
         hist ? getComputedStyle(hist.querySelector('.drag-handle'), '::before').content : 'no history row');
      activeScope = wasScope;
      render();
      await tick(20);
    }

    // --- drag the first prompt to the end ---
    await dragRow(0, 2);
    ok('the row lands where it was dropped', ids().join('') === 'p2p3p1', ids().join(''));
    ok('the store is told the new order', (sentIds || []).join('') === 'p2p3p1', (sentIds || []).join(''));
    ok('the drawer array matches what was sent',
       pinned.map(p => p.id).join('') === 'p2p3p1', pinned.map(p => p.id).join(''));
    ok('no ghost is left behind', document.querySelectorAll('.item.lifting').length === 0, '');
    ok('the hole is filled back in', document.querySelectorAll('.item.slot').length === 0, '');
    ok('no row is left mid-slide',
       rows().every(r => !r.style.transform && !r.classList.contains('shifting')), '');

    // --- dragging back up ---
    sentIds = null;
    await dragRow(2, 0);
    ok('a row can be dragged upwards too', ids().join('') === 'p1p2p3', ids().join(''));

    // --- a drag that goes nowhere ---
    sentIds = null;
    const before = ids().join('');
    const g = rows()[1].querySelector('.drag-handle');
    g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 10 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await tick(300);
    ok('a click on the grip changes nothing', ids().join('') === before, ids().join(''));
    ok('and asks the store for nothing', sentIds === null, String(sentIds));

    // --- the whole row is the handle now ---
    sentIds = null;
    await dragRow(0, 2, true);
    ok('holding the row body reorders it too', ids().join('') === 'p2p3p1', ids().join(''));
    ok('the held drag reaches the store', (sentIds || []).join('') === 'p2p3p1', (sentIds || []).join(''));
    await dragRow(2, 0, true);

    // a hold that finishes as a reorder must not also copy the clip
    let copied = 0;
    const realWrite = window.api.write;
    window.api.write = async () => { copied++; };
    await dragRow(0, 2, true);
    rows()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    ok('finishing a reorder does not copy the clip', copied === 0, copied + ' copies');
    window.api.write = realWrite;
    await dragRow(2, 0, true);

    // --- a press that moves at once is a drag-out, not a reorder ---
    let draggedOut = 0;
    window.api.startDrag = () => { draggedOut++; };
    const row0 = rows()[0];
    const r0 = row0.getBoundingClientRect();
    row0.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0,
      clientX: r0.left + 120, clientY: r0.top + 8 }));
    row0.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
    await tick(240);
    ok('moving straight away still drags the clip out', draggedOut === 1, draggedOut + '');
    ok('and no lift was armed behind it',
       document.querySelectorAll('.item.slot, .item.arming').length === 0, '');
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    // --- pressing a button inside the row must not arm a lift ---
    const btn = rows()[0].querySelector('[data-act="copy"]');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await tick(240);
    ok('pressing a row button arms nothing',
       document.querySelectorAll('.item.slot, .item.arming').length === 0, '');
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    // --- Everything: three lists stacked, each reordered on its own ---
    pinned = [
      { id: 'q1', type: 'text', isPrompt: true, ts: 1, content: 'prompt one' },
      { id: 'q2', type: 'text', isPrompt: true, ts: 2, content: 'prompt two' },
      { id: 'k1', type: 'text', ts: 3, pinnedAt: 3, content: 'pinned one' },
      { id: 'k2', type: 'text', ts: 4, pinnedAt: 4, content: 'pinned two' },
    ];
    history = [
      { id: 'h1', type: 'text', ts: 5, content: 'copied one' },
      { id: 'h2', type: 'text', ts: 6, content: 'copied two' },
    ];
    activeScope = 'all';
    render();
    await tick(20);
    ok('everything stacks prompts, pinned and history',
       ids().join(' ') === 'q1 q2 k1 k2 h1 h2', ids().join(' '));
    ok('kept rows offer a reorder',
       rows().slice(0, 4).every(r => r.classList.contains('orderable')), '');
    ok('history rows do not',
       rows().slice(4).every(r => !r.classList.contains('orderable')), '');

    sentIds = null;
    await dragRow(0, 1, true);
    ok('a prompt can be reordered inside everything',
       ids().join(' ') === 'q2 q1 k1 k2 h1 h2', ids().join(' '));
    ok('and only its own block is sent', (sentIds || []).join(' ') === 'q2 q1',
       (sentIds || []).join(' '));

    sentIds = null;
    await dragRow(2, 3, true);
    ok('a pinned clip reorders within the pinned run',
       ids().join(' ') === 'q2 q1 k2 k1 h1 h2', ids().join(' '));
    ok('and sends only the pinned ids', (sentIds || []).join(' ') === 'k2 k1',
       (sentIds || []).join(' '));

    // dragging a prompt far past the pinned rows must not let it leave its run
    sentIds = null;
    const pr = rows()[0], last = rows()[5];
    const pb = pr.getBoundingClientRect();
    pr.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0,
      clientX: pb.left + 120, clientY: pb.top + 8 }));
    await tick(240);
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
      clientY: last.getBoundingClientRect().bottom + 200 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await tick(320);
    ok('a prompt cannot be dragged out of the prompt run',
       ids().join(' ') === 'q1 q2 k2 k1 h1 h2', ids().join(' '));

    // history keeps no order, so holding one does nothing at all
    const hrow = rows()[4];
    const hb = hrow.getBoundingClientRect();
    hrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0,
      clientX: hb.left + 120, clientY: hb.top + 8 }));
    await tick(240);
    ok('holding a history row lifts nothing',
       document.querySelectorAll('.item.slot').length === 0, '');
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await tick(60);

    pinned = [
      { id: 'p1', type: 'text', isPrompt: true, ts: 1, content: 'alpha' },
      { id: 'p2', type: 'text', isPrompt: true, ts: 2, content: 'bravo' },
      { id: 'p3', type: 'text', isPrompt: true, ts: 3, content: 'charlie' },
    ];
    history = [{ id: 'h1', type: 'text', ts: 9, content: 'a copied thing' }];

    // --- a filtered list ---
    activeScope = 'prompts';
    pinned = [
      { id: 'p1', type: 'text', isPrompt: true, ts: 1, content: 'keep alpha' },
      { id: 'p2', type: 'text', isPrompt: true, ts: 2, content: 'hidden bravo' },
      { id: 'p3', type: 'text', isPrompt: true, ts: 3, content: 'keep charlie' },
    ];
    document.getElementById('search').value = 'keep';
    document.getElementById('search').dispatchEvent(new Event('input', { bubbles: true }));
    await tick(20);
    ok('the filter hides the middle prompt', rows().length === 2, rows().length + '');
    sentIds = null;
    await dragRow(0, 1);
    ok('only the visible ids are sent', (sentIds || []).join('') === 'p3p1', (sentIds || []).join(''));
    ok('the hidden prompt keeps its slot',
       pinned.map(p => p.id).join('') === 'p3p2p1', pinned.map(p => p.id).join(''));

    document.getElementById('search').value = '';
    document.getElementById('search').dispatchEvent(new Event('input', { bubbles: true }));
    await tick(20);

    return out;
  })()`;

  let rendered = [];
  try {
    rendered = await win.webContents.executeJavaScript(probe, true);
  } catch (e) {
    ok('the drawer probe ran', false, String(e && e.message).slice(0, 160));
  }
  rendered.forEach(r => results.push(r));

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});

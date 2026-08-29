// src/motion-dials.js — turning the motion values while watching them.
//
// Tuning the inspector's wipe took several rounds of edit, rebuild, relaunch,
// open the panel, squint, disagree. Each round costs minutes and the thing
// being judged lasts a third of a second, which is the worst possible ratio
// for getting it right. Dragging a slider and replaying the wipe is the same
// judgement in about a second.
//
// This is a development tool. main.js injects it into the page only when the
// app was started with --dev; nothing loads it otherwise, and renderer.html
// does not reference it.
//
// dialkit was the obvious thing to reach for and cannot be used here: its
// entry point requires React, which this page does not have and does not want
// for a debug panel. What is actually needed is four numbers and a curve,
// which is less code than the adapter would have been.

(function () {
  if (window.motionDials) return;       // survives a re-injection on reload

  // Everything the panel can turn, and the range worth exploring. `unit` is
  // what gets written back onto the custom property.
  const DIALS = [
    { name: '--panel-in',    label: 'open',  min: 0.05, max: 0.9,  step: 0.01, unit: 's' },
    { name: '--panel-out',   label: 'close', min: 0.05, max: 0.9,  step: 0.01, unit: 's' },
    { name: '--panel-from-x', label: 'travel', min: 0,   max: 60,   step: 1,    unit: 'px' },
    { name: '--panel-from-scale', label: 'scale', min: 0.9, max: 1, step: 0.005, unit: '' },
  ];

  // A curve is four numbers; four sliders each is unreadable and nobody tunes
  // a bezier that way. These are the curves anyone actually reaches for.
  const CURVES = [
    ['snap',      'cubic-bezier(0.2, 0, 0, 1)'],
    ['ease out',  'cubic-bezier(0.16, 1, 0.3, 1)'],
    ['ease in out', 'cubic-bezier(0.4, 0, 0.2, 1)'],
    ['overshoot', 'cubic-bezier(0.34, 1.28, 0.64, 1)'],
    ['springy',   'cubic-bezier(0.34, 1.56, 0.64, 1)'],
    ['linear',    'linear'],
  ];
  const CURVE_DIALS = [
    { name: '--panel-ease', label: 'curve' },
  ];
  const ALL = [...DIALS, ...CURVE_DIALS];

  const read = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Styled from the drawer's own tokens so the panel follows the theme it is
  // sitting on top of, and kept in here rather than in renderer.html so that
  // nothing dev-only leaks into the shipped stylesheet.
  const CSS = `
    .dials {
      position: fixed; left: 12px; bottom: 12px; z-index: 9999;
      width: 232px; padding: 10px;
      display: flex; flex-direction: column; gap: 2px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border2); border-radius: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      font: 11px/1.4 ui-sans-serif, system-ui, sans-serif;
      user-select: none;
    }
    .dials-head {
      color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase;
      padding: 2px 4px 6px;
    }
    .dials-row {
      display: grid; grid-template-columns: 72px 1fr 44px;
      align-items: center; gap: 8px; padding: 3px 4px;
      border-radius: 8px;
    }
    .dials-row:hover { background: var(--surface2); }
    .dials-label { color: var(--text-2); }
    .dials-value { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
    .dials-row input[type="range"] { width: 100%; accent-color: var(--prompt); }
    .dials-row select {
      grid-column: 2 / -1; width: 100%;
      background: var(--surface2); color: var(--text);
      border: 1px solid var(--border2); border-radius: 6px;
      padding: 2px 4px; font: inherit;
    }
    .dials-foot { display: flex; gap: 6px; padding: 8px 4px 2px; }
    .dials-foot button {
      flex: 1; padding: 5px 6px;
      background: var(--surface2); color: var(--text-2);
      border: 1px solid var(--border2); border-radius: 8px;
      font: inherit; cursor: pointer;
      transition-property: background-color, color, scale;
      transition-duration: 0.12s;
      transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    }
    .dials-foot button:hover { background: var(--surface3); color: var(--text); }
    .dials-foot button:active { scale: 0.96; }
  `;

  function slider(d) {
    const row = document.createElement('label');
    row.className = 'dials-row';
    row.innerHTML = '<span class="dials-label"></span>'
      + `<input type="range" min="${d.min}" max="${d.max}" step="${d.step}">`
      + '<span class="dials-value"></span>';
    row.querySelector('.dials-label').textContent = d.label;
    const input = row.querySelector('input');
    const out = row.querySelector('.dials-value');
    input.value = String(parseFloat(read(d.name)) || d.min);
    const apply = () => {
      const v = Number(input.value);
      document.documentElement.style.setProperty(d.name, v + d.unit);
      out.textContent = v + d.unit;
    };
    input.addEventListener('input', apply);
    apply();
    return row;
  }

  function picker(d) {
    const row = document.createElement('label');
    row.className = 'dials-row';
    const current = read(d.name);
    row.innerHTML = '<span class="dials-label"></span><select></select>';
    row.querySelector('.dials-label').textContent = d.label;
    const sel = row.querySelector('select');
    // A value edited in the stylesheet that is not one of the presets would
    // otherwise show as whatever happened to be first and quietly lie.
    const options = CURVES.some(([, v]) => v === current)
      ? CURVES : [['current', current], ...CURVES];
    options.forEach(([name, value]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = name;
      opt.selected = value === current;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () =>
      document.documentElement.style.setProperty(d.name, sel.value));
    return row;
  }

  // The point of the whole thing: see the change without going to find an
  // icon to click. Taking .show off and putting it back replays the wipe in
  // place — no window resize, and none of closeInspector's teardown, so
  // whatever is being previewed is still there afterwards.
  function replay() {
    const el = document.getElementById('inspector');
    // Replaying while the window is still narrow would only wipe open into
    // space that is not there yet, which tells you nothing about the timing.
    if (!el || !el.classList.contains('show')) return false;
    el.classList.remove('show');
    void el.offsetWidth;                 // force the shut state to take
    el.classList.add('show');
    return true;
  }

  // Whatever the click did, say so on the button itself and put the label
  // back — a dev panel with no feedback is a panel you press twice.
  function button(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', async () => {
      const said = await onClick();
      if (!said) return;
      b.textContent = said;
      setTimeout(() => { b.textContent = label; }, 1100);
    });
    return b;
  }

  function build() {
    const root = document.createElement('div');
    root.className = 'dials';
    const head = document.createElement('div');
    head.className = 'dials-head';
    head.textContent = 'motion';
    root.appendChild(head);

    DIALS.forEach(d => root.appendChild(slider(d)));
    CURVE_DIALS.forEach(d => root.appendChild(picker(d)));

    const foot = document.createElement('div');
    foot.className = 'dials-foot';
    foot.appendChild(button('replay', () => (replay() ? null : 'open a panel')));
    // Tuning that cannot leave the session is tuning done twice. This puts the
    // current values on the clipboard as the CSS to paste back into :root.
    foot.appendChild(button('copy css', async () => {
      const lines = ALL.map(d => '      ' + d.name + ': ' + read(d.name) + ';').join('\n');
      try {
        await navigator.clipboard.writeText(lines);
        return 'copied';
      } catch (err) {
        console.warn('motion dials: could not copy', err);
        return 'no clipboard';
      }
    }));
    // Dropping the inline overrides falls back to whatever the stylesheet
    // says, which is the honest baseline to compare a change against.
    foot.appendChild(button('reset', () => {
      ALL.forEach(d => document.documentElement.style.removeProperty(d.name));
      rebuild();
      return null;
    }));
    root.appendChild(foot);
    return root;
  }

  let panel = null;

  function rebuild() {
    if (!panel) return;
    const next = build();
    panel.replaceWith(next);
    panel = next;
  }

  function toggle() {
    if (panel) { panel.remove(); panel = null; return false; }
    panel = build();
    document.body.appendChild(panel);
    return true;
  }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  window.motionDials = { toggle, replay };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      toggle();
    }
  });
  console.log('motion dials: ctrl+shift+m');
})();

// Both appearances have to define the same things. A token defined in one
// palette and missing from the other, or a colour left hardcoded in a rule,
// looks fine in whichever theme was open when it was written and wrong in the
// other — which nobody notices until a user switches.
const fs = require('fs');
const path = require('path');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

function block(css, startMarker) {
  const at = css.indexOf(startMarker);
  if (at < 0) return null;
  let depth = 0, i = css.indexOf('{', at);
  const from = i;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (!depth) return css.slice(from, i + 1); }
  }
  return null;
}

const tokensIn = (text) => {
  const found = new Map();
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(m[1], m[2].trim());
  return found;
};

for (const file of ['renderer.html', 'dock.html']) {
  const full = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
  const css = full.slice(0, full.indexOf('</style>'));

  const darkBlock = block(css, ':root {');
  const lightMedia = block(css, '@media (prefers-color-scheme: light)');
  ok(`${file}: has a dark palette`, !!darkBlock, '');
  ok(`${file}: has a light palette`, !!lightMedia, '');
  if (!darkBlock || !lightMedia) continue;

  const dark = tokensIn(darkBlock);
  const light = tokensIn(lightMedia);

  // fonts and other non-colour tokens only need defining once
  const colourish = (name, value) => !/font|family/.test(name) && !/'|"/.test(value);
  const darkColours = [...dark].filter(([k, v]) => colourish(k, v)).map(([k]) => k);

  const missing = darkColours.filter(t => !light.has(t));
  ok(`${file}: every dark colour token has a light value`, missing.length === 0,
     missing.length ? missing.join(' ') : `${darkColours.length} tokens`);

  const extra = [...light.keys()].filter(t => !dark.has(t));
  ok(`${file}: the light palette invents nothing`, extra.length === 0, extra.join(' '));

  // a token defined as itself resolves to nothing at all
  const selfRef = [...dark, ...light].filter(([k, v]) => v === `var(${k})`).map(([k]) => k);
  ok(`${file}: no token defined as itself`, selfRef.length === 0, selfRef.join(' '));

  // component rules must not carry literals, or they cannot follow the theme
  const afterPalettes = css.slice(css.indexOf(lightMedia) + lightMedia.length);
  const literals = afterPalettes.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g) || [];
  ok(`${file}: component rules use tokens, not literals`, literals.length === 0,
     literals.length ? [...new Set(literals)].slice(0, 6).join(' ') : 'clean');

  // and every token a rule reaches for must exist. A var() written with a
  // fallback is deliberately dynamic — the stack sets --x/--r per card from JS.
  const used = new Set([...afterPalettes.matchAll(/var\((--[\w-]+)\s*\)/g)].map(m => m[1]));
  const undefinedTokens = [...used].filter(t => !dark.has(t));
  ok(`${file}: every token used is defined`, undefinedTokens.length === 0,
     undefinedTokens.length ? undefinedTokens.join(' ') : `${used.size} in use`);
}

// the main process has to drive the switch, or the stylesheets never flip
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
ok('main sets themeSource', /nativeTheme\.themeSource\s*=/.test(main), '');
ok('appearance is a persisted setting', /appearance:\s*'system'/.test(main), '');
ok('following the system means following changes',
   /nativeTheme\.on\('updated'/.test(main), '');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

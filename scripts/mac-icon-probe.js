// What a Mac actually answers, run on a Mac.
//
// Three fixes to source-app icons have now been made from a Windows desk by
// reasoning about what macOS probably does, and all three were wrong. The
// generic-icon check that shipped in 0.7.4 rests on an assumption nobody has
// tested: that a path macOS cannot place resolves to the *same* icon every
// time, so a set of known generics can be compared against. If that is false
// the check is dead code and the squares stay.
//
// CI already runs a macos-latest job. This asks it the questions directly and
// prints the answers, so the next change is made from evidence.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const out = [];
const say = (s) => out.push(s);

const sha = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 12);

async function icon(p) {
  try {
    const img = await app.getFileIcon(p, { size: 'small' });
    if (!img) return { p, result: 'null' };
    if (img.isEmpty()) return { p, result: 'EMPTY' };
    const url = img.toDataURL();
    return { p, result: 'image', chars: url.length, sha: sha(url), size: img.getSize() };
  } catch (err) {
    return { p, result: 'THREW: ' + err.message };
  }
}

app.whenReady().then(async () => {
  say('=== does getFileIcon fail for a path that is not there? ===');
  // The whole premise of the 0.7.4 fix. If these throw, the generic-icon check
  // is unnecessary. If they resolve, it is necessary -- and then the question
  // is whether they resolve to the SAME thing.
  const stem = path.join(app.getPath('temp'), 'stash-icon-probe-' + Date.now());
  const missing = [
    stem,
    stem + '.stash-nothing',
    stem + '.app',
    '/Applications/Definitely Not Installed.app',
    '/Applications/Also Not Installed.app',
    '/Users/nobody/Nothing Here.app',
  ];
  const answers = [];
  for (const p of missing) {
    const a = await icon(p);
    answers.push(a);
    say(`  ${JSON.stringify(a)}`);
  }

  say('');
  say('=== do the missing .app paths agree with each other? ===');
  // This is the load-bearing claim. A Set of generics only works if the same
  // generic comes back for every unplaceable path of the same shape.
  const appShaped = answers.filter(a => a.p.endsWith('.app') && a.sha);
  const distinct = new Set(appShaped.map(a => a.sha));
  say(`  ${appShaped.length} missing .app paths produced ${distinct.size} distinct icon(s)`);
  say(`  ${distinct.size === 1 ? 'AGREE -- a set of generics works' : 'DIFFER -- comparing against a set does NOT work'}`);

  say('');
  say('=== and what do real apps answer? ===');
  const real = [
    '/System/Applications/Utilities/Terminal.app',
    '/System/Applications/TextEdit.app',
    '/System/Applications/Safari.app',
    '/Applications/Safari.app',
  ];
  const realAnswers = [];
  for (const p of real) {
    if (!fs.existsSync(p)) { say(`  ${p} -- not installed on this runner`); continue; }
    const a = await icon(p);
    realAnswers.push(a);
    say(`  ${JSON.stringify(a)}`);
  }

  say('');
  say('=== can a real icon be told apart from a generic one? ===');
  const genericShas = new Set(answers.filter(a => a.sha).map(a => a.sha));
  const collisions = realAnswers.filter(a => genericShas.has(a.sha));
  say(`  real icons that match a generic: ${collisions.length}`
    + (collisions.length ? ' -- THE CHECK WOULD THROW REAL LOGOS AWAY' : ' -- none, the check is safe'));

  say('');
  say('=== is a data url from a real icon actually a picture? ===');
  for (const a of realAnswers.slice(0, 2)) {
    const url = (await app.getFileIcon(a.p, { size: 'small' })).toDataURL();
    const b64 = url.slice(url.indexOf(',') + 1);
    const buf = Buffer.from(b64, 'base64');
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    say(`  ${path.basename(a.p)}: ${buf.length} bytes, png header ${isPng ? 'yes' : 'NO'}`);
  }

  say('');
  say('=== where do apps live on this machine? ===');
  for (const dir of ['/Applications', '/System/Applications', '/System/Applications/Utilities']) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.app')); } catch (err) {
      say(`  ${dir}: ${err.code}`);
      continue;
    }
    say(`  ${dir}: ${names.length} apps  [${names.slice(0, 6).join(', ')}]`);
  }

  say('');
  say('=== what does lsappinfo say, and in what shape? ===');
  const sh = (cmd) => {
    try {
      return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 4000 }).trim();
    } catch (err) {
      return 'FAILED: ' + (err.message || '').split('\n')[0];
    }
  };
  say(`  lsappinfo on PATH: ${sh('command -v lsappinfo || echo MISSING')}`);
  const front = sh('lsappinfo front');
  say(`  front: ${JSON.stringify(front)}`);
  // A CI runner has no GUI session, so an empty answer here is expected and is
  // not the bug -- the shape of a non-empty answer is what matters.
  say(`  name:  ${JSON.stringify(sh('lsappinfo info -only name "$(lsappinfo front | tr -d \'"\')"'))}`);
  say(`  path:  ${JSON.stringify(sh('lsappinfo info -only bundlepath "$(lsappinfo front | tr -d \'"\')"'))}`);
  // Asked about a known-running process instead, which does work headless: the
  // key names in the block are what the parser is matching on.
  say('  --- the same questions about a named app, which works without a GUI ---');
  say(`  ${JSON.stringify(sh('lsappinfo info -only bundlepath $(lsappinfo list | head -40 | grep -o "ASN:[^ ]*" | head -1)'))}`);

  console.log(out.join('\n'));
  app.exit(0);
});

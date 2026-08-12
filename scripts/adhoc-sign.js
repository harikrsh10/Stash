// electron-builder afterPack hook — ad-hoc signs the macOS app.
//
// Apple Silicon refuses to run a binary carrying no signature at all. Without
// this the .app doesn't merely warn on first launch: macOS reports it as
// malware and moves it to the Trash, and no amount of clearing the quarantine
// attribute helps, because the missing signature is a separate problem.
//
// An ad-hoc signature ("-") costs nothing and needs no Apple account. It is not
// notarization: the first launch still has to be approved once under System
// Settings > Privacy & Security. That last step needs a paid Developer ID, which
// is a decision about money rather than code.
//
// This runs after the .app is assembled and before the .dmg is built, so what
// gets packaged is the signed copy.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    console.log(`[sign] ${electronPlatformName} needs no ad-hoc signature, skipping`);
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // --deep is deprecated for real distribution signing but remains the
  // practical way to cover an Electron bundle's nested helpers and frameworks
  // with an ad-hoc signature.
  console.log(`[sign] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // Fail the build rather than ship something that will be quarantined again.
  const out = execFileSync('codesign', ['-dv', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const verified = execFileSync('codesign', ['--verify', '--verbose=2', appPath], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`[sign] ${(out + verified).split('\n').filter(Boolean).join(' | ')}`);
};

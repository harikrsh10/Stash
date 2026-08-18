// electron-builder afterPack hook — ad-hoc signs the macOS app for local builds.
//
// Apple Silicon refuses to run a binary carrying no signature at all. Without
// this the .app doesn't merely warn on first launch: macOS reports it as
// malware and moves it to the Trash, and no amount of clearing the quarantine
// attribute helps, because the missing signature is a separate problem.
//
// An ad-hoc signature ("-") costs nothing and needs no Apple account, but it is
// not a real identity: Gatekeeper still treats the app as unknown software and
// the first launch has to be approved under System Settings > Privacy & Security.
//
// Release builds don't go through here. When a Developer ID certificate is
// present in the environment, electron-builder signs and notarizes properly and
// this hook stands down — see the guard below.
//
// This runs after the .app is assembled and before electron-builder signs it,
// so for local builds what gets packaged is the ad-hoc signed copy.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    console.log(`[sign] ${electronPlatformName} needs no ad-hoc signature, skipping`);
    return;
  }

  // A real Developer ID is configured, so electron-builder is about to sign this
  // properly. Ad-hoc signing first would only be overwritten, and it makes the
  // build log read as though something signed the app twice.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[sign] Developer ID present, leaving the signature to electron-builder');
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

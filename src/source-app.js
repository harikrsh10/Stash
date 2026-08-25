// src/source-app.js — which app a clip was copied out of.
//
// People remember where something came from long after they have forgotten
// what it said: "that colour was in Figma", "that error was in the terminal".
// It is the strongest handle there is on a history thousands of clips deep,
// and the clipboard itself carries none of it.
//
// The two platforms want opposite shapes, because asking costs wildly
// different amounts.
//
// On Windows the answer needs P/Invoke, which means PowerShell: ~430ms of shell
// startup plus ~570ms compiling the interop type, once per process. Doing that
// per copy would be absurd, so one helper is started lazily and then answers
// over its stdin in about ten milliseconds. It is idle-stopped rather than kept
// for ever -- someone who copies nothing for an hour should not be paying for a
// resident PowerShell.
//
// On macOS `lsappinfo` answers directly and cheaply, so there is nothing to
// keep alive and the question is simply asked each time. Keeping a process
// around there would be the more expensive choice, not the cheaper one.
//
// No electron import, so both paths are drivable from a test without a real
// shell.

const path = require('path');

// Long enough that a working session never restarts the helper, short enough
// that leaving the app open overnight does not hold a process open with it.
const IDLE_STOP_MS = 10 * 60 * 1000;
// If the helper has not answered by now something is wrong with it, and a copy
// is not worth blocking on.
const QUERY_TIMEOUT_MS = 2000;

// The script the Windows helper runs. Written to disk by the caller, which
// already has a temp directory it manages.
const WIN_HELPER_PS1 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class StashFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
'@
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $h = [StashFg]::GetForegroundWindow()
    $procId = 0
    [void][StashFg]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId -ErrorAction Stop
    $name = $p.ProcessName
    # The description is what a person calls it -- "Google Chrome" rather than
    # "chrome" -- and is missing often enough to need the fallback above.
    try {
      $desc = $p.MainModule.FileVersionInfo.FileDescription
      if ($desc) { $name = $desc }
    } catch {}
    [Console]::Out.WriteLine("$procId\`t$name")
  } catch {
    [Console]::Out.WriteLine("\`t")
  }
  [Console]::Out.Flush()
}
`.trim() + '\n';

// Names that are not worth recording. Copying out of Stash itself is not
// provenance, it is a round trip, and a desktop with nothing focused is not an
// app. Matched case-insensitively against both the process and its description.
const IGNORED = ['stash', 'electron', 'explorer', 'windows explorer'];

function isIgnored(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return true;
  return IGNORED.includes(n);
}

// What to call an app on a row. The description is usually what a person calls
// it -- "Google Chrome" rather than "chrome" -- but some apps set it to their
// own filename, and Windows 11's Notepad is one of them, so the row would read
// "Notepad.exe" without this.
function tidyAppName(name) {
  return String(name || '').trim().replace(/\.exe$/i, '').trim();
}

// macOS answers a different way. `lsappinfo` is part of CoreServices and sits
// on every Mac, it needs no Accessibility permission -- unlike asking System
// Events through osascript, which prompts -- and it is cheap enough to run per
// copy rather than keeping a process alive. It prints one line:
//
//   "LSDisplayName"="Figma"
//
// A Mac with nothing at all in front prints nothing, which is not an error.
function parseLsAppInfoName(stdout) {
  const m = String(stdout || '').match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
  return m ? m[1].trim() : '';
}

// One shell so the inner `lsappinfo front` can name the app for the outer call
// without a round trip back into node.
//
// The `tr` is not decoration. `lsappinfo front` prints its answer already
// quoted -- "ASN:0x0-0x1e01e:" -- and command substitution does not strip
// quotes, so passing it straight on hands lsappinfo an argument with literal
// quote characters in it. Stripping them makes the ASN bare whichever way
// lsappinfo would have taken it.
const MAC_FRONT_CMD = 'lsappinfo info -only name "$(lsappinfo front | tr -d \'"\')"';

function createSourceApp({
  platform = process.platform,
  spawn,                 // (cmd, args, opts) -> ChildProcess       [windows]
  writeScript,           // (contents) -> path on disk              [windows]
  runOnce,               // (cmd, args) -> Promise<stdout>          [macos]
  selfPid = process.pid,
  idleStopMs = IDLE_STOP_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
} = {}) {
  let child = null;
  let ready = false;
  let buffer = '';
  let waiting = [];          // queued resolvers, answered in order
  let idleTimer = null;
  let stopped = false;

  // Two different shapes behind one question. Windows keeps a helper alive
  // because starting one costs a second; macOS just asks, because asking is
  // cheap and a resident process would be the more expensive choice.
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const supported = isWindows || isMac;

  function settleAll(value) {
    const pending = waiting;
    waiting = [];
    pending.forEach(w => {
      if (w.timer) clearTimer(w.timer);
      w.resolve(value);
    });
  }

  function teardown() {
    if (child) {
      try { child.stdin.end(); } catch (_) {}
      try { child.kill(); } catch (_) {}
    }
    child = null;
    ready = false;
    buffer = '';
    settleAll(null);
  }

  function touchIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => { idleTimer = null; teardown(); }, idleStopMs);
  }

  function handleLine(line) {
    if (!ready) {
      // The helper says "ready" once its interop type is compiled. Anything
      // before that is noise from the shell.
      if (line.trim() === 'ready') ready = true;
      return;
    }
    const w = waiting.shift();
    if (!w) return;
    if (w.timer) clearTimer(w.timer);
    // This answer belongs to a query that already gave up. It still has to be
    // consumed: dropping the waiter instead of the line would hand this answer
    // to the next copy that asked, and every answer after it would be one
    // behind for the rest of the session.
    if (w.timedOut) return;
    const [pidPart, ...rest] = line.split('\t');
    const name = tidyAppName(rest.join('\t'));
    const pid = Number(pidPart);
    // Our own window being in front means the copy came from inside Stash,
    // which is not something worth recording as where it came from.
    if (!name || pid === selfPid || isIgnored(name)) w.resolve(null);
    else w.resolve({ name, pid: Number.isFinite(pid) ? pid : null });
  }

  // macOS: ask, once, and give up quickly. A copy is already captured by the
  // time this runs, so the worst a slow answer costs is a row without a source.
  function askMac() {
    if (typeof runOnce !== 'function') return Promise.resolve(null);
    let settled = false;
    return new Promise((resolve) => {
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimer(() => done(null), queryTimeoutMs);
      Promise.resolve()
        .then(() => runOnce('/bin/sh', ['-c', MAC_FRONT_CMD]))
        .then((out) => {
          clearTimer(timer);
          const name = tidyAppName(parseLsAppInfoName(out));
          done(!name || isIgnored(name) ? null : { name, pid: null });
        })
        .catch((err) => {
          clearTimer(timer);
          onError(err);
          done(null);
        });
    });
  }

  function ensure() {
    if (child || stopped || !isWindows) return;
    let scriptPath;
    try {
      scriptPath = writeScript(WIN_HELPER_PS1);
    } catch (err) {
      onError(err);
      return;
    }
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      onError(err);
      child = null;
      return;
    }
    child.stdout.on('data', (d) => {
      buffer += d.toString();
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        handleLine(line);
      }
    });
    // A helper that dies takes its queue with it rather than leaving copies
    // waiting on an answer that is never coming.
    child.on('exit', () => { if (child) teardown(); });
    child.on('error', (err) => { onError(err); teardown(); });
    if (child.stderr) child.stderr.on('data', () => {});
  }

  return {
    get supported() { return supported; },
    get running() { return !!child; },

    // Who is in front right now. Resolves null rather than rejecting -- not
    // knowing where a clip came from is normal and must never cost the clip.
    current() {
      if (stopped || !supported) return Promise.resolve(null);
      if (isMac) return askMac();
      ensure();
      if (!child) return Promise.resolve(null);
      touchIdle();
      return new Promise((resolve) => {
        const w = { resolve, timer: null };
        w.timer = setTimer(() => {
          // Left in the queue on purpose -- see handleLine. Giving up on the
          // answer is not the same as the answer never arriving.
          w.timedOut = true;
          resolve(null);
        }, queryTimeoutMs);
        waiting.push(w);
        try {
          child.stdin.write('?\n');
        } catch (err) {
          onError(err);
          waiting = waiting.filter(x => x !== w);
          if (w.timer) clearTimer(w.timer);
          resolve(null);
        }
      });
    },

    stop() {
      stopped = true;
      if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
      teardown();
    },
  };
}

module.exports = { createSourceApp, isIgnored, tidyAppName, parseLsAppInfoName,
                   IGNORED, WIN_HELPER_PS1, MAC_FRONT_CMD, IDLE_STOP_MS };

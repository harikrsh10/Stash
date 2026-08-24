# Tests

```bash
npm test
```

577 assertions across fifteen suites, about a minute end to end.

## How they work

These drive the real thing rather than a copy of it.

- **Pure logic** — the functions under test are lifted out of `src/main.js` by
  name and run in a `vm` context. `main.js` is an Electron entry point and
  cannot simply be required, and splitting it into modules purely to make it
  importable would be a bigger change than the tests are worth. Renaming a
  function makes its suite fail loudly with `missing <name>`, which is the
  intended behaviour.
- **UI** — the suite loads the actual `src/renderer.html` in a hidden Electron
  window, replaces `window.api` with a stub, and drives real clicks and key
  events against the real DOM and CSS. Several bugs found this way were pure
  layout faults that no logic test would have caught: regions rendering at zero
  size, boxes positioned against the wrong box.

`window.api` is stubbed *after* the page loads, so a top-level `window.api.x()`
call in the renderer throws and stops the rest of the script from running. Keep
subscriptions grouped at the end of the file, where they already are.

## Suites

| suite | runtime | covers |
|---|---|---|
| `drag.test.js` | node | writing clips to temp files for drag-out, including name collisions |
| `stack.test.js` | electron | modifier-click selection, the stack deck, drag payloads, Esc order |
| `prompts.test.js` | electron | marking prompts, the store surviving a simulated restart, sections |
| `tags.test.js` | electron | prompt editing, tag normalization, the tag dropdown and picker |
| `inspector.test.js` | electron | word/run/block clustering, and the image inspector's regions |

## Adding to them

Each suite collects `{ name, pass, detail }` and prints `N/M passed`; the runner
reads that line, so keep the format. Put the measured value in `detail` even
when the assertion passes — `regions sized as percentages [50% x 50%]` is what
exposed a case where every box was silently zero-sized while the test still
went green.

Assert on measurements rather than on a value merely existing. `style.width !==
''` passed happily while every region was `0px` wide.

## Not covered

- The macOS OCR helper. It needs Vision and a Swift toolchain, so it is only
  ever exercised by the Mac build.
- Windows OCR end to end. `runNativeOcr` shells out to PowerShell and depends on
  an installed OCR language, so the suites test the clustering that consumes its
  output rather than the call itself.
- Anything involving a real drag, a real clipboard, or the tray.

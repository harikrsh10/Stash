# Stash

> A clipboard manager that keeps what you copy, and gets it back out again.
> Mac / Windows · built with Electron.

**Everything you copy, quietly kept. Gather a stack of it, pull text and colours out of screenshots, keep your prompts forever.**

---

## Download

### [→ Download latest release](https://github.com/harikrsh10/Stash/releases/latest)

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Stash-mac-arm64.dmg` |
| macOS (Intel) | `Stash-mac-x64.dmg` |
| Windows | `Stash-win-x64.exe` |

> **macOS**: open the `.dmg` and drag Stash to Applications.
> Signed and notarized by Apple — no security warning to click through.
>
> **Windows**: not yet signed, so SmartScreen will warn on first launch.
> Click **More info** → **Run anyway**.

See [all releases](https://github.com/harikrsh10/Stash/releases) for older versions.

---

## What it does

- Monitors your system clipboard in the background
- Keeps the last 10,000 items (text, code, URLs, images), and keeps them across restarts — search finds something you copied last week, not just this session
- Lives in your **menu bar / system tray** — click the S icon to toggle the drawer, right-click for a menu
- Two ways to access your clips:
  - **Drawer** — Press **⌘⇧V** (Cmd+Shift+V / Ctrl+Shift+V) to slide the full drawer in from the right edge. Use this to browse, search, filter, and manage.
  - **Dock** — Press **⌘⇧Space** (Cmd+Shift+Space / Ctrl+Shift+Space) to pop a small popover open at your cursor position, showing the last 5 items. Use this for quick paste while you're working.
- Drag any entry from the drawer into any other app — Notion, VS Code, Figma, Finder, browser address bar, anywhere that accepts file or text drops
- Click an entry to re-copy it (then ⌘V elsewhere as normal). Styled text keeps its formatting — a clip that carries any is marked `styled`. Hold **⌥/Alt** while clicking to copy it as plain text instead
- **Preview and name any clip** — press **view** to see it in full and give it a title of your own; the derived headline moves out of the way rather than disappearing
- **Pin items** (★) to keep them across restarts — pinned clips live in their own section at the top and don't count toward the 10,000-item cap
- **Updates itself** — new versions download in the background; the titlebar badge becomes a restart when one is ready
- **Catches the screenshots you take** (macOS) — screenshots saved to disk turn up in Stash like anything you copy
- **Pull colours out of an image** — hover a screenshot, press **color**, and get its palette as clickable swatches with hex values
- **Auto-paste from dock** (optional, off by default) — when enabled, picking an item from the dock automatically pastes it into the focused app. Requires Accessibility permission on macOS
- **Collections from any row** — the collection button lists every collection, ticking the ones already holding that clip. Pick one to add it, pick a ticked one to take it out. Delete always means delete from Stash, wherever you're standing
- Search, filter by type (including "pinned" and "prompt"), delete individual items or clear all
- **Pause capture** — toggle the live/paused indicator in the titlebar (or from the tray menu) when you're copying sensitive stuff you don't want recorded. Anything copied while paused stays ignored after you resume.
- **Re-copy promotion** — if you copy the same thing again, it flashes and bumps to the top instead of being dropped as a duplicate
- Window hides on blur — stays alive in the background

---

## Gather a stack, drop it in one go

Dropping six screenshots into Figma used to mean six drags.

- **Ctrl/Cmd+click** clips to gather them, **Shift+click** for a range, **Ctrl/Cmd+A** for everything visible
- Each pick flies a card into a deck above the footer. Hover to fan it out, click a card to take that one back out
- **Drag the deck** into Figma, an AI chat input, a folder — everything lands at once
- The drag cursor is the stack you built, not a generic file icon
- Images drop as their real files; text, code and links as one `.txt` each

A plain click still just copies, so nothing changes if you never use the modifiers. `Esc` clears the selection.

---

## Naming what you keep

Hover a clip, press the **tag** button. The panel opens beside the drawer with
the whole thing — a picture at full size, or a long clip in full rather than the
two lines a row can show — and the name field already focused, ready to type
into. Enter saves it.

A headline Stash works out for itself is fine while you still remember copying
the thing. It stops being fine for exactly what's worth keeping — a pinned
screenshot titled `1000×1500` tells you nothing a week later. Naming sits
beside the preview because seeing the thing is what lets you name it.

- The name replaces the headline. Nothing that was visible is lost: an image's
  dimensions move down to the meta line, and any other kind of clip keeps its
  preview underneath the name
- Clearing the name puts the derived headline back
- A clip can sit in history, in pinned, and in several collections at once —
  renaming it renames every copy, so it isn't called two things in one drawer
- Names show in the dock too
- **text** and **colour** are reachable two ways: from the hover strip on an
  image row, or from the switch under the name once the panel is open. The
  switch stays put while you move between the two and shows where you are
- The panel opens with nothing to press. Buttons appear once you've picked
  something out: **copy text** in one mode, **copy hex** in the other
- Names last as long as the clip does: forever for pinned clips, prompts and
  collection clips; until you quit for ordinary history, same as the clip itself

---

## Prompts

The clips you reuse shouldn't age out behind a hundred screenshots.

- Hover a clip and press **✦** to mark it a prompt. That single act makes it permanent — there's no separate pin step, and a prompt that could expire wouldn't be a library
- Prompts live in their own section at the top, with their own filter
- **edit** opens a sheet with the full text — editable in place, autosaved — and its tags
- **Tag** prompts (`image gen`, `mobile`, `review`) and filter by tag from the prompts header. The picker offers tags you already use, so a library doesn't drift into three spellings of the same idea
- Unmarking a prompt returns it to ordinary history, where it ages out again

---

## Pull text out of an image

Copy a screenshot, hover it, press **text**.

The window widens and the picture opens beside the drawer with every block of
text it found outlined. Click the areas you want; they assemble underneath in
reading order, ready to **copy** or **add to prompts**.

Text comes back in pieces rather than one dump — a dashboard's cards stay
separate, a paragraph stays whole. Reading is done by the operating system:
Windows OCR and Apple's Vision framework. A bundled engine was tried first and
read 6 of 26 words on a dark marketing screenshot where Windows read 22.

**This needs macOS or Windows.** There's no bundled engine to fall back on.

---

## Catching the screenshots you take

**macOS only, on by default** — tray menu → *Keep screenshots I take* to turn it off.

On Windows the usual screenshot gesture puts the picture straight on the
clipboard, so Stash sees it like any other copy. On macOS the default
(**⌘⇧3 / ⌘⇧4 / ⌘⇧5**) writes a file to your Desktop and never touches the
clipboard — you have to remember to hold **⌃** as well. So the screenshots
people actually take are the ones Stash never sees.

With this on, Stash watches wherever macOS saves them and picks each one up as
an ordinary image clip — draggable, pinnable, and readable by both the text and
colour extractors. Nothing about how you take screenshots changes.

- The folder and the filename prefix are read from macOS rather than assumed, so
  a custom `screencapture` location is followed
- Anything already sitting in that folder when Stash starts is left alone
- A file is only read once it has stopped being written to — macOS can publish
  the directory entry before the bytes land, and half a PNG is not a clip
- **Pause capture** pauses this too

It's on by default, unlike auto-paste. The two look similar — both macOS-only,
both needing a permission — but they aren't the same bargain. Auto-paste changes
what happens when you click something; this only decides whether a screenshot
you already took is somewhere you can find it, which is what Stash does with
everything else you copy. Off by default meant the ordinary experience on a Mac
was the broken one.

The cost is a permission prompt near first launch. Refusing it costs nothing:
the watcher can't read the folder, says so in the log, and the rest of the app
carries on.

---

## Pull the colours out of an image

Copy a screenshot, hover it, press **color**.

The same panel opens beside the drawer, this time listing what the picture is
made of — each swatch printed with its own hex over it, and how much of the
image that colour covers. Click the ones you want; they gather underneath,
ready to **copy** or **add to prompts**. A palette you'll reuse can be kept
permanently the same way a prompt is.

Colours are found by median cut over the image's own histogram, not by counting
the most common pixel values — a UI screenshot is thousands of near-identical
shades of one background, and counting raw values just returns eight greys.
Each swatch is the colour that actually dominates its region rather than the
average of it, so every hex you copy is one the picture genuinely contains: a
red and a blue never average into a purple that appears nowhere.

Near-identical swatches are merged, so asking for eight colours on a two-colour
image gives you two.

---

## Updating itself

Stash checks for a new version at startup and every six hours, downloads it in
the background while you carry on working, and swaps it in when you restart.
The badge in the titlebar shows the download's progress, then turns into
**restart** once the new version is ready — clicking it before then does
nothing, deliberately, since quitting mid-download would cost you your
unpinned history for no reason.

- **macOS** updates through Squirrel, which needs the app signed (it is) and a
  `.zip` in the release beside the `.dmg`. The dmg is what you download the
  first time; the zip is what gets installed over it afterwards
- **Windows** updates through NSIS, and fetches only the changed blocks rather
  than the whole installer again
- Dev runs skip the check entirely — there's no packaged copy to replace

Nothing is installed without you restarting, and an update already downloaded
when you quit is applied then.

---

## Building it yourself

The source is here to read, but Stash isn't open source — see
[LICENSE](LICENSE) before you do anything else with it. To run your own copy:

```bash
git clone https://github.com/harikrsh10/Stash.git
cd stash
npm install
npm start
```

For dev mode (devtools open, window doesn't hide on blur):

```bash
npm run dev
```

### Tests

```bash
npm test
```

618 assertions, about a minute. They drive the real renderer in a hidden window
rather than a copy of it — see [test/README.md](test/README.md).

### Package for distribution

```bash
# platform-appropriate installer (.dmg / .exe)
npm run dist

# bundle without creating an installer
npm run pack
```

The built artifacts land in `dist/`. Quit any packaged copy first — Windows
won't let the build replace files that a running app has open.

Releases are cut by pushing a tag; CI builds both platforms and publishes only
if **both** succeed.

---

## File structure

```
stash/
├── package.json
├── assets/           # tray icons
├── scripts/
│   ├── adhoc-sign.js     # ad-hoc signs the mac app during the build
│   ├── build-mac-ocr.js  # compiles the Vision helper (macOS only)
│   └── ocr-mac/          # the Swift helper's source
├── test/             # npm test
└── src/
    ├── main.js       # main process — clipboard polling, hotkey, drag-out, OCR, tray
    ├── preload.js    # secure bridge between main and renderer
    ├── renderer.html # the drawer, prompt editor and image inspector
    └── dock.html     # the quick-access popover UI
```

## How drag-out works

The renderer cancels HTML5 drag and calls `window.api.startDrag(entry)`, which sends an IPC message to the main process. Main writes the content to a temp file and calls `webContents.startDrag({ file, icon })` — this is Electron's native OS-level drag initiator. The target app receives a real file drop (or, for apps that accept text drops, the file's text content).

Dragging a stack takes the same path with `files` (plural), so the target sees a
normal multi-file drop — the same thing it would get from selecting several
files in Explorer or Finder.

For **text/code/url** entries: content is written to a `.txt` temp file. Most rich-text targets (Notion, Slack, docs) will unwrap the text content automatically. File-accepting targets (Finder, editors) get the actual file.

For **images**: the PNG is written to temp and dragged as a real image file.

Temp files are cleaned up on app quit.

## Persistence & lifecycle

Stash remembers what you copied, and remembers harder the things you've said to keep.

| What | Lifetime |
|------|----------|
| Regular clips | Survive quit and restart, up to 10,000 |
| Pinned clips (★) | Survive quit, restart, and reboot |
| Prompts (✦) and their tags | Same — marking one is what makes it permanent |
| User settings (auto-paste, etc.) | Persisted |
| Drawer visibility | Hidden ≠ quit — `Esc` or `×` just hides |

History is written to `history.ndjson` as one line per clip, appended as you copy so the cost of a copy does not grow with the size of the history. Pinned clips and prompts share one JSON file at your system's user-data path (`~/Library/Application Support/Stash/` on macOS, `%APPDATA%\Stash\` on Windows), told apart by a flag; they're only kept separate on screen. Pinned images live in a `pinned-images/` subfolder next to it. Nothing else is ever written to disk — extracted text isn't stored anywhere until you copy it.

Regular history is capped at **10,000 items** — the oldest fall off as new ones arrive. Pinned clips and prompts don't count toward that cap and don't age out. "Clear history" from the tray menu only clears ordinary clips; anything kept stays untouched (delete those individually if you want them gone).

## Security

Stash auto-detects and **silently skips** common secret patterns — it never adds them to history:

- API keys with known prefixes (`sk-`, `ghp_`, `AKIA…`, `AIza…`, `sk_live_`, `hf_`, `xox[baprs]-`, Stripe, RevenueCat, etc.)
- JWT tokens (`eyJ…`)
- AWS secret access keys (40-char base64 with mixed case+digits)
- High-entropy tokens (32–80 chars, mixed character classes)
- 6–8 digit 2FA/OTP codes
- Credit card numbers (13–19 digits, Luhn-validated)

When something is skipped, a small green dot pulses briefly next to the item count in the footer so you know the detection fired. The content is *not* stored anywhere.

The detection is tuned to minimize false positives — a regular URL, piece of code, or sentence will never be blocked. But no heuristic is perfect: treat Stash as a helpful collection tool, not a secure vault. Truly sensitive values should still go through a password manager.

History now outlives the process, so anything the detection misses outlives it too. **Remember history between restarts** in the tray menu turns persistence off and deletes what is already on disk; pause capture still keeps a copy out of Stash entirely.

## Known limitations

- **Text drag into code editors**: Some editors (e.g. VS Code, Cursor) drop a file reference rather than inserting text. Workaround: click the entry to put it on the real clipboard, then ⌘V. Or use the dock with auto-paste enabled.
- **Very large formatting is dropped.** Styled text is kept, but Word, Excel and some web pages put hundreds of kilobytes of HTML on the clipboard for one paragraph. Anything past 256KB is dropped and the clip stays plain, rather than growing the store on disk without limit.
- **Auto-paste may be blocked** by secure apps (password managers, banking sites, some terminals) that refuse synthetic keystrokes. The clip is on your clipboard — just paste manually with ⌘V.
- **Upgrading from a pre-0.1.23 build?** macOS ties Accessibility permission to the app's signature, and this release is signed differently than earlier ones. Remove Stash under System Settings → Privacy & Security → Accessibility and add it back, or auto-paste will fail silently.
- **Hotkey conflicts**: `⌘⇧V` is used by some apps (Slack's plain-paste). `⌘⇧Space` may conflict with macOS Character Viewer. Both auto-retry registration on system resume and display changes.
- **Text extraction needs macOS or Windows.** It uses the OS engine and there's no bundled fallback.
- **Extraction is only as good as the OS engine.** Both are strong on ordinary UI text and still mistake `10X` for `IOX` or `AI` for `Al` on stylised type. Very small or very low-contrast text can be missed entirely.
- **Where a block starts and ends is a judgement call.** Text is grouped by the engine's own lines, then split where a gap is far too wide to be word spacing. Unusual layouts can group things you'd have separated.
- **Prompts don't sync.** Each machine keeps its own library; there's no sharing between your Mac and your PC.
- **No Linux build.** The workflow builds macOS and Windows only.

## Ideas to extend

- Send a prompt straight to an AI — the piece the prompt library was built for. Two different things depending on whether you want a new conversation or the one you're already in
- Snippet mode — variables like `{{date}}` that expand on paste, which would turn prompts into templates
- Syncing prompts between machines
- Per-source filtering (e.g. "only show clips from Chrome")
- Encryption for the on-disk store
- Customizable hotkeys via settings UI
- Export / import of prompts

---

## License

Proprietary — see [LICENSE](LICENSE). Stash is not open source; all rights are
reserved. Releases before 2026 went out under the MIT License and stay that way.

For licensing enquiries, get in touch.

Built by [HariKrish](https://github.com/harikrsh10).

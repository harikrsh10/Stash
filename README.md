# Stash

A minimal clipboard history manager with drag-and-drop to any app. Mac / Windows / Linux via Electron.

Everything you copy, quietly kept. Drag it back out into anything.

## Download

- [Download Stash for Windows and Mac](https://github.com/harikrsh10/Stash/releases/latest)

Open the latest release and choose the installer for your system:

- Windows: `Stash-win-x64.exe`
- Mac Apple Silicon: `Stash-mac-arm64.dmg`
- Mac Intel: `Stash-mac-x64.dmg`

## What it does

- Monitors your system clipboard in the background
- Keeps the last 100 items (text, code, URLs, images)
- Lives in your **menu bar / system tray** — click the S icon to toggle the drawer, right-click for a menu
- Two ways to access your clips:
  - **Drawer** — Press **⌘⇧V** (Cmd+Shift+V / Ctrl+Shift+V) to slide the full drawer in from the right edge. Use this to browse, search, filter, and manage.
  - **Dock** — Press **⌘⇧Space** (Cmd+Shift+Space / Ctrl+Shift+Space) to pop a small popover open at your cursor position, showing the last 5 items. Use this for quick paste while you're working.
- Drag any entry from the drawer into any other app — Notion, VS Code, Figma, Finder, browser address bar, anywhere that accepts file or text drops
- Click an entry to re-copy it (then ⌘V elsewhere as normal)
- **Pin items** (★) to keep them across restarts — pinned clips are the only thing Stash writes to disk, live in their own section at the top, and don't count toward the 100-item cap
- **Auto-paste from dock** (optional, off by default) — when enabled, picking an item from the dock automatically pastes it into the focused app. Requires Accessibility permission on macOS
- Search, filter by type (including "pinned"), delete individual items or clear all
- **Pause capture** — toggle the live/paused indicator in the titlebar (or from the tray menu) when you're copying sensitive stuff you don't want recorded
- **Re-copy promotion** — if you copy the same thing again, it flashes and bumps to the top instead of being dropped as a duplicate
- Window hides on blur — stays alive in the background

## Run it

```bash
cd stash
npm install
npm start
```

For dev mode (devtools open, window doesn't hide on blur):

```bash
npm run dev
```

## Package for distribution

```bash
# macOS .dmg
npm run dist

# just bundle without installer
npm run pack
```

The built app lands in `dist/`.

## File structure

```
stash/
├── package.json
└── src/
    ├── main.js       # main process — clipboard polling, hotkey, drag-out
    ├── preload.js    # secure bridge
    └── renderer.html # the drawer UI (single file)
```

## How drag-out works

The renderer cancels HTML5 drag and calls `window.api.startDrag(entry)`, which sends an IPC message to the main process. Main writes the content to a temp file and calls `webContents.startDrag({ file, icon })` — this is Electron's native OS-level drag initiator. The target app receives a real file drop (or, for apps that accept text drops, the file's text content).

For **text/code/url** entries: content is written to a `.txt` temp file. Most rich-text targets (Notion, Slack, docs) will unwrap the text content automatically. File-accepting targets (Finder, editors) get the actual file.

For **images**: the PNG is written to temp and dragged as a real image file.

Temp files are cleaned up on app quit.

## Persistence & lifecycle

Stash keeps **unpinned history in memory only**, and **persists pinned items to disk**.

| What | Lifetime |
|------|----------|
| Regular clips | Lost on quit or restart |
| Pinned clips (★) | Survive quit, restart, and reboot |
| Drawer visibility | Hidden ≠ quit — `Esc` or `×` just hides |

Pinned items are stored as JSON at your system's user-data path (`~/Library/Application Support/Stash/pinned.json` on macOS, `%APPDATA%\Stash\pinned.json` on Windows). Pinned images live in a `pinned-images/` subfolder next to it. Nothing else is ever written to disk.

Regular history is capped at **100 items** — pinned items don't count toward that cap and don't age out. "Clear all" from the tray menu only clears history; pinned items stay untouched (delete them individually if you want them gone).

## Known limitations

- **Text drag into code editors**: Some editors (e.g. VS Code) drop a file reference rather than inserting text. Workaround: click the entry to put it on the real clipboard, then ⌘V.
- **Rich text loses formatting**: Only plain text and images are captured. RTF/HTML clipboard formats are simplified to plain text.
- **Hotkey conflicts**: `⌘⇧V` is also used by some apps (Slack's plain-paste). If conflicts arise, change the shortcut in `main.js`:
  ```js
  globalShortcut.register('CommandOrControl+Shift+V', toggleWindow);
  ```

## Ideas to extend

- Persistent history across restarts (write JSON index to `app.getPath('userData')`)
- Pinned / favorite items that never age out
- Sync via iCloud/Dropbox folder
- Menu bar tray icon for quick toggle
- Per-source filtering (e.g. "only show clips from Chrome")
- Snippet mode — variables like `{{date}}` that expand on paste
- Encryption for sensitive stashes (passwords, API keys)

## Security

Stash auto-detects and **silently skips** common secret patterns — it never adds them to history:

- API keys with known prefixes (`sk-`, `ghp_`, `AKIA…`, `AIza…`, `sk_live_`, `hf_`, `xox[baprs]-`, Stripe, RevenueCat, etc.)
- JWT tokens (`eyJ…`)
- AWS secret access keys (40-char base64 with mixed case+digits)
- High-entropy tokens (32–80 chars, mixed character classes)
- 6–8 digit 2FA/OTP codes
- Credit card numbers (13–19 digits, Luhn-validated)

When something is skipped, a small green dot pulses briefly next to the item count in the footer so you know the detection fired. The content is *not* stored anywhere.

The detection is tuned to minimize false positives — a regular URL, piece of code, or sentence will never be blocked. But no heuristic is perfect: treat Stash as a helpful session tool, not a secure vault. Truly sensitive values should still go through a password manager.

Since history is memory-only, quitting Stash clears everything regardless.

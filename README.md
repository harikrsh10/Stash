# Stash

> A minimal clipboard history manager with drag-and-drop to any app.
> Mac / Windows / Linux · built with Electron.

**Everything you copy, quietly kept. Drag it back out into anything.**

---

## Download

Grab the latest release for your platform:

### [→ Download latest release](https://github.com/harikrsh10/Stash/releases/latest)

| Platform | File | |
|----------|------|---|
| macOS (Apple Silicon + Intel) | `Stash-x.y.z.dmg` | [↓ latest](https://github.com/harikrsh10/Stash/releases/latest) |
| Windows | `Stash-Setup-x.y.z.exe` | [↓ latest](https://github.com/harikrsh10/Stash/releases/latest) |
| Linux | `Stash-x.y.z.AppImage` | [↓ latest](https://github.com/harikrsh10/Stash/releases/latest) |

> **Heads up for first-time install:**
> Stash isn't code-signed yet, so you'll see a security warning on first launch. This is normal for indie apps without an Apple Developer / Microsoft certificate — it's not a virus, it's just unverified.
>
> **macOS**: Right-click the app → **Open** → confirm. Or: `xattr -d com.apple.quarantine /Applications/Stash.app`
> **Windows**: Click **More info** → **Run anyway** on the SmartScreen prompt.

See [all releases](https://github.com/harikrsh10/Stash/releases) for older versions and changelogs.

> **Latest source fix:** `main` includes the newest paused clipboard capture
> behavior. While Stash is paused, copied content is ignored and will not be
> added after you resume capture. If the downloaded app still shows the old
> behavior, that release asset was built before this fix. Build from source or
> wait for the next packaged release.

---

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
- **Pause capture** — toggle the live/paused indicator in the titlebar (or from the tray menu) when you're copying sensitive stuff you don't want recorded. Anything copied while paused stays ignored after you resume.
- **Re-copy promotion** — if you copy the same thing again, it flashes and bumps to the top instead of being dropped as a duplicate
- Window hides on blur — stays alive in the background

---

## Build from source

If you'd rather run it yourself (or contribute):

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

### Package for distribution

```bash
# platform-appropriate installer (.dmg / .exe / .AppImage)
npm run dist

# bundle without creating an installer
npm run pack
```

The built artifacts land in `dist/`.

---

## File structure

```
stash/
├── package.json
├── assets/          # tray icons
└── src/
    ├── main.js       # main process — clipboard polling, hotkey, drag-out, tray
    ├── preload.js    # secure bridge between main and renderer
    ├── renderer.html # the drawer UI
    └── dock.html     # the quick-access popover UI
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
| User settings (auto-paste, etc.) | Persisted |
| Drawer visibility | Hidden ≠ quit — `Esc` or `×` just hides |

Pinned items and settings are stored as JSON at your system's user-data path (`~/Library/Application Support/Stash/` on macOS, `%APPDATA%\Stash\` on Windows). Pinned images live in a `pinned-images/` subfolder next to them. Nothing else is ever written to disk.

Regular history is capped at **100 items** — pinned items don't count toward that cap and don't age out. "Clear history" from the tray menu only clears unpinned clips; pinned items stay untouched (delete them individually if you want them gone).

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

Since regular history is memory-only, quitting Stash clears everything unpinned regardless.

## Known limitations

- **Text drag into code editors**: Some editors (e.g. VS Code, Cursor) drop a file reference rather than inserting text. Workaround: click the entry to put it on the real clipboard, then ⌘V. Or use the dock with auto-paste enabled.
- **Rich text loses formatting**: Only plain text and images are captured. RTF/HTML clipboard formats are simplified to plain text.
- **Auto-paste may be blocked** by secure apps (password managers, banking sites, some terminals) that refuse synthetic keystrokes. The clip is on your clipboard — just paste manually with ⌘V.
- **Hotkey conflicts**: `⌘⇧V` is used by some apps (Slack's plain-paste). `⌘⇧Space` may conflict with macOS Character Viewer. Both auto-retry registration on system resume and display changes.

## Ideas to extend

- Syncing via iCloud / Dropbox folder
- Per-source filtering (e.g. "only show clips from Chrome")
- Snippet mode — variables like `{{date}}` that expand on paste
- Encryption for the on-disk pinned store
- Customizable hotkeys via settings UI
- Export / import of pinned items

---

## License

MIT — see [LICENSE](LICENSE)

Built by [HariKrish](https://github.com/harikrsh10).

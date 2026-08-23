# Stash — Phase 1 & 2 PRD

**Scope:** Collections + Deterministic Context Builder
**Stack:** Electron · macOS + Windows
**Status:** Build spec. No rewrite implied — this slice is additive to the existing Electron app. This is the thin slice that tests the core bet. Everything beyond Phase 2 is deliberately out of scope.

---

## 0. Read this first

This PRD covers **only** two things: turning sessions into real Collections, and building a **deterministic** Context Builder that composes selected clips into an editable handoff brief. Nothing here uses an LLM. Nothing here needs a network call.

### The one bet this slice tests

> Will builders actually change their capture behavior — collect into a named container while working — instead of pasting straight into Cursor/Claude?

If they won't, no amount of AI briefs, integrations, or sync saves the product. So **Phase 1 is a validation gate, not a foundation.** Build it, dogfood it for two weeks, and read the kill signals in §7 honestly before writing a line of Phase 2.

### The wedge, stated once

The defensible thing here is **design-to-code handoff** — turning scattered Figma links, screenshots, design-system constraints, and reference material into an implementation-ready brief. The AI IDEs are racing to ingest *repo* context directly (Cursor `@`-mentions, Claude Code reading the repo/terminal, Gemini local codebase awareness). They do **not** handle the stuff outside the repo: Figma, browser inspiration, palettes, tokens, pattern screenshots. That gap is the whole product. Every ambiguous scoping call in this document resolves toward the design engineer, not the generic clipboard user.

### The loop everything serves

```
capture → group → label → structure → handoff
```

The single test for any feature request during this build:
**Does it make the capture→compose→handoff loop stickier? If not, it does not ship in Phase 1–2.**

---

## 1. Global non-goals (do NOT build in this slice)

These are explicitly deferred. If you find yourself building one of these, stop.

- **No AI / LLM anything.** No summarization, no "turn this into a brief" generation, no pattern-finding. The compose output is 100% deterministic. (This is Phase 4. Building it now, on an unproven context model, is the single biggest way to waste this project.)
- **No sync, no accounts, no cloud store.** Local-first, single device. (Phase 5.)
- **No integrations.** No Figma API, GitHub API, Linear/Jira, no OAuth, no browser extension. Link *classification* in this slice is pure string parsing — never a network fetch. (Phase 3/5.)
- **No page-title / surrounding-text scraping.** The clipboard doesn't carry it; getting it means a browser extension or server-side fetch, which fights the local-first principle. Do not fetch URLs. (Phase 3, and only via extension.)
- **No frontmost-app provenance detection** ("copied from terminal/Figma"). Platform-specific, flaky on Windows, not needed to prove the bet. (Phase 3.)
- **No encryption / privacy dashboard.** Table stakes for later trust, not an adoption driver. (Phase 5.)
- **No template editor / user-defined templates.** Templates are hardcoded functions in this slice. (Later.)
- **No team / sharing features** of any kind.

Write these as a comment block at the top of the codebase so they don't creep back in.

---

## 2. Phase 1 — Collections

Goal: sessions become real task workspaces you deliberately create and return to. Low technical risk, **high UX risk** — the entire risk is whether routing-into-a-collection is frictionless enough that people actually do it.

### 2.1 Data model

Use a **many-to-many** relationship between clips and collections. Do not use a single foreign key on the clip — the same snippet legitimately belongs to two tasks, and one-to-one will hurt within a week.

```ts
// Core entities

// Physical storage/media type — drives drag, write, OCR, rendering.
// This mirrors what the existing Electron app already stores. Do NOT
// collapse it into the semantic type; the media pipeline depends on it.
type MediaType = 'text' | 'image';

// Semantic role of the content — drives grouping in the compose template.
// Inferred where possible (see 2.3), user-correctable.
type SemanticType =
  | 'code'
  | 'link'
  | 'prompt'
  | 'color'
  | 'note'
  | 'error'
  | 'screenshot';

type SourceKind =
  | 'clipboard'   // captured from clipboard (default)
  | 'screenshot'  // macOS screenshot capture
  | 'manual';     // user-authored note, created in-app

interface Collection {
  id: string;              // uuid
  name: string;
  color?: string;          // optional accent, hex
  status: 'active' | 'archived';
  createdAt: number;       // epoch ms
  updatedAt: number;
}

interface Clip {
  id: string;
  mediaType: MediaType;    // physical: text | image — intrinsic, not editable
  semanticType: SemanticType; // inferred (see 2.3), user-correctable
  source: SourceKind;      // set at capture time, not editable
  content: string;         // text content, or path/ref for image
  imagePath?: string;      // for image media
  meta?: ClipMeta;         // INTRINSIC metadata only (see below)
  pinned: boolean;
  createdAt: number;
}

// Join table — clip ↔ collection.
// Carries everything that is per-collection intent, not intrinsic to the clip.
interface CollectionClip {
  collectionId: string;
  clipId: string;
  position: number;        // explicit order WITHIN this collection
  addedAt: number;
  role?: ClipRole;         // per-collection intent — see note below
  note?: string;           // per-collection annotation on this clip
}

// Intrinsic clip metadata ONLY. Nothing collection-specific lives here.
interface ClipMeta {
  linkKind?: LinkKind;     // populated by classifier (§4.3)
  language?: string;       // detected code language
}

type ClipRole = 'reference' | 'source_of_truth' | 'bug_evidence' | 'constraint';
```

**Notes for implementation:**
- **`role` and `note` live on the join (`CollectionClip`), not on the clip.** This is deliberate and load-bearing: the same Figma link is `source_of_truth` in one collection and `reference` in another. Role is collection-specific *intent*, not intrinsic clip metadata. Putting it on the clip would force a single global role and break the moment a clip is reused — which is the whole point of the many-to-many model.
- **`mediaType` (physical) is separate from `semanticType` (semantic).** The existing app's drag/write/OCR/render logic keys off physical text-vs-image; keep that intact. Semantic type is a layer *on top* for grouping in compose, not a replacement. Muddying the two is how the media pipeline breaks.
- `position` lives on the **join** too — order is per-collection. Reordering in collection A must not touch collection B.
- Keep the existing global clipboard history table as-is; collections sit alongside it. A clip can exist in history and in zero, one, or many collections.
- Migrate existing "sessions" → `Collection` rows with `status: 'active'`. Preserve their clips via join rows.
- `ClipRole` is surfaced **minimally in Phase 1** (a single dropdown per clip *within a collection*). It becomes load-bearing in the compose template, so store it now.

### 2.2 Active-collection routing — THE critical piece

This is where the product lives or dies. New captures should route into the active collection with **near-zero friction**.

**Do:**
- Global `activeCollectionId` in app state (owned in the main process, surfaced to the renderer).
- When a collection is active, new captures are added to it *and* to global history simultaneously.
- Make the active state **impossible to miss**: tray icon reflects it, drawer shows "Collecting into: [name]" prominently, and there's a one-keystroke toggle to start/stop collecting.
- One-action "create collection" from tray and drawer — name it inline, it becomes active immediately.
- Provide a fast "collect into X" without making X active (add-once), for when you're mid-task in another collection.

**Don't:**
- Don't make routing a multi-step modal. If it takes more than one deliberate action to start collecting, users revert to pasting into Cursor and the bet fails.
- Don't auto-create collections or auto-assign clips by heuristic. User-controlled context is a stated principle — silent grouping breaks trust and is also just wrong half the time.
- Don't hide the active state behind a menu. Ambient visibility is the point.

**Spend your UX budget here.** Not on export bundles, not on colors. If only one thing in Phase 1 is excellent, make it this.

### 2.2a Stale-active-collection safeguard (trust, not polish)

Real failure mode: user activates "site navigation," walks away, comes back, copies unrelated things — and it all silently pollutes the collection. If this happens even once, they stop trusting active-capture and the habit dies. Guard against it — but **guard by making pollution trivially reversible, not by nagging.**

- **Solve it with recovery, not prompts.** The primary defense is an unmissable active banner + one-click "stop collecting" + a frictionless "remove from collection" on any clip. Pollution you can undo in one click is a non-problem.
- **Re-confirm active state on app restart only.** Restart is a natural boundary, so a single "Still collecting into [name]?" on launch is fair. Do **not** add idle-timer prompts mid-session — interrupting the user every time they pause fights the near-zero-friction goal from §2.2 and will suppress activation.
- Always-visible: which collection is active, and how many clips landed in it this session (so drift is noticed early).

Rationale: prevention-by-prompt taxes every session to stop a rare mistake; recovery-by-undo makes the mistake cheap without taxing anything. Choose the second.

### 2.3 Type & source labeling

Infer what you can, let the user correct, don't over-engineer. Inference sets `semanticType`; `mediaType` and `source` are set intrinsically at capture and are not user-editable.

| semanticType | Inference rule |
|--------------|----------------|
| `screenshot` | `mediaType: image` from screenshot capture → screenshot |
| `link` | text content matches URL regex (and is a single URL) → link |
| `code` | reuse existing code-detection heuristic |
| `color` | matches hex / rgb(a) / hsl pattern → color |
| `error` | **manual only** in this slice — don't try to auto-detect stack traces, too noisy |
| `prompt` | items added from the existing prompt library |
| `note` | user-authored via manual note creation |

- `semanticType` is a single editable field. Wrong inference must be one click to fix.
- `mediaType` (text/image) and `source` (clipboard/screenshot/manual) are intrinsic and not user-editable.

### 2.4 Manual notes

- A "note" is a user-authored clip: `mediaType: 'text'`, `semanticType: 'note'`, `source: 'manual'`.
- Creation path is new (in-app text entry), distinct from capture. Simple text field → creates a clip → added to the current collection.
- This is how a user records intent ("nav must collapse under 768px", "use the editorial serif for headings") that never touched the clipboard. It feeds the compose template directly, so it matters.

### 2.5 Ordering & selection within a collection

- Explicit `position` on the join; capture order ≠ desired handoff order.
- Drag-to-reorder within a collection.
- "Select all in collection" + reuse existing multi-select. Selection is the input to compose (§4).

### 2.6 Export bundle (OPTIONAL — first thing to cut)

**This is not core to the Phase 1 bet.** The habit test is create-fast → obvious-active → capture-naturally → return-later → reorder/select. Zip export proves none of that. If you're short on time, cut or defer this before touching anything in §2.2–§2.5.

- If built: main-process side, given selected clips (or whole collection), produce a `.zip` of image attachments + a `manifest.json` listing every item with media/semantic type, source, and content.
- It's a nice non-AI escape hatch, but it earns its place only after the capture loop is solid.

### 2.7 Phase 1 non-goals

- No nested collections / folders. Flat list only.
- No collection templates.
- No smart/auto collections.
- No cross-device anything.
- No provenance beyond the three `SourceKind` values.

### 2.8 Phase 1 success signals (what "it's working" looks like)

- Users **deliberately create** a collection before/while starting a task (not after).
- Users **return** to a collection after an app restart.
- Collections get used for real categories: a feature, a bug, design research, a prompt set.

If these aren't happening after two weeks of honest dogfooding, **do not proceed to Phase 2.** Fix the capture habit or kill the direction. See §7.

---

## 3. The gate between Phase 1 and Phase 2

Before building compose, confirm the habit stuck. "Did the habit stick?" is too soft to trust your own judgment on — instrument it. No analytics, no accounts, no cloud: compute these **locally** and expose a hidden debug summary (a dev-menu panel or a `stash --stats` dump). Local-first stays intact.

**North-star metric — the habit, quantified:**
- **% of clips captured while a collection was active.** If most of your captures still land in bare history, the container habit did *not* form, whatever your gut says. This one number decides the gate.

**Supporting two (do these drift the right way?):**
- Collections **reopened after an app restart** (return = the container has ongoing value, not just in-the-moment convenience).
- Collections **abandoned with fewer than 3 clips** (high abandonment = people create containers reflexively then don't feed them — a false-positive habit).

**Context, not gate criteria (useful, lower weight):**
- Collections created per week; average clips per collection; times the active collection was stopped/changed; composes/exports run.

**Who:**
- **You** (2 weeks): did the north-star number stay high, or did you drift back to pasting straight into Cursor? Be brutal — if *you* stopped, that's the answer, and no metric softens it.
- Then ~5–10 design engineers: same instrumentation, same question.

Only build Phase 2 if the north-star holds. Phase 2 makes the habit *pay off*; it doesn't create it.

---

## 4. Phase 2 — Deterministic Context Builder

Goal: turn selected clips into a clean, editable, handoff-ready markdown brief — **deterministically**. It organizes what the user selected. It does not invent, summarize, or infer meaning. This is the feature that makes Stash more than a clipboard app, and it needs zero AI to do so.

### 4.1 Architecture — keep the engine pure

- Write the compose engine as a **pure, dependency-free, unit-tested module.** Input: structured clip data. Output: a markdown string + attachment list. No app state, no I/O, no clipboard, no filesystem inside it.
- TypeScript is fine (it's string/templating work). Wrap it with thorough unit tests — one per template, snapshot-style.
- The app layer handles: gathering selected clips, calling the engine, rendering the editable preview, and executing handoff actions (copy / export / drag). Keep those concerns out of the engine.

Why: templates must be trivially testable and trivially addable. A pure function makes every template a fixture. This is also the seam where AI plugs in later (Phase 4 feeds the *same* structured input to an LLM instead of the deterministic templates) — so a clean interface now pays off later.

### 4.2 The compose interface (the contract)

```ts
interface ComposeInput {
  collectionName: string;
  clips: Clip[];              // already filtered to the user's selection
  template: TemplateId;
  userGoal?: string;         // optional one-liner the user types at compose time
}

type TemplateId =
  | 'design_implementation'  // BUILD THIS FIRST AND BEST — the wedge
  | 'bug_fix'
  | 'refactor'
  | 'pr_review'
  | 'design_critique'
  | 'agent_handoff'
  | 'research_summary';

interface ComposeResult {
  markdown: string;          // the editable brief
  attachments: Attachment[]; // images/screenshots to drag alongside
  usedClipIds: string[];     // provenance: exactly what went in
  warnings: string[];        // missing-context flags — see below
}

interface Attachment {
  clipId: string;
  path: string;
  label: string;
}

function compose(input: ComposeInput): ComposeResult;
```

**`warnings` — the subtle high-value bit.** The compose step's real job isn't just packaging context; it's *revealing missing context before the AI sees it*. `warnings` is how that surfaces. It's deterministic (rule-based, no AI) and drives a visible banner on the preview. Examples:
- `"No source-of-truth selected — the AI has no canonical design to match."`
- `"2 screenshots included as attachments only — they won't appear inline in the prompt text."`
- `"No constraints or states captured — implementation intent may be ambiguous."`
- `"3 links couldn't be classified and are grouped under References."`

These are the same stubs from the template (§4.4), lifted to the top so the user fixes gaps *before* handoff rather than discovering them in a bad AI response.

**Hard rules for the engine:**
- Deterministic. Same input → identical output, always. `warnings` included.
- Never drop content silently. If a clip is included, it appears in the brief or as an attachment, and its id is in `usedClipIds`.
- Never fabricate. No "this looks like a login screen" inference. It groups and formats; it does not interpret. (Warnings describe *what's missing or how something was handled* — they never guess at meaning.)
- Code clips → fenced blocks with detected language.
- Screenshots → referenced in the markdown *and* returned as `attachments` for drag-out.
- The engine emits a **draft**. The UI must make it fully editable before handoff (§4.5).

### 4.3 Link classification (pulled forward from Phase 3 — it's cheap)

You can't do "links grouped by kind" without this, and it's pure string matching — no network. Do it here.

```ts
type LinkKind =
  | 'figma' | 'github' | 'docs' | 'localhost'
  | 'linear' | 'jira' | 'reference';

function classifyLink(url: string): LinkKind;
// host + path patterns only:
//   figma.com            → figma
//   github.com/.../pull  → github (PR/issue/repo distinction optional)
//   localhost | 127.0.0.1 | *.local → localhost
//   linear.app           → linear
//   *.atlassian.net      → jira
//   known docs hosts     → docs
//   everything else      → reference
```

**Do not** fetch the URL to get a title. **Do not** call any API. Host/path is enough to group links usefully in the brief.

### 4.4 The design-implementation template — build this first and best

This is the wedge. If only one template is excellent, it's this one. Structure the output as a real implementation brief a design engineer would actually hand to Cursor/Claude:

```markdown
# Implementation Brief: {collectionName}

## Goal
{userGoal, or a placeholder prompt telling the user to fill it in}

## Source of Truth
{clips with role: 'source_of_truth' — typically the canonical Figma link.
 If none tagged, list Figma links here and label them "(confirm source of truth)"}

## Design References
{links classified as figma/reference + screenshots tagged role: 'reference',
 grouped, each with its note if present}

## Constraints
{note-type clips with role: 'constraint' + any color/token clips.
 Colors rendered as a small palette list with hex values.}

## Relevant Code
{code clips as fenced blocks with language. Preserve order.}

## States & Behavior
{note-type clips describing responsive behavior, states, edge cases —
 i.e. notes not tagged as constraints. If none, emit a checklist stub:
 "- [ ] Responsive behavior:  \n- [ ] States (hover/active/disabled/loading/empty):  \n- [ ] Breakpoints:  "}

## Attachments
{list of screenshot attachments, referenced by label, dragged separately}

## Request
{a clear ask for the AI tool, e.g. "Implement the above in
 {stack placeholder}. Match the source-of-truth design. Respect the
 constraints. Ask before deviating."}
```

**Why this shape:** a Figma link alone never carries implementation intent — responsive behavior, states, tokens, component rules, copy. This template forces those into the brief, which is exactly the design→code ambiguity the whole product exists to kill. The stubs matter: when a section is empty, prompting the user to fill it is *more* valuable than hiding it, because it surfaces the missing context before it reaches the AI tool.

### 4.5 Editable preview + handoff actions

- Compose opens an **editable markdown surface** (not a locked artifact). The user tweaks before sending — this is what makes them trust it.
- Handoff actions:
  - **Copy prompt** → markdown to clipboard.
  - **Export `prompt.md`** → file write.
  - **Drag attachments** → reuse existing drag-out.
  - **Drag bundle** → reuse Phase 1 zip.
- Show `usedClipIds` as a visible "included: N items" list with the option to deselect and recompose. Transparency is the trust mechanism — the user must always see exactly what went in.
- Render `warnings` as a dismissible banner **above** the brief. This is the "reveal missing context before the AI sees it" moment — put it where the user can't miss it, before they copy. Each warning ideally links to the fix (e.g. "tag a source of truth" jumps to that clip).

### 4.6 Other templates (after design_implementation ships)

The remaining six differ mainly in section order and headers. Build them only once the first one is proven in real handoffs. Rough shapes:
- `bug_fix`: Error / Repro / Relevant code / Screenshots / Ask.
- `refactor`: Current code / Goal / Constraints / Ask.
- `pr_review`: Diff or code / Context / What to check / Ask.
- `design_critique`: References / Screenshots / Criteria / Ask.
- `agent_handoff`: Goal / Context bundle / Constraints / Success criteria.
- `research_summary`: Sources grouped by kind / Notes / Open questions.

### 4.7 Phase 2 non-goals

- No AI summarization or generation (Phase 4).
- No template editor (later).
- No auto-send to any tool. Copy/drag/export only — the user does the final send. This is a trust rule, not just a scope cut.
- No network calls anywhere in compose.

### 4.8 Phase 2 success signals

- Users compose from collections and actually **send** the brief to Cursor/Claude/ChatGPT/Figma.
- Users report **better AI responses** because context is structured.
- Users **reuse** the design-implementation template across similar work.

---

## 5. Build order within this slice

1. Data model + migration (Collection, join table, enums).
2. Active-collection routing + ambient active state. **← the make-or-break UX.**
3. Type inference (media/semantic split) + manual notes + per-collection role dropdown.
4. Ordering, select-all. Stale-collection safeguard (§2.2a). Export bundle only if time allows.
5. **Ship Phase 1 + local stats panel (§3). Dogfood 2 weeks. Read §7 against the north-star.**
6. Compose engine (pure module) + link classifier.
7. `design_implementation` template — polished.
8. Editable preview + copy/export/drag handoff.
9. **Ship Phase 2 to ~10 design engineers.**
10. Remaining templates, only if step 9 shows real usage.

---

## 6. Open decisions (you need to call these)

- **Compose engine placement:** it's TypeScript either way — decide whether the pure engine module lives in the renderer (co-located with the compose UI, easiest iteration) or the main process (reusable by export/CLI paths, cleaner separation). Recommendation: keep it a standalone module with zero Electron/DOM imports so it runs in either and stays unit-testable in isolation.
- **Role tagging friction:** roles now live on the join (`CollectionClip.role`), so a clip's role is set *within a collection*, not globally — good, but it still adds labeling work. Decide whether to prompt for role when adding a clip to a collection or make it a quiet optional field on the clip-in-collection view. Lean quiet + optional; the template degrades gracefully (stubs + `warnings`) when roles are absent.
- **Empty-section behavior:** confirm you want stubs-with-prompts (recommended) vs hiding empty sections. Stubs surface missing context; hiding is cleaner but loses the "what am I forgetting" value.

---

## 7. Kill / iterate signals (be honest here)

After Phase 1 dogfooding, if:
- the north-star (§3) is low — most clips still landed in bare history, not an active collection,
- collections got created once and abandoned (high <3-clip rate),
- the active-collecting state felt like overhead on quick tasks and you drifted back to pasting straight into Cursor —

then the capture habit did **not** stick, and Phase 2 will not save it. Options in priority order: (1) reduce routing friction further and re-test, (2) narrow to the single design-engineer workflow even harder, (3) stop. Building Phase 2 on a broken Phase 1 is the expensive mistake this whole document exists to prevent.

---

## Appendix: what this PRD deliberately leaves out, and where it lives

| Deferred | Phase | Why not now |
|----------|-------|-------------|
| AI summarization / briefs | 4 | Needs a proven context model first; same input, different generator |
| Page title / surrounding text | 3 (via extension) | Fights local-first; needs extension or fetch |
| Frontmost-app provenance | 3 | Platform-specific, flaky, not needed to prove the bet |
| Privacy review / dashboard | 5 | Trust table-stakes, not an adoption driver |
| Sync / backup | 5 | Whole separate product; use file export → cloud-folder → hosted, in that order |
| Encryption (SQLCipher) | 5 | Moderate effort, defer until paid users exist |
| Windows code signing | 5 | Cost/paperwork item, needed for Windows trust |
| Figma / GitHub / Linear / Jira integrations | 5 | Each is a multi-week project; browser extension is highest-leverage first |
| User-defined templates | later | Hardcode the seven first, learn what people actually reshape |

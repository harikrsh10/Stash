# Stash Product Brief

## Working Position

Stash is evolving from a clipboard capture app into a local-first context workspace for builders.

The core promise:

> Capture the messy material around what you are building, organize it by task, and turn it into reliable handoff context for AI, design, and code tools.

Stash should not be positioned only as "clipboard history." That market is crowded and the value is easy to underestimate. The stronger wedge is project context: screenshots, code, links, prompts, colors, notes, and errors collected while work is happening, then structured into something useful.

## Target Users

### Primary

Design engineers and AI-heavy builders.

They move constantly between:

- Figma
- browser inspiration
- docs
- code editors and AI IDEs
- terminal errors
- screenshots
- ChatGPT, Claude, Cursor, and other AI tools
- product/project tools such as Linear, Jira, Notion, and Slack

### Secondary

- Product engineers
- UI engineers
- designers learning code
- solo founders
- AI consultants
- QA and design QA practitioners

### Not The Initial Target

Generic clipboard-manager users.

They may still use Stash, but the product should not be built or marketed around "everyone who copies things." That audience is broad, price-sensitive, and already served by many free or low-cost tools.

## Problem Areas

### 1. Working Context Is Scattered

Builders collect useful context across many tools, but the material has no shared place to live. A single task may involve code, screenshots, logs, docs, design references, Figma links, notes, and saved prompts.

The result is repeated context rebuilding: "What was I working on, what matters, and where did I put it?"

### 2. AI Tools Need Context, But Preparing It Is Manual

AI coding and design tools are most useful when given the right surrounding context. Today the user often has to manually gather code, terminal output, screenshots, links, and intent before asking for help.

Stash can become the layer before the AI input: collect first, structure second, send third.

### 3. Design-To-Code Handoff Is Ambiguous

A Figma link alone rarely contains the full implementation intent. Design engineers also need responsive behavior, states, constraints, component system rules, examples, copy, and implementation notes.

The opportunity is to help turn design/reference material into an implementation brief.

### 4. Trust And Provenance Matter

People are cautious about AI output and about clipboard tools. A useful context layer must make it clear:

- what was captured
- what was intentionally included
- where each item came from
- what stays local
- what might be sent to another tool
- what was skipped for safety

### 5. Design Systems And Existing Code Need Better Representation

AI can produce generic UI if it does not understand the user's design system, tokens, components, or app patterns. Builders need a lightweight way to carry those constraints into a task brief.

## Product Principles

1. Local-first by default.
2. User-controlled context, not automatic surveillance.
3. Structure before AI.
4. Preserve source and intent.
5. Make the safe path obvious.
6. Keep deterministic workflows available even if AI features are added.
7. Fit into existing tools rather than forcing users into a new workspace.

## Current Strengths

Stash already has more than a basic clipboard foundation:

- clipboard history
- drawer and dock access
- drag-out to other apps
- multi-select stack drag
- collections that persist across restarts
- prompt library and tags
- pinned clips
- screenshot capture on macOS
- OCR from screenshots
- palette extraction
- pause capture
- secret-skipping heuristics
- auto-update
- tests across core features

The product already has the bones of a builder context tool. The main work is to clarify the model, improve the workflows, and introduce context composition.

## Product Evolution

### Phase 1: Project Context, Not Clipboard Pile

Goal:

Make collections feel like real project/task workspaces.

Build:

- Position the old session model as Collections across product copy.
- Improve the active "collecting into this collection" state.
- Quick create collection from tray/drawer.
- Add manual notes into a collection.
- Add type/source labels: code, screenshot, link, prompt, color, note, error.
- Improve naming and ordering within collections.
- Add select all in collection.
- Add export bundle for selected clips.

Why:

This solves scattered context without requiring AI. A user can create a task container and know everything relevant is there.

Success signals:

- Users intentionally create collections for tasks.
- Users return to collections after restart.
- Users use collections for feature work, bugs, design research, or AI prompts.

### Phase 2: Deterministic Context Builder

Goal:

Turn selected clips into a clean handoff brief.

Build:

- Compose action for selected clips or an entire collection.
- Editable Markdown prompt preview.
- Templates:
  - bug fix
  - design implementation
  - design critique
  - refactor
  - PR review
  - agent handoff
  - research summary
- Code detection and fenced code blocks.
- Screenshot/image attachments preserved.
- OCR notes optionally included.
- Links grouped by kind:
  - Figma
  - GitHub
  - docs
  - website/reference
  - Linear/Jira
  - localhost/app preview
- Actions:
  - Copy prompt
  - Drag attachments
  - Drag bundle
  - Export prompt.md

Important constraint:

The first version should be deterministic. It should organize what the user selected, not invent meaning.

Why:

This directly addresses the manual work of preparing context for AI tools.

Success signals:

- Users compose prompts from collections.
- Users send generated briefs to Cursor, ChatGPT, Claude, Figma, Notion, or issue trackers.
- Users trust the output because it is transparent and editable.

### Phase 3: Link-Aware And Source-Aware Context

Goal:

Make Stash understand the role of captured material.

Build:

- Link classification:
  - Figma
  - GitHub file, issue, PR, or repo
  - docs page
  - localhost preview
  - Linear/Jira ticket
  - article/reference
- Store page title and copied surrounding text when available.
- Allow user notes such as "use as reference," "source of truth," or "bug evidence."
- Add source provenance where possible:
  - copied from browser
  - copied from terminal
  - copied from Figma
  - screenshot
  - manual note
- Add per-app ignore/capture rules.
- Add privacy review before compose.

Later:

- Optional public link resolving.
- Optional browser extension.
- Optional Figma metadata if connected.
- Optional GitHub/Linear/Jira enrichment if connected.

Why:

An AI-ready brief needs roles, not just raw material. A docs link, Figma link, and inspiration link should not be treated as identical text.

Success signals:

- Composed briefs become more useful without needing AI summarization.
- Users can explain why each source is included.
- Users can safely exclude sensitive items before handoff.

### Phase 4: AI-Assisted Briefs

Goal:

Use AI to organize and summarize selected context after the user controls what is included.

Build:

- Summarize selected references.
- Find common design patterns across screenshots.
- Turn this collection into an implementation brief.
- Extract requirements from notes and docs.
- Compress this bundle for an AI chat.
- Create Cursor-ready, Claude-ready, or ChatGPT-ready prompts.
- Create bug reports or PR review briefs.

Guardrails:

- Show sources used.
- Let users remove items before generation.
- Keep generated text editable.
- Never auto-send without review.
- Keep non-AI compose available.
- Make local/cloud boundaries explicit.

Why:

This is where Stash becomes more than organization. It becomes a brief builder.

Success signals:

- Users send AI-generated briefs with light editing.
- Users report better AI responses because context is structured.
- Users reuse templates and generated briefs across similar work.

### Phase 5: Professional Trust And Integrations

Goal:

Make Stash dependable enough for paid professional use.

Build:

- Sync/backup for prompts, names, templates, and collections.
- Encrypted saved store.
- Import/export collection bundles.
- User-defined templates.
- Windows code signing.
- Changelog and release confidence in app and on site.
- Diagnostics/crash reporting opt-in.
- Privacy dashboard:
  - what is stored
  - what is memory-only
  - what was skipped
  - what integrations can access
- Integrations:
  - Figma
  - GitHub
  - Linear/Jira
  - browser extension
  - AI tool export presets

Later team features:

- shared prompt libraries
- shared collection templates
- workspace-approved privacy settings

Why:

This turns Stash from a useful utility into professional software that teams and serious builders can trust.

Success signals:

- Users trust Stash with real work projects.
- Users recommend it to teammates.
- Paid users cite sync, templates, privacy, and AI-ready context as reasons to pay.

## Suggested Build Order

1. Strengthen collections into project/task workspaces.
2. Add deterministic Context Builder.
3. Add copy/export/drag bundle flows.
4. Add link and source classification.
5. Add privacy review.
6. Add AI summarization.
7. Add integrations, sync, and encrypted storage.

Avoid starting with AI summarization before the context model is solid. The foundational workflow is:

> capture -> group -> label -> structure -> handoff

AI should amplify that workflow, not replace it.

## Initial Persona Scenario

### Design Engineer: Site Navigation Feature

The user creates a collection called "site navigation."

During research, they copy:

- screenshots of navigation patterns
- Figma links
- portfolio references
- docs links
- product constraints
- notes about required states
- snippets from the current app

They use the collection while designing in Figma. Later, when moving toward code, they select the relevant material and press Compose.

Stash produces an implementation brief:

- goal of the feature
- source-of-truth Figma link
- references for inspiration
- product constraints
- relevant code snippets
- screenshots as attachments
- notes about responsive behavior and states
- request format for the AI coding tool

The user copies the prompt and drags attachments into Cursor, Claude, ChatGPT, or another AI tool.

Value:

- less repeated copying
- clearer handoff
- less lost context
- better AI responses
- a reusable record of the feature's source material

## Possible Pricing Direction

Keep a generous free version to build habit.

Free could include:

- clipboard history
- drawer/dock
- basic pinning
- basic drag-out
- limited collections

Paid should unlock the builder context layer:

- unlimited collections
- Context Builder
- advanced templates
- OCR-assisted bundles
- link/source intelligence
- sync/backup
- encrypted saved store
- integrations
- AI-assisted briefs

Stash should not charge primarily for basic clipboard history. The defensible paid value is AI-ready working context.

## Landing Page Direction

Current landing page is polished but sells the smaller story: "clipboard manager with useful features."

Future positioning should center on:

> Collect your working context. Send it where you are building.

Recommended landing page flow:

1. Hero focused on builder context.
2. Workflow demo: collect -> compose -> handoff.
3. Persona use cases:
   - design engineer
   - developer debugging with AI
   - research/operator workflow
4. Core product pillars.
5. Trust and privacy section.
6. Platform download and first-run confidence.
7. FAQ.

## Research References

These resources informed the problem framing:

- Atlassian Developer Experience Report 2025: developer inefficiencies, finding information, and context switching.
  https://www.atlassian.com/blog/developer/developer-experience-report-2025

- Harness 2024 State of Developer Experience Report: tool sprawl and context switching across vendor tools.
  https://www.harness.io/resources/2024-state-of-developer-experience-report

- Stack Overflow Developer Survey 2024: AI adoption, trust, skepticism, and accuracy concerns.
  https://survey.stackoverflow.co/2024/ai

- GitHub Copilot responsible use documentation: context use, limitations, hallucination, and user review requirements.
  https://docs.github.com/en/copilot/responsible-use/chat

- Google Gemini Code Assist documentation: local codebase awareness and indexed workspace context.
  https://docs.cloud.google.com/gemini/docs/codeassist/configure-local-codebase-awareness

- Figma designer/developer trends: collaboration challenges and differing assumptions.
  https://www.figma.com/reports/designer-developer-trends/

- Figma handoff guide: implementation intent, responsive behavior, states, shared language, and developer constraints.
  https://www.figma.com/blog/the-designers-handbook-for-developer-handoff/

- zeroheight Design Systems Report: design system adoption, documentation, design-to-code parity, AI readiness, and trust.
  https://report.zeroheight.com/

## Open Questions

- Should Collections later become broader "projects" or "contexts," or stay intentionally lightweight?
- Should Compose be a free feature with limits, or a Pro feature?
- Should AI features be local model, cloud model, user-provided API key, or integration-specific?
- Should Stash ever auto-resolve links, or only do it after user approval?
- How much source provenance can be captured reliably without a browser extension?
- Which first integration gives the strongest user value: Figma, GitHub, Cursor, or browser?
- Should the product remain mostly individual-first before adding team features?

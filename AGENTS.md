# Pitchstone — AGENTS.md

Local-first notes app: a folder on disk (“vault”), like Obsidian. **On disk a
note is HTML.** You can write it as Markdown or as HTML — Markdown is an editing
view (marked → HTML, turndown ← HTML), not the file format. CSS and JS live in
that same HTML file (`<style>` / `<script>`), edited from the CSS+JS tab.
Markdown when you want speed; HTML/CSS/JS when you want a real page. Not a
web-app builder. Not a VS Code fork. A vault you can actually live in.

Being built in public — code stays presentable, readable, and honest.

## What this is

- User-picked vault. No hardcoded paths.
- Notes are **HTML files**. The vault is the source of truth.
- Markdown tab and HTML tab edit the same document. Save writes HTML.
- CSS+JS tab edits `<style>` / `<script>` in that file, not sidecars.
- Preview in a sandboxed iframe (`allow-scripts`, never `allow-same-origin`).
  Preview JS cannot touch the editor or the rest of the disk.

## What this is not (yet)

Mobile, publish, and “compatible with Obsidian’s plugin API.” Those stay off
until they are a milestone. Wikilinks, search, backlinks, plugins, sync, LSP,
an agent panel, and a possible React shell *are* on the list — after v0, not
instead of it.

## Stack (v0 — do not change mid-flight)

- **Vanilla Electron 34**, **plain JavaScript**. No React, no TypeScript, no
  Tailwind, no shadcn, no electron-vite, no bundler.
- Runtime deps that already exist: `marked`, `turndown`, CodeMirror 5. Do not
  add another unless the current milestone names it.
- **M16** is a React + TypeScript UI rewrite if we do one. That is the planned
  target (ecosystem, Electron examples, component libraries). It is not the only
  correct notes-app framework — Obsidian is not React — and it is not v0.
  Svelte/Solid would also work; we pick one framework when M16 starts, default
  React. Tailwind/shadcn only in that milestone, not before.

This was originally “so the owner can read every line.” That still holds for v0.
Do not rewrite the app to start M7. Note format stays **HTML files** + sandboxed
iframe across a UI rewrite so plugins and notes do not die with the shell.

## Security (do not weaken)

- `contextIsolation: true`, `nodeIntegration: false`
- IPC only through preload `contextBridge` (`window.api`)
- `resolveInVault()` in `main.js` for any renderer-supplied path. New handlers
  use the same guard. `read-dir` lists `vaultRoot` and does not take a renderer path.

## Current state

| File | Purpose |
|---|---|
| `main.js` | Window, vault dialog, last-vault store, guarded file IPC |
| `preload.js` | Forwards `window.api.*` → `ipcRenderer.invoke` |
| `renderer.js` | Vault UI, tabs, CodeMirror, preview, HTML open/save |
| `index.html` | Dark split layout: file list, editor, sandboxed preview |

Working: nested vault tree, wikilinks (`[[note]]` ↔ `<a class="wikilink">`), tabs, HTML save,
create/rename/delete notes and folders, drag to move, last vault remembered, autosave.

## How we work

1. **Ship.** No teaching comments in the repo. No line-by-line class unless asked.
2. **One milestone at a time.** Finish it, `npm start`, then commit. Do not start
   the next milestone mid-way.
3. **No scope creep.** If it is not in the list below, note it and skip it.
4. Plain code: small functions, obvious names, ASCII-first UI text.
5. Vault path is always user-picked.

## Milestones

### v0 — hybrid vault editor (ship this)

- [x] **M1 — Window + vault IPC**: Electron window, select-vault, guarded IPC.
- [x] **M2 — File list + open + save**: flat list, click to open, Save and Cmd/Ctrl+S.
- [x] **M3 — Split view + live preview**: editor left, sandboxed iframe right;
  `marked` + ~100ms debounce.
- [x] **M4 — Tabs**: Markdown / HTML / CSS+JS above the editor; convert between
  them (MD ↔ HTML; CSS stubs from tags). Preview is the HTML document (body +
  style + script). CodeMirror highlighting + completion (not LSP). Open/save
  the note as HTML — Markdown tab is a view.
- [x] **M5 — Vault polish**: create / rename / delete in the tree, remember last
  vault, auto-save with visible dirty/saved state. New notes are `.html`.
  Nested folders deferred to M7.
- [x] **M6 — Public v0**: README with honest scope, MIT license, polish.
  Push to a remote when you say so — not automatic.

### After v0 — notes app (do not start before you ask)

- [x] **M7 — Nested vault**: folders as a real tree, not a flat list.
- [x] **M8 — Wikilinks**: `[[note]]` in the Markdown view (stored as links in
  the HTML). Click to open, create if missing.
- [ ] **M9 — Search**: filter the vault by filename and full text.
- [ ] **M10 — Backlinks**: show notes that link here.
- [ ] **M11 — Graph** (optional): local graph of wikilinks. Skip if M10 is enough.
- [ ] **M12 — Agent panel**: a side panel that talks to **whichever agent you
  run**, via adapters — pi, Cursor, Claude Code, OpenCode, and anything else
  that can speak a documented stdin/stdout or HTTP contract. The app is not
  married to one vendor. Agents may propose vault edits; writes still go
  through `resolveInVault()`.
- [ ] **M13 — LSP**: hover, diagnostics, completion from language servers
  (HTML/CSS/JS; Markdown if a server is worth it). Likely Monaco or CodeMirror 6
  plus servers spawned from main. Servers only see vault paths.
- [ ] **M14 — Plugins**: vault-installable, **sandboxed** (same iframe rules as
  note JS). No raw Node, no bypassing `resolveInVault()`. Plugin API is files +
  events, not “must be React components,” so M16 cannot kill them.
- [ ] **M15 — Sync**: pick the mechanism at this milestone (git remote, or a
  real protocol). Local vault remains canonical. No mystery cloud by default.
- [ ] **M16 — React rewrite** (optional): new renderer shell in React + TS.
  Notes, preview sandbox, IPC, and plugin format do not change. Only do this
  when the vanilla UI is actually drowning — or when you explicitly start M16.

## UI

Not a sterile SaaS app. Dark, dense, tool-like, zero corporate chrome.
Function first, character second.

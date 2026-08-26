# Hybrid Editor — AGENTS.md

A desktop Markdown/HTML hybrid editor: pick a folder ("vault"), browse files, edit
Markdown (and later raw HTML/CSS/JS), see a live preview. Being built in public —
code must stay presentable, readable, and honest.

## Stack (REALITY — do not change)

- **Vanilla Electron** (Electron 34), **plain JavaScript** — NO React, NO TypeScript,
  NO Tailwind, NO electron-vite, NO build step. This was decided deliberately so the
  owner can read every line and understand it. Do not introduce a framework, a
  bundler, a transpiler, or a new dependency unless a milestone explicitly asks for it.
- `marked` is the only planned new dependency (Markdown → HTML).
- Security stays as-is: `contextIsolation: true`, `nodeIntegration: false`, IPC via
  preload contextBridge, and `resolveInVault()` path guard in main.js. Never weaken
  these. New IPC handlers must go through the same guard.

## Current State (what exists)

| File | Purpose |
|---|---|
| `main.js` | Window, vault selection dialog, IPC: read-dir / read-file / write-file (all vault-guarded) |
| `preload.js` | contextBridge exposing `window.api` |
| `renderer.js` | Open folder, flat file list, click to open into textarea, save (button + Cmd/Ctrl+S) |
| `index.html` | Bare layout: Open/Save buttons, path + status lines, file list, textarea |

Working: open a vault, list its files, open a file, edit, save back. No preview yet.
Git: baseline commit exists; every milestone below gets its own commit.

## Rules for this project

1. **Teaching mode is mandatory.** Explain every file and every non-obvious decision
   in plain language as you build — what the code does and *why it's written that way*.
   No silent bulk code dumps. This project exists to teach the owner JavaScript,
   Electron, and web fundamentals.
2. **Work one milestone at a time.** Finish it, verify it runs (`npm start`), then
   commit with a clear message. Never start the next milestone mid-way through the
   previous one.
3. **No scope creep.** If an idea isn't in the milestone list, don't build it — note
   it and move on.
4. Keep code plain and readable: small functions, obvious names, no clever one-liners,
   no minification, ASCII-first UI text.
5. No personal paths, no absolute paths hardcoded — the vault is always user-picked.

## Milestones

- [x] **M1 — Window + vault IPC**: empty Electron window, select-vault dialog, guarded
  read/write IPC (DONE in scaffold).
- [x] **M2 — File list + open + save**: flat vault file list, click to open, save via
  button and Cmd/Ctrl+S (DONE in scaffold).
- [ ] **M3 — Split view + live preview**: editor left, preview right; preview is a
  sandboxed `<iframe>` rendering `marked(content)` with a debounce (~100ms). No new
  concepts beyond iframe + marked. **NEXT.**
- [ ] **M4 — Tabs**: Markdown / HTML / CSS+JS tabs above the editor; CSS+JS content
  injected into the preview iframe (style/script tags); HTML tab injects raw HTML when
  used. This is the "batshit crazy HTML" tab — full control, sandboxed iframe.
- [ ] **M5 — Vault polish**: create/rename/delete files in the tree, remember last
  vault (persist path), auto-save on change with visible save state.
- [ ] **M6 — Public v0**: README with screenshots and honest scope, MIT license,
  final polish pass, push public.

## UI notes

Not a sterile SaaS app. Give it a little personality — dark, dense, tool-like,
zero corporate chrome. Function first, character second.
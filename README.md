# Pitchstone

Volcanic glass, next to obsidian. Local-first notes in a folder (a vault). **Notes are HTML files.** Write them as Markdown or as HTML. CSS and JS live in the same file (`<style>` / `<script>`). Live preview runs in a sandboxed iframe.

Window chrome is native-feeling: hidden traffic lights on Mac, overlay controls on Windows/Linux, zinc surfaces, system fonts. Light and dark via a class on `<html>`.

## Disclaimer

This is **vibe-coded and in progress.** It works on a desk. It is not a finished product, not audited, and not a promise that your vault will survive every edge case. Keep backups. Expect sharp edges. The long-term idea is an Obsidian-like vault with HTML/CSS/JS when you want a real page — v0 is only the editor + vault basics.

## Run

```bash
npm install
npm start
```

Electron 34, no bundler. Open a folder. New notes are `.html`. Last vault is remembered.

## What works

- Pick a vault, nested folder tree (drag to move)
- Wikilinks: `[[note]]` in Markdown, stored as `<a class="wikilink">` in HTML
- Search: Cmd/Ctrl+K palette (filename + full text). `>` commands, `#` headings, `[[` notes
- Backlinks in the inspect rail (linked + unlinked mentions). Local graph on the Graph ribbon icon
- Agent panel: ACP session (Zed-style frontend for a headless agent). Presets for Claude / Gemini / Cursor / OpenCode. `json` / `http` still do one-shot. File tools go through the vault path guard
- Create / rename / delete notes and folders
- Autosave (Unsaved → Saved), Cmd/Ctrl+S
- Markdown / HTML / CSS+JS tabs on the same document
- Preview: note HTML + your CSS/JS, `sandbox="allow-scripts"` (not `allow-same-origin`)
- Path guard: renderer cannot read/write outside the vault

## Agent

The panel is a client. The agent is a long-lived process that speaks [ACP](https://agentclientprotocol.com) (JSON-RPC over stdio), same idea as Zed / t3code.

Start `claude --acp` (or another ACP command). Send keeps the session. The vault is the agent's cwd. Current note is attached as a resource. Streaming text, tool cards, and permission prompts show in the thread. `fs/read_text_file` and `fs/write_text_file` are served from main and still go through `resolveInVault()`.

`json` and `http` are the old one-shot contract if you want a custom script:

```json
{
  "pitchstone": 1,
  "message": "user text",
  "note": { "path": "/abs/note.html", "html": "<!DOCTYPE html>..." }
}
```

Reply `{ "text": "...", "edits": [{ "path": "note.html", "html": "..." }] }` or plain text. Edits are proposed; Apply still goes through `resolveInVault()`.

## What does not (yet)

See the roadmap. Saving a `.md` file writes an HTML document to that same path. New notes use `.html`.

## Roadmap

**v0 (this):** vault, HTML notes, tabs, preview, create/rename/delete, autosave.

**After v0:**

1. Nested folders
2. `[[wikilinks]]`
3. Search
4. Backlinks
5. Graph
6. Agent panel (pi, Cursor, Claude Code, OpenCode, …)
7. LSP
8. Sandboxed plugins
9. Sync
10. Optional React UI rewrite

Details live in `AGENTS.md`.

## Note format

On disk, a note is an HTML document. The Markdown tab is a view (`marked` / `turndown`), not the source of truth. Preview chrome CSS is not saved into the file.

## Stack

Vanilla Electron, plain JavaScript, CodeMirror 5, `marked`, `turndown`. No React, no TypeScript, no Vite.

## License

MIT. See `LICENSE`.

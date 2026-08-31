# MathMargin

MathMargin is a local-first PDF reader for mathematical notes, books, papers, and problem sets. It lets you highlight text or draw resizable boxes on a page and attach Obsidian-style Markdown and LaTeX notes.

## Features

- Local PDF library with upload (up to 120 MB), real first-page covers, drag-to-reorder, rename, reopen, and delete
- Windows-style Ctrl/Shift multi-selection with bulk open, move, textbook-mode, and delete actions
- Folder import that preserves the original Windows subfolder hierarchy, with nested Explorer navigation
- Recursive folder deletion that also removes every nested folder, contained PDF, and annotation
- Multi-PDF tabs that keep each document's reading state while switching
- Selectable PDF text, page navigation, and touchpad/Ctrl-wheel zoom
- Text highlights and movable, resizable area annotations anchored through zoom changes
- Contextual box options for color, linking, and deletion
- Bidirectional annotation links within one PDF or across different PDFs
- One Obsidian-style live note editor with inline KaTeX rendering
- Obsidian-style floating KaTeX previews while selecting or editing math source
- LaTeX Suite-compatible shortcuts and snippet expansion
- Obsidian callouts such as `> [!note]`, `> [!tip]`, and `> [!warning]`
- Optional **Treat as textbook** mode for any PDF, with automatic chapter and section detection and annotation counts
- Named annotations with debounced local autosave using IndexedDB
- Windows portable desktop packaging through Electron

PDFs and annotations stay on the computer when using the desktop app.

## Requirements

- Node.js 22.13 or newer
- npm
- Windows for the packaged desktop executable

## Development

```bash
npm install
npm run desktop:dev
```

Run the desktop shell against the development files with:

```bash
npm run desktop:run
```

## Validation

```bash
npx tsc --noEmit
npm run desktop:bundle
```

The Electron smoke-test harness in `desktop/electron-main.cjs` validates PDF upload and reopening, PDF rendering and zooming, live LaTeX editing, LaTeX Suite shortcuts, callouts, autosave scrolling, chapter grouping, clickable overlays, box moving/resizing/options/deletion, and annotation linking.

## Build the Windows app

```bash
npm run desktop:build
```

The portable executable is generated in `release/`. Build artifacts and local PDF data are intentionally excluded from Git.

## Project structure

- `desktop/src/` — Electron renderer, PDF reader, live note editor, local storage, and book-structure detection
- `desktop/electron-main.cjs` — Electron main process and packaged smoke test
- `app/`, `components/`, `worker/` — hosted web implementation
- `lib/`, `db/`, `drizzle/` — shared types and hosted storage schema

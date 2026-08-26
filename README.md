# MathMargin

MathMargin is a local-first PDF reader for mathematical textbooks. It lets you highlight text or draw resizable boxes on a page and attach Obsidian-style Markdown and LaTeX notes.

## Features

- Local PDF library with upload (up to 120 MB), rename, reopen, and delete
- Selectable PDF text, page navigation, and touchpad/Ctrl-wheel zoom
- Text highlights and movable, resizable area annotations anchored through zoom changes
- Contextual box options for color, linking, and deletion
- Bidirectional annotation links within one textbook or across different books
- One Obsidian-style live note editor with inline KaTeX rendering
- LaTeX Suite-compatible shortcuts and snippet expansion
- Obsidian callouts such as `> [!note]`, `> [!tip]`, and `> [!warning]`
- Automatic chapter and section detection with annotation counts
- Debounced local autosave using IndexedDB
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

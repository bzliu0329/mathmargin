import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { EditorView } from "@codemirror/view";
import { Document, Page, pdfjs } from "react-pdf";
import katex from "katex";
import "katex/contrib/mhchem/mhchem.js";
import type { AnnotationColor, AnnotationGeometry, AnnotationRecord, BookStructureEntry, NormalizedRect } from "../../lib/types";
import { ANNOTATION_COLORS, MAX_PDF_SIZE } from "../../lib/types";
import { getDocument, listAnnotations, listDocuments, putAnnotation, putDocument, removeAnnotation, removeDocument, type LocalDocument } from "./storage";
import { LATEX_SUITE_SHORTCUT_COUNT } from "./latexSuite";
import { BOOK_STRUCTURE_VERSION, extractBookStructure } from "./bookStructure";
import { LiveNoteEditor } from "./LiveNoteEditor";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const KATEX_MACROS = {
  "\\bra": "\\left\\langle #1 \\right|",
  "\\ket": "\\left| #1 \\right\\rangle",
  "\\braket": "\\left\\langle #1 \\right\\rangle",
  "\\hom": "\\operatorname{hom}",
};

const NOTES_WIDTH_KEY = "mathmargin:notes-width";
const AREA_RESIZE_HANDLES = ["nw", "ne", "sw", "se"] as const;
type AreaResizeHandle = typeof AREA_RESIZE_HANDLES[number];

function clamp(value: number, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function isTextGeometry(value: AnnotationGeometry): value is { rects: NormalizedRect[] } { return "rects" in value; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function formatSize(bytes: number) { return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
function resizeAreaRect(rect: NormalizedRect, handle: AreaResizeHandle, deltaX: number, deltaY: number) {
  const minimum = .015;
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left = clamp(left + deltaX, 0, right - minimum);
  if (handle.includes("e")) right = clamp(right + deltaX, left + minimum, 1);
  if (handle.includes("n")) top = clamp(top + deltaY, 0, bottom - minimum);
  if (handle.includes("s")) bottom = clamp(bottom + deltaY, top + minimum, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function mathError(markdown: string) {
  try {
    const blocks = [...markdown.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((match) => match[1]);
    const inline = [...markdown.replace(/\$\$[\s\S]*?\$\$/g, "").matchAll(/(^|[^\\])\$([^\n$]+?)\$/g)].map((match) => match[2]);
    for (const expression of [...blocks, ...inline]) katex.renderToString(expression, { throwOnError: true, macros: KATEX_MACROS });
    return "";
  } catch (error) { return message(error, "This equation has a LaTeX error.").replace(/^KaTeX parse error:\s*/i, ""); }
}

function structureTitle(title: string, number: string | undefined, level: 0 | 1) {
  if (!number) return title;
  const withoutNumber = level === 0
    ? title.replace(/^(?:chapter|part|appendix)\s+[A-Z0-9IVXLC]+(?:\s*[:.\-–—]\s*|\s+)?/i, "").replace(/^\d{1,3}[.:\s\-–—]+/, "").trim()
    : title.replace(/^\d+(?:\.\d+)+\.?\s*/, "").trim();
  return withoutNumber || title;
}

function groupAnnotationsByStructure(annotations: AnnotationRecord[], structure: BookStructureEntry[]) {
  type SectionGroup = { key: string; title: string; number?: string; pageNumber: number; annotations: AnnotationRecord[] };
  type ChapterGroup = { key: string; title: string; number?: string; pageNumber: number; sections: SectionGroup[] };
  const chapters: ChapterGroup[] = [];
  const orderedStructure = [...structure].sort((a, b) => a.pageNumber - b.pageNumber);

  let currentChapter: ChapterGroup | null = null;
  for (const entry of orderedStructure) {
    if (entry.level === 0) {
      currentChapter = chapters.find((group) => group.key === entry.id) ?? { key: entry.id, title: entry.title, number: entry.number, pageNumber: entry.pageNumber, sections: [] };
      if (!chapters.includes(currentChapter)) chapters.push(currentChapter);
      continue;
    }
    if (!currentChapter) {
      currentChapter = { key: "book-sections", title: "Book sections", pageNumber: entry.pageNumber, sections: [] };
      chapters.push(currentChapter);
    }
    if (!currentChapter.sections.some((section) => section.key === entry.id)) currentChapter.sections.push({ key: entry.id, title: entry.title, number: entry.number, pageNumber: entry.pageNumber, annotations: [] });
  }

  for (const annotation of annotations) {
    let chapterTitle = structure.length ? "Front matter" : "Book notes";
    let chapterKey = structure.length ? "front-matter" : "book-notes";
    let sectionTitle = structure.length ? "General notes" : "Pages";
    let sectionKey = `${chapterKey}-general`;
    let chapterNumber: string | undefined;
    let sectionNumber: string | undefined;
    let chapterPageNumber = 1;
    let sectionPageNumber = annotation.pageNumber;
    for (const entry of orderedStructure) {
      if (entry.pageNumber > annotation.pageNumber) break;
      if (entry.level === 0) {
        chapterTitle = entry.title; chapterKey = entry.id;
        chapterNumber = entry.number; chapterPageNumber = entry.pageNumber; sectionTitle = "General notes"; sectionKey = `${entry.id}-general`; sectionNumber = undefined; sectionPageNumber = entry.pageNumber;
      } else {
        sectionTitle = entry.title; sectionKey = entry.id; sectionNumber = entry.number; sectionPageNumber = entry.pageNumber;
      }
    }
    let chapter = chapters.find((group) => group.key === chapterKey);
    if (!chapter) { chapter = { key: chapterKey, title: chapterTitle, number: chapterNumber, pageNumber: chapterPageNumber, sections: [] }; chapters.push(chapter); }
    let section = chapter.sections.find((group) => group.key === sectionKey);
    if (!section) { section = { key: sectionKey, title: sectionTitle, number: sectionNumber, pageNumber: sectionPageNumber, annotations: [] }; chapter.sections.push(section); }
    section.annotations.push(annotation);
  }
  return chapters;
}

export function DesktopApp() {
  const [activeId, setActiveId] = useState(() => location.hash.match(/^#\/reader\/(.+)$/)?.[1] ?? "");
  useEffect(() => {
    const change = () => setActiveId(location.hash.match(/^#\/reader\/(.+)$/)?.[1] ?? "");
    addEventListener("hashchange", change); return () => removeEventListener("hashchange", change);
  }, []);
  return activeId ? <DesktopReader documentId={activeId} onBack={() => { location.hash = ""; }} /> : <DesktopLibrary onOpen={(id) => { location.hash = `/reader/${id}`; }} />;
}

function DesktopLibrary({ onOpen }: { onOpen: (id: string) => void }) {
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listDocuments().then(setDocuments).catch((cause) => setError(message(cause, "Your library could not be opened."))).finally(() => setLoading(false)); }, []);

  async function upload(file?: File) {
    if (!file || uploading) return;
    setError("");
    if (file.size > MAX_PDF_SIZE) return setError("This PDF is larger than the 75 MB limit.");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return setError("Choose a PDF file to continue.");
    setUploading(true);
    let stage = "reading the file";
    try {
      const data = await file.arrayBuffer();
      stage = "validating the PDF";
      const task = pdfjs.getDocument({ data: data.slice(0) });
      const pdf = await task.promise;
      const now = new Date().toISOString();
      const record: LocalDocument = {
        id: crypto.randomUUID(), title: file.name.replace(/\.pdf$/i, ""), originalFilename: file.name,
        fileSize: file.size, pageCount: pdf.numPages, createdAt: now, updatedAt: now, lastOpenedAt: now,
        file: data,
      };
      stage = "closing the PDF validator";
      await pdf.destroy();
      stage = "saving the PDF locally";
      await putDocument(record);
      setDocuments((current) => [record, ...current]);
    } catch (cause) {
      const detail = message(cause, "This PDF could not be read.");
      setError(/password/i.test(detail) ? "Password-protected PDFs are not supported yet." : /invalid|format|missing pdf/i.test(detail) ? "This PDF appears to be corrupted or invalid." : `${detail} (${stage})`);
    } finally { setUploading(false); if (inputRef.current) inputRef.current.value = ""; }
  }

  async function rename(document: LocalDocument) {
    const title = draftTitle.trim(); if (!title) return;
    const updated = { ...document, title: title.slice(0, 160), updatedAt: new Date().toISOString() };
    await putDocument(updated); setDocuments((current) => current.map((item) => item.id === document.id ? updated : item)); setEditingId("");
  }

  async function discard(document: LocalDocument) {
    if (!confirm(`Delete “${document.title}” and all of its annotations?`)) return;
    await removeDocument(document.id); setDocuments((current) => current.filter((item) => item.id !== document.id));
  }

  return <main className="library-shell desktop-library">
    <header className="library-header desktop-drag-region"><div className="brand"><span className="brand-mark">M</span><span>MathMargin</span></div><span className="desktop-local-pill">Stored locally · works offline</span></header>
    <section className="library-hero"><div><p className="eyebrow">Your mathematical reading room</p><h1>Read closely.<br />Think in the margins.</h1><p className="hero-copy">Upload a textbook, highlight the ideas that matter, and keep notes with beautifully rendered LaTeX right beside the page.</p></div><div>
      <label className={`upload-card ${dragging ? "is-dragging" : ""} ${uploading ? "is-uploading" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files[0]); }}>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" onChange={(event) => upload(event.target.files?.[0])} />
        <span className="upload-icon">{uploading ? "…" : "↑"}</span><strong>{uploading ? "Reading and saving your PDF…" : "Drop a PDF here"}</strong><span>{uploading ? "This can take a moment for a large textbook" : "or choose a file from your computer"}</span><small>PDF · up to 75 MB</small>
      </label>{error && <div className="library-error" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
    </div></section>
    <section className="books-section"><div className="section-heading"><div><p className="eyebrow">Local library</p><h2>Your textbooks</h2></div><span className="book-count">{documents.length} {documents.length === 1 ? "book" : "books"}</span></div>
      {loading ? <div className="loading-row"><span className="spinner" /> Opening your library…</div> : !documents.length ? <div className="empty-library"><div className="empty-glyph">∫</div><div><h3>Your library is ready</h3><p>Upload your first textbook to begin making mathematical notes.</p></div><button className="text-button" onClick={() => inputRef.current?.click()}>Choose PDF</button></div> :
        <div className="book-grid">{documents.map((document, index) => <article className="book-card" key={document.id}>
          <button className={`book-cover cover-${index % 4}`} onClick={() => onOpen(document.id)}><span className="cover-symbol">{index % 3 === 0 ? "∫" : index % 3 === 1 ? "Σ" : "π"}</span><span className="cover-pages">{document.pageCount} pages</span></button>
          <div className="book-info">{editingId === document.id ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); rename(document); }}><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} autoFocus /><button>Save</button><button type="button" onClick={() => setEditingId("")}>Cancel</button></form> : <button className="desktop-book-title" onClick={() => onOpen(document.id)}><h3>{document.title}</h3></button>}<p>{formatSize(document.fileSize)} · {document.pageCount} pages</p><div className="book-actions"><button className="open-button" onClick={() => onOpen(document.id)}>Open textbook <span>→</span></button><button onClick={() => { setEditingId(document.id); setDraftTitle(document.title); }}>Rename</button><button className="danger-action" onClick={() => discard(document)}>Delete</button></div></div>
        </article>)}</div>}
    </section>
  </main>;
}

function DesktopReader({ documentId, onBack }: { documentId: string; onBack: () => void }) {
  const [document, setDocument] = useState<LocalDocument | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<"highlight" | "area">("highlight");
  const [selectedId, setSelectedId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem(NOTES_WIDTH_KEY));
    const desired = Number.isFinite(stored) && stored > 0 ? stored : 400;
    const maximum = Math.floor(window.innerWidth / 2);
    return clamp(desired, Math.min(320, maximum), maximum);
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [bookStructure, setBookStructure] = useState<BookStructureEntry[]>([]);
  const [structureState, setStructureState] = useState<"idle" | "scanning" | "ready" | "empty" | "error">("idle");
  const [structureProgress, setStructureProgress] = useState(0);
  const [draftArea, setDraftArea] = useState<NormalizedRect | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const pdfStageRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const liveEditorViewRef = useRef<EditorView | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sidebarWidthRef = useRef(sidebarWidth);
  const sidebarResizeStart = useRef<{ pointerId: number; clientX: number; width: number } | null>(null);
  const areaResizeStart = useRef<{ pointerId: number; annotationId: string; handle: AreaResizeHandle; clientX: number; clientY: number; geometry: NormalizedRect } | null>(null);
  const [activeAreaResize, setActiveAreaResize] = useState<AreaResizeHandle | null>(null);

  useEffect(() => {
    Promise.all([getDocument(documentId), listAnnotations(documentId)]).then(async ([record, saved]) => {
      if (!record) throw new Error("This textbook was not found in the local library.");
      const opened = { ...record, lastOpenedAt: new Date().toISOString() }; await putDocument(opened);
      setDocument(opened); setAnnotations(saved); setBookStructure(opened.bookStructure ?? []);
      if (opened.bookStructureScannedAt && opened.bookStructureVersion === BOOK_STRUCTURE_VERSION) setStructureState(opened.bookStructure?.length ? "ready" : "empty");
    }).catch((cause) => setError(message(cause, "This textbook could not be opened."))).finally(() => setLoading(false));
  }, [documentId]);
  useEffect(() => () => saveTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const fitSidebar = () => {
      const width = window.innerWidth;
      const maximum = Math.floor(width / 2);
      setViewportWidth(width);
      setSidebarWidth((current) => {
        const next = clamp(current, Math.min(320, maximum), maximum);
        sidebarWidthRef.current = next;
        return next;
      });
    };
    addEventListener("resize", fitSidebar);
    return () => removeEventListener("resize", fitSidebar);
  }, []);
  useEffect(() => {
    const stage = pdfStageRef.current;
    if (!stage || !document) return;
    let firstFrame = 0;
    let secondFrame = 0;
    const zoomWithWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !pageRef.current) return;
      event.preventDefault();
      const pageBounds = pageRef.current.getBoundingClientRect();
      const anchor = {
        x: clamp((event.clientX - pageBounds.left) / pageBounds.width),
        y: clamp((event.clientY - pageBounds.top) / pageBounds.height),
        clientX: event.clientX,
        clientY: event.clientY,
      };
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stage.clientHeight : 1;
      setZoom((current) => Math.round(clamp(current * Math.exp(-event.deltaY * unit * .0025), .5, 3) * 1000) / 1000);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          const updatedBounds = pageRef.current?.getBoundingClientRect();
          if (!updatedBounds) return;
          stage.scrollLeft += updatedBounds.left + anchor.x * updatedBounds.width - anchor.clientX;
          stage.scrollTop += updatedBounds.top + anchor.y * updatedBounds.height - anchor.clientY;
        });
      });
    };
    stage.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", zoomWithWheel);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [document]);
  const pdfUrl = useMemo(() => document ? URL.createObjectURL(document.file instanceof Blob ? document.file : new Blob([document.file], { type: "application/pdf" })) : "", [document]);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  const save = useCallback(async (annotation: AnnotationRecord) => {
    setSaveState("saving");
    try { await putAnnotation(annotation); setSaveState("saved"); }
    catch (cause) { setSaveState("error"); setError(message(cause, "Your note could not be saved.")); }
  }, []);
  async function readBookStructure(pdf: Parameters<typeof extractBookStructure>[0]) {
    if (!document || document.bookStructureVersion === BOOK_STRUCTURE_VERSION || structureState === "scanning") return;
    setStructureState("scanning"); setStructureProgress(0);
    try {
      const entries = await extractBookStructure(pdf, (page, count) => setStructureProgress(Math.round(page / count * 100)));
      const updated = { ...document, bookStructure: entries, bookStructureScannedAt: new Date().toISOString(), bookStructureVersion: BOOK_STRUCTURE_VERSION, updatedAt: new Date().toISOString() };
      await putDocument(updated);
      setDocument(updated); setBookStructure(entries); setStructureState(entries.length ? "ready" : "empty");
    } catch {
      setStructureState("error");
    }
  }
  function update(id: string, changes: Partial<AnnotationRecord>) {
    setAnnotations((current) => current.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...changes, updatedAt: new Date().toISOString() };
      const timer = saveTimers.current.get(id); if (timer) clearTimeout(timer);
      saveTimers.current.set(id, setTimeout(() => save(next), 450)); setSaveState("saving");
      return next;
    }));
  }
  async function create(type: "text" | "area", geometry: AnnotationGeometry, selectedText: string | null = null) {
    const now = new Date().toISOString();
    const annotation: AnnotationRecord = { id: crypto.randomUUID(), documentId, pageNumber, type, geometry, selectedText, bodyMarkdown: "", color: type === "text" ? "gold" : "sage", createdAt: now, updatedAt: now };
    setAnnotations((current) => [...current, annotation]); setSelectedId(annotation.id); setSidebarOpen(true); await save(annotation);
  }
  async function discard(id: string) { await removeAnnotation(id); setAnnotations((current) => current.filter((item) => item.id !== id)); setSelectedId(""); }

  function editNote(value: string) {
    if (!selected) return;
    update(selected.id, { bodyMarkdown: value });
  }
  function insertCallout() {
    const view = liveEditorViewRef.current;
    if (!view) return;
    const start = view.state.selection.main.from;
    const end = view.state.selection.main.to;
    const source = view.state.doc.toString();
    const chosenText = source.slice(start, end);
    const before = source.slice(0, start);
    const after = source.slice(end);
    const leading = before && !before.endsWith("\n\n") ? before.endsWith("\n") ? "\n" : "\n\n" : "";
    const trailing = after && !after.startsWith("\n\n") ? after.startsWith("\n") ? "\n" : "\n\n" : "";
    const placeholder = "Write your callout here.";
    const quotedBody = chosenText ? chosenText.split("\n").map((line) => `> ${line}`).join("\n") : `> ${placeholder}`;
    const callout = `> [!note] Note\n>\n${quotedBody}`;
    const insertion = `${leading}${callout}${trailing}`;
    const contentStart = start + leading.length + callout.indexOf(chosenText ? quotedBody : placeholder);
    const contentEnd = chosenText ? start + insertion.length : contentStart + placeholder.length;
    view.dispatch({
      changes: { from: start, to: end, insert: insertion },
      selection: { anchor: contentStart, head: contentEnd },
      scrollIntoView: true,
    });
    view.focus();
  }

  function selectText() {
    if (tool !== "highlight" || !pageRef.current) return;
    const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0); if (!pageRef.current.contains(range.commonAncestorContainer)) return;
    const bounds = pageRef.current.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).map((rect) => ({ x: clamp((rect.left - bounds.left) / bounds.width), y: clamp((rect.top - bounds.top) / bounds.height), width: clamp(rect.width / bounds.width), height: clamp(rect.height / bounds.height) })).filter((rect) => rect.width > .002 && rect.height > .002);
    const text = selection.toString().replace(/\s+/g, " ").trim(); if (rects.length && text) create("text", { rects }, text); selection.removeAllRanges();
  }
  function point(event: React.PointerEvent<HTMLDivElement>) { const bounds = event.currentTarget.getBoundingClientRect(); return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) }; }
  function beginArea(event: React.PointerEvent<HTMLDivElement>) { if ((event.target as HTMLElement).closest("button")) return; const p = point(event); drawStart.current = p; setDraftArea({ ...p, width: 0, height: 0 }); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic test pointers do not have an active native pointer. */ } }
  function moveArea(event: React.PointerEvent<HTMLDivElement>) { if (!drawStart.current) return; const p = point(event); setDraftArea({ x: Math.min(drawStart.current.x, p.x), y: Math.min(drawStart.current.y, p.y), width: Math.abs(p.x - drawStart.current.x), height: Math.abs(p.y - drawStart.current.y) }); }
  function endArea(event: React.PointerEvent<HTMLDivElement>) { drawStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDraftArea((current) => current && current.width >= .015 && current.height >= .015 ? current : null); }

  function beginSavedAreaResize(event: React.PointerEvent<HTMLButtonElement>, annotation: AnnotationRecord, handle: AreaResizeHandle) {
    if (isTextGeometry(annotation.geometry)) return;
    event.preventDefault(); event.stopPropagation();
    areaResizeStart.current = { pointerId: event.pointerId, annotationId: annotation.id, handle, clientX: event.clientX, clientY: event.clientY, geometry: annotation.geometry };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic test pointers do not have an active native pointer. */ }
    setSelectedId(annotation.id); setActiveAreaResize(handle);
  }
  function moveSavedAreaResize(event: React.PointerEvent<HTMLButtonElement>) {
    const start = areaResizeStart.current;
    const bounds = pageRef.current?.getBoundingClientRect();
    if (!start || start.pointerId !== event.pointerId || !bounds) return;
    event.preventDefault(); event.stopPropagation();
    update(start.annotationId, { geometry: resizeAreaRect(start.geometry, start.handle, (event.clientX - start.clientX) / bounds.width, (event.clientY - start.clientY) / bounds.height) });
  }
  function endSavedAreaResize(event: React.PointerEvent<HTMLButtonElement>) {
    if (areaResizeStart.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); areaResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setActiveAreaResize(null);
  }
  function resizeSavedAreaWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, annotation: AnnotationRecord, handle: AreaResizeHandle) {
    if (isTextGeometry(annotation.geometry)) return;
    const step = event.shiftKey ? .02 : .005;
    const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const deltaY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (!deltaX && !deltaY) return;
    event.preventDefault(); event.stopPropagation();
    update(annotation.id, { geometry: resizeAreaRect(annotation.geometry, handle, deltaX, deltaY) });
  }

  function setNotesWidth(value: number, persist = false) {
    const maximum = Math.floor(window.innerWidth / 2);
    const next = clamp(value, Math.min(320, maximum), maximum);
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
    if (persist) localStorage.setItem(NOTES_WIDTH_KEY, String(Math.round(next)));
  }
  function beginSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    sidebarResizeStart.current = { pointerId: event.pointerId, clientX: event.clientX, width: sidebarWidthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingSidebar(true);
  }
  function moveSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    const start = sidebarResizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setNotesWidth(start.width + start.clientX - event.clientX);
  }
  function endSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (sidebarResizeStart.current?.pointerId !== event.pointerId) return;
    sidebarResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizingSidebar(false);
    localStorage.setItem(NOTES_WIDTH_KEY, String(Math.round(sidebarWidthRef.current)));
  }
  function resizeSidebarWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 20;
    if (event.key === "ArrowLeft") setNotesWidth(sidebarWidthRef.current + step, true);
    else if (event.key === "ArrowRight") setNotesWidth(sidebarWidthRef.current - step, true);
    else if (event.key === "Home") setNotesWidth(320, true);
    else if (event.key === "End") setNotesWidth(window.innerWidth / 2, true);
    else return;
    event.preventDefault();
  }

  const selected = annotations.find((item) => item.id === selectedId) ?? null;
  const pageAnnotations = annotations.filter((item) => item.pageNumber === pageNumber);
  const latexError = selected ? mathError(selected.bodyMarkdown) : "";
  const annotationGroups = useMemo(() => groupAnnotationsByStructure(annotations, bookStructure), [annotations, bookStructure]);
  const sidebarMaximum = Math.floor(viewportWidth / 2);
  const notesFontScale = clamp(1 + (sidebarWidth - 360) / 1800, 1, 1.2);
  const readerStyle = { "--notes-width": `${sidebarWidth}px`, "--notes-font-scale": notesFontScale } as CSSProperties;
  const readerBodyStyle = sidebarOpen ? { gridTemplateColumns: `minmax(0, 1fr) ${Math.min(sidebarWidth, sidebarMaximum)}px` } : undefined;
  if (loading) return <main className="reader-status"><span className="spinner" /><h1>Opening your textbook…</h1></main>;
  if (!document) return <main className="reader-status"><div className="error-orbit">!</div><h1>We couldn’t open this textbook</h1><p>{error}</p><button className="primary-button" onClick={onBack}>Return to library</button></main>;

  return <main className={`reader-shell ${sidebarOpen ? "sidebar-is-open" : ""} ${resizingSidebar ? "is-resizing-sidebar" : ""}`} style={readerStyle}>
    <header className="reader-header desktop-drag-region"><button className="brand compact desktop-back-brand" onClick={onBack}><span className="brand-mark">M</span><span>MathMargin</span></button><div className="reader-title"><strong>{document.title}</strong><span>{document.pageCount} pages · stored locally</span></div><div className="save-indicator" data-state={saveState}><span />{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</div></header>
    <div className="reader-toolbar"><div className="tool-group"><button className={tool === "highlight" ? "active" : ""} onClick={() => { setTool("highlight"); setDraftArea(null); }}><span className="tool-icon">T</span> Highlight</button><button className={tool === "area" ? "active" : ""} onClick={() => setTool("area")}><span className="tool-icon rectangle-icon" /> Area</button></div><div className="page-controls"><button onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber === 1}>←</button><input value={pageNumber} onChange={(event) => setPageNumber(clamp(Number(event.target.value) || 1, 1, document.pageCount))} /><span>of {document.pageCount}</span><button onClick={() => setPageNumber((page) => Math.min(document.pageCount, page + 1))} disabled={pageNumber === document.pageCount}>→</button></div><div className="zoom-controls" title="Pinch on a touchpad or hold Ctrl while using the mouse wheel"><button onClick={() => setZoom((value) => Math.max(.5, value - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(3, value + .1))}>+</button></div><button className="notes-toggle" onClick={() => setSidebarOpen((value) => !value)}><span>✦</span> Notes <b>{annotations.length}</b></button></div>
    <div className="reader-body" style={readerBodyStyle}><section className="pdf-stage" ref={pdfStageRef}><div className="tool-tip">{tool === "highlight" ? "Select text to add a note" : "Drag over a formula, figure, or passage"} · Pinch or Ctrl+wheel to zoom</div><Document file={pdfUrl} loading={<div className="pdf-loading"><span className="spinner" /> Rendering page…</div>} onLoadSuccess={(pdf) => readBookStructure(pdf as unknown as Parameters<typeof extractBookStructure>[0])} onLoadError={(cause) => setError(message(cause, "The PDF could not be rendered."))}><div className="pdf-page-wrap" ref={pageRef} onMouseUp={selectText}><Page pageNumber={pageNumber} width={Math.round(760 * zoom)} renderAnnotationLayer={false} renderTextLayer />
      <div className="annotation-layer">{pageAnnotations.flatMap((annotation) => (isTextGeometry(annotation.geometry) ? annotation.geometry.rects : [annotation.geometry]).map((rect, index) => <button key={`${annotation.id}-${index}`} type="button" aria-label={`Open ${annotation.type === "area" ? "area" : "highlight"} annotation on page ${annotation.pageNumber}`} title="Open annotation" className={`annotation-mark ${annotation.type} color-${annotation.color} ${selectedId === annotation.id ? "selected" : ""}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} onClick={(event) => { event.stopPropagation(); setSelectedId(annotation.id); setSidebarOpen(true); }} />))}{selected?.type === "area" && selected.pageNumber === pageNumber && !isTextGeometry(selected.geometry) && <div className="saved-area-controls" style={{ left: `${selected.geometry.x * 100}%`, top: `${selected.geometry.y * 100}%`, width: `${selected.geometry.width * 100}%`, height: `${selected.geometry.height * 100}%` }}>{AREA_RESIZE_HANDLES.map((handle) => <button key={handle} type="button" className={`area-resize-handle ${handle} ${activeAreaResize === handle ? "active" : ""}`} aria-label={`Resize area from ${handle === "nw" ? "top left" : handle === "ne" ? "top right" : handle === "sw" ? "bottom left" : "bottom right"}`} title="Drag to resize area" onPointerDown={(event) => beginSavedAreaResize(event, selected, handle)} onPointerMove={moveSavedAreaResize} onPointerUp={endSavedAreaResize} onPointerCancel={endSavedAreaResize} onKeyDown={(event) => resizeSavedAreaWithKeyboard(event, selected, handle)} />)}</div>}</div>
      {tool === "area" && <div className="area-interaction" onPointerDown={beginArea} onPointerMove={moveArea} onPointerUp={endArea}>{draftArea && <div className="draft-area" style={{ left: `${draftArea.x * 100}%`, top: `${draftArea.y * 100}%`, width: `${draftArea.width * 100}%`, height: `${draftArea.height * 100}%` }}>{draftArea.width >= .015 && draftArea.height >= .015 && <div className="draft-actions"><button onClick={() => { create("area", draftArea); setDraftArea(null); }}>Annotate area</button><button onClick={() => setDraftArea(null)}>Cancel</button></div>}</div>}</div>}
    </div></Document>{error && <div className="reader-toast"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}</section>
      <aside className="notes-panel">{sidebarOpen && <div className="notes-resizer" role="separator" aria-label="Resize annotation panel" aria-orientation="vertical" aria-valuemin={Math.min(320, sidebarMaximum)} aria-valuemax={sidebarMaximum} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0} title="Drag to resize annotations" onPointerDown={beginSidebarResize} onPointerMove={moveSidebarResize} onPointerUp={endSidebarResize} onPointerCancel={endSidebarResize} onKeyDown={resizeSidebarWithKeyboard} />}<div className="notes-header"><div><p className="eyebrow">Local notebook</p><h2>Annotations</h2></div><button onClick={() => setSidebarOpen(false)}>×</button></div>{selected ? <div className="note-editor"><button className="back-to-notes" onClick={() => setSelectedId("")}>← All annotations</button><div className="note-meta"><span>{selected.type === "text" ? "Highlighted text" : "Selected area"}</span><button onClick={() => setPageNumber(selected.pageNumber)}>Page {selected.pageNumber}</button></div>{selected.selectedText && <blockquote>“{selected.selectedText}”</blockquote>}<div className="color-row"><span>Marker</span>{ANNOTATION_COLORS.map((color) => <button key={color} className={`color-dot ${color} ${selected.color === color ? "active" : ""}`} onClick={() => update(selected.id, { color: color as AnnotationColor })} />)}</div><label className="editor-label">Your note <span>Obsidian-style live editing</span></label><div className="note-input-tools"><div className="latex-suite-status" title="Your active Obsidian LaTeX Suite snippet set is enabled. Automatic snippets expand as you type; press Tab for manual snippets and placeholder navigation."><span>⌨</span> LaTeX Suite · {LATEX_SUITE_SHORTCUT_COUNT} shortcuts · Tab to expand</div><button type="button" className="insert-callout-button" onClick={insertCallout} title="Insert an Obsidian-style note callout">＋ Callout</button></div><LiveNoteEditor key={selected.id} value={selected.bodyMarkdown} onChange={editNote} viewRef={liveEditorViewRef} macros={KATEX_MACROS} />{latexError && <div className="latex-error"><strong>LaTeX needs attention</strong>{latexError}</div>}<div className="editor-footer"><span>{selected.bodyMarkdown.length.toLocaleString()} characters</span><button className="delete-note" onClick={() => discard(selected.id)}>Delete annotation</button></div></div> : <div className="notes-list">{structureState === "scanning" && <div className="structure-status"><span className="spinner" /> Reading chapters and sections{structureProgress ? ` · ${structureProgress}%` : "…"}</div>}{structureState === "error" && <div className="structure-status warning">Chapter detection could not finish. Notes are still grouped by page.</div>}{structureState === "empty" && <div className="structure-status">No chapter headings were found in this PDF.</div>}{annotationGroups.length ? annotationGroups.map((chapter) => <section className="annotation-chapter" key={chapter.key}><button type="button" className="annotation-chapter-heading" data-page-number={chapter.pageNumber} onClick={() => setPageNumber(chapter.pageNumber)} title={`Go to page ${chapter.pageNumber}`}><strong>{chapter.number ? `Chapter ${chapter.number} · ` : ""}{structureTitle(chapter.title, chapter.number, 0)}</strong><span>{chapter.sections.reduce((total, section) => total + section.annotations.length, 0)}</span></button>{chapter.sections.map((section) => <div className="annotation-section" key={section.key}><button type="button" className="annotation-section-heading" data-page-number={section.pageNumber} onClick={() => setPageNumber(section.pageNumber)} title={`Go to page ${section.pageNumber}`}><span>{section.number ? `Section ${section.number} · ` : ""}{structureTitle(section.title, section.number, 1)}</span><small>{section.annotations.length} {section.annotations.length === 1 ? "note" : "notes"}</small></button>{section.annotations.map((annotation) => <button className="note-card" key={annotation.id} onClick={() => { setSelectedId(annotation.id); setPageNumber(annotation.pageNumber); }}><span className={`note-stripe ${annotation.color}`} /><span className="note-card-copy"><span className="note-card-meta">Page {annotation.pageNumber} · {annotation.type}</span><strong>{annotation.bodyMarkdown || annotation.selectedText || "Untitled annotation"}</strong></span><span>→</span></button>)}{!section.annotations.length && <div className="empty-section-notes">No notes in this section</div>}</div>)}{!chapter.sections.length && <div className="empty-section-notes chapter-empty">No sections or notes yet</div>}</section>) : <div className="notes-empty"><div>∴</div><h3>No annotations yet</h3><p>Select text or draw an area on the page. Your note will open here.</p></div>}</div>}</aside>
    </div>
  </main>;
}

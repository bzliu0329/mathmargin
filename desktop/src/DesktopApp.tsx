import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import katex from "katex";
import type { AnnotationColor, AnnotationGeometry, AnnotationRecord, NormalizedRect } from "../../lib/types";
import { ANNOTATION_COLORS, MAX_PDF_SIZE } from "../../lib/types";
import { getDocument, listAnnotations, listDocuments, putAnnotation, putDocument, removeAnnotation, removeDocument, type LocalDocument } from "./storage";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

function clamp(value: number, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function isTextGeometry(value: AnnotationGeometry): value is { rects: NormalizedRect[] } { return "rects" in value; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function formatSize(bytes: number) { return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
function mathError(markdown: string) {
  try {
    const blocks = [...markdown.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((match) => match[1]);
    const inline = [...markdown.replace(/\$\$[\s\S]*?\$\$/g, "").matchAll(/(^|[^\\])\$([^\n$]+?)\$/g)].map((match) => match[2]);
    for (const expression of [...blocks, ...inline]) katex.renderToString(expression, { throwOnError: true });
    return "";
  } catch (error) { return message(error, "This equation has a LaTeX error.").replace(/^KaTeX parse error:\s*/i, ""); }
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
    try {
      const data = await file.arrayBuffer();
      const task = pdfjs.getDocument({ data: data.slice(0) });
      const pdf = await task.promise;
      const now = new Date().toISOString();
      const record: LocalDocument = {
        id: crypto.randomUUID(), title: file.name.replace(/\.pdf$/i, ""), originalFilename: file.name,
        fileSize: file.size, pageCount: pdf.numPages, createdAt: now, updatedAt: now, lastOpenedAt: now,
        file: new Blob([data], { type: "application/pdf" }),
      };
      await pdf.destroy();
      await putDocument(record);
      setDocuments((current) => [record, ...current]);
    } catch (cause) {
      const detail = message(cause, "This PDF could not be read.");
      setError(/password/i.test(detail) ? "Password-protected PDFs are not supported yet." : /invalid|format|missing pdf/i.test(detail) ? "This PDF appears to be corrupted or invalid." : detail);
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
  const [draftArea, setDraftArea] = useState<NormalizedRect | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const pageRef = useRef<HTMLDivElement>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    Promise.all([getDocument(documentId), listAnnotations(documentId)]).then(async ([record, saved]) => {
      if (!record) throw new Error("This textbook was not found in the local library.");
      const opened = { ...record, lastOpenedAt: new Date().toISOString() }; await putDocument(opened);
      setDocument(opened); setAnnotations(saved);
    }).catch((cause) => setError(message(cause, "This textbook could not be opened."))).finally(() => setLoading(false));
  }, [documentId]);
  useEffect(() => () => saveTimers.current.forEach(clearTimeout), []);
  const pdfUrl = useMemo(() => document ? URL.createObjectURL(document.file) : "", [document]);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  const save = useCallback(async (annotation: AnnotationRecord) => {
    setSaveState("saving");
    try { await putAnnotation(annotation); setSaveState("saved"); }
    catch (cause) { setSaveState("error"); setError(message(cause, "Your note could not be saved.")); }
  }, []);
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

  function selectText() {
    if (tool !== "highlight" || !pageRef.current) return;
    const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0); if (!pageRef.current.contains(range.commonAncestorContainer)) return;
    const bounds = pageRef.current.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).map((rect) => ({ x: clamp((rect.left - bounds.left) / bounds.width), y: clamp((rect.top - bounds.top) / bounds.height), width: clamp(rect.width / bounds.width), height: clamp(rect.height / bounds.height) })).filter((rect) => rect.width > .002 && rect.height > .002);
    const text = selection.toString().replace(/\s+/g, " ").trim(); if (rects.length && text) create("text", { rects }, text); selection.removeAllRanges();
  }
  function point(event: React.PointerEvent<HTMLDivElement>) { const bounds = event.currentTarget.getBoundingClientRect(); return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) }; }
  function beginArea(event: React.PointerEvent<HTMLDivElement>) { if ((event.target as HTMLElement).closest("button")) return; const p = point(event); drawStart.current = p; setDraftArea({ ...p, width: 0, height: 0 }); event.currentTarget.setPointerCapture(event.pointerId); }
  function moveArea(event: React.PointerEvent<HTMLDivElement>) { if (!drawStart.current) return; const p = point(event); setDraftArea({ x: Math.min(drawStart.current.x, p.x), y: Math.min(drawStart.current.y, p.y), width: Math.abs(p.x - drawStart.current.x), height: Math.abs(p.y - drawStart.current.y) }); }
  function endArea(event: React.PointerEvent<HTMLDivElement>) { drawStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDraftArea((current) => current && current.width >= .015 && current.height >= .015 ? current : null); }

  const selected = annotations.find((item) => item.id === selectedId) ?? null;
  const pageAnnotations = annotations.filter((item) => item.pageNumber === pageNumber);
  const latexError = selected ? mathError(selected.bodyMarkdown) : "";
  if (loading) return <main className="reader-status"><span className="spinner" /><h1>Opening your textbook…</h1></main>;
  if (!document) return <main className="reader-status"><div className="error-orbit">!</div><h1>We couldn’t open this textbook</h1><p>{error}</p><button className="primary-button" onClick={onBack}>Return to library</button></main>;

  return <main className={`reader-shell ${sidebarOpen ? "sidebar-is-open" : ""}`}>
    <header className="reader-header desktop-drag-region"><button className="brand compact desktop-back-brand" onClick={onBack}><span className="brand-mark">M</span><span>MathMargin</span></button><div className="reader-title"><strong>{document.title}</strong><span>{document.pageCount} pages · stored locally</span></div><div className="save-indicator" data-state={saveState}><span />{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</div></header>
    <div className="reader-toolbar"><div className="tool-group"><button className={tool === "highlight" ? "active" : ""} onClick={() => { setTool("highlight"); setDraftArea(null); }}><span className="tool-icon">T</span> Highlight</button><button className={tool === "area" ? "active" : ""} onClick={() => setTool("area")}><span className="tool-icon rectangle-icon" /> Area</button></div><div className="page-controls"><button onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber === 1}>←</button><input value={pageNumber} onChange={(event) => setPageNumber(clamp(Number(event.target.value) || 1, 1, document.pageCount))} /><span>of {document.pageCount}</span><button onClick={() => setPageNumber((page) => Math.min(document.pageCount, page + 1))} disabled={pageNumber === document.pageCount}>→</button></div><div className="zoom-controls"><button onClick={() => setZoom((value) => Math.max(.65, value - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(1.8, value + .1))}>+</button></div><button className="notes-toggle" onClick={() => setSidebarOpen((value) => !value)}><span>✦</span> Notes <b>{annotations.length}</b></button></div>
    <div className="reader-body"><section className="pdf-stage"><div className="tool-tip">{tool === "highlight" ? "Select text to add a note" : "Drag over a formula, figure, or passage"}</div><Document file={pdfUrl} loading={<div className="pdf-loading"><span className="spinner" /> Rendering page…</div>} onLoadError={(cause) => setError(message(cause, "The PDF could not be rendered."))}><div className="pdf-page-wrap" ref={pageRef} onMouseUp={selectText}><Page pageNumber={pageNumber} width={Math.round(760 * zoom)} renderAnnotationLayer={false} renderTextLayer />
      <div className="annotation-layer">{pageAnnotations.flatMap((annotation) => (isTextGeometry(annotation.geometry) ? annotation.geometry.rects : [annotation.geometry]).map((rect, index) => <button key={`${annotation.id}-${index}`} className={`annotation-mark ${annotation.type} color-${annotation.color} ${selectedId === annotation.id ? "selected" : ""}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} onClick={() => { setSelectedId(annotation.id); setSidebarOpen(true); }} />))}</div>
      {tool === "area" && <div className="area-interaction" onPointerDown={beginArea} onPointerMove={moveArea} onPointerUp={endArea}>{draftArea && <div className="draft-area" style={{ left: `${draftArea.x * 100}%`, top: `${draftArea.y * 100}%`, width: `${draftArea.width * 100}%`, height: `${draftArea.height * 100}%` }}>{draftArea.width >= .015 && draftArea.height >= .015 && <div className="draft-actions"><button onClick={() => { create("area", draftArea); setDraftArea(null); }}>Annotate area</button><button onClick={() => setDraftArea(null)}>Cancel</button></div>}</div>}</div>}
    </div></Document>{error && <div className="reader-toast"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}</section>
    <aside className="notes-panel"><div className="notes-header"><div><p className="eyebrow">Local notebook</p><h2>Annotations</h2></div><button onClick={() => setSidebarOpen(false)}>×</button></div>{selected ? <div className="note-editor"><button className="back-to-notes" onClick={() => setSelectedId("")}>← All annotations</button><div className="note-meta"><span>{selected.type === "text" ? "Highlighted text" : "Selected area"}</span><button onClick={() => setPageNumber(selected.pageNumber)}>Page {selected.pageNumber}</button></div>{selected.selectedText && <blockquote>“{selected.selectedText}”</blockquote>}<div className="color-row"><span>Marker</span>{ANNOTATION_COLORS.map((color) => <button key={color} className={`color-dot ${color} ${selected.color === color ? "active" : ""}`} onClick={() => update(selected.id, { color: color as AnnotationColor })} />)}</div><label className="editor-label">Your note <span>Markdown + LaTeX</span></label><textarea value={selected.bodyMarkdown} onChange={(event) => update(selected.id, { bodyMarkdown: event.target.value })} placeholder={"Write your reasoning…\n\nUse $x^2$ for inline math or:\n$$\\int_a^b f(x)\\,dx$$"} />{latexError && <div className="latex-error"><strong>LaTeX needs attention</strong>{latexError}</div>}<div className="preview-label">Rendered preview</div><div className={`note-preview ${!selected.bodyMarkdown ? "empty" : ""}`}>{selected.bodyMarkdown ? <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{selected.bodyMarkdown}</ReactMarkdown> : <span>Your formatted note will appear here.</span>}</div><div className="editor-footer"><span>{selected.bodyMarkdown.length.toLocaleString()} characters</span><button className="delete-note" onClick={() => discard(selected.id)}>Delete annotation</button></div></div> : <div className="notes-list">{annotations.length ? annotations.map((annotation) => <button className="note-card" key={annotation.id} onClick={() => { setSelectedId(annotation.id); setPageNumber(annotation.pageNumber); }}><span className={`note-stripe ${annotation.color}`} /><span className="note-card-copy"><span className="note-card-meta">Page {annotation.pageNumber} · {annotation.type}</span><strong>{annotation.bodyMarkdown || annotation.selectedText || "Untitled annotation"}</strong></span><span>→</span></button>) : <div className="notes-empty"><div>∴</div><h3>No annotations yet</h3><p>Select text or draw an area on the page. Your note will open here.</p></div>}</div>}</aside>
    </div>
  </main>;
}

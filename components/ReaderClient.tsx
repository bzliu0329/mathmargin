"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import katex from "katex";
import type { AnnotationColor, AnnotationGeometry, AnnotationRecord, DocumentRecord, NormalizedRect } from "@/lib/types";
import { ANNOTATION_COLORS } from "@/lib/types";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

type Tool = "highlight" | "area";
type SaveState = "saved" | "saving" | "error";
type AreaGesture = { kind: "draw"; startX: number; startY: number } | { kind: "resize-draft" } | { kind: "resize-saved"; id: string };

function clamp(value: number, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function isTextGeometry(value: AnnotationGeometry): value is { rects: NormalizedRect[] } { return "rects" in value; }
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

function validateMath(markdown: string) {
  try {
    const blocks = [...markdown.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((match) => match[1]);
    const withoutBlocks = markdown.replace(/\$\$[\s\S]*?\$\$/g, "");
    const inline = [...withoutBlocks.matchAll(/(^|[^\\])\$([^\n$]+?)\$/g)].map((match) => match[2]);
    for (const expression of [...blocks, ...inline]) katex.renderToString(expression, { throwOnError: true, strict: "warn" });
    return "";
  } catch (error) {
    return errorMessage(error, "This equation has a LaTeX error.").replace(/^KaTeX parse error:\s*/i, "");
  }
}

export function ReaderClient({ documentId }: { documentId: string }) {
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>("highlight");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftArea, setDraftArea] = useState<NormalizedRect | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<AreaGesture | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<string, Partial<AnnotationRecord>>());

  useEffect(() => {
    Promise.all([
      fetch(`/api/documents/${documentId}`).then(async (response) => { const data = await response.json() as { error?: string; document: DocumentRecord }; if (!response.ok) throw new Error(data.error); return data.document; }),
      fetch(`/api/documents/${documentId}/annotations`).then(async (response) => { const data = await response.json() as { error?: string; annotations: AnnotationRecord[] }; if (!response.ok) throw new Error(data.error); return data.annotations; }),
    ]).then(([nextDocument, nextAnnotations]) => {
      setDocument(nextDocument); setPageCount(nextDocument.pageCount); setAnnotations(nextAnnotations);
    }).catch((cause) => setError(errorMessage(cause, "We could not open this textbook."))).finally(() => setLoading(false));
  }, [documentId]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const persist = useCallback(async (id: string) => {
    const changes = pending.current.get(id);
    if (!changes) return;
    pending.current.delete(id);
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setSaveState("saving");
    try {
      const response = await fetch(`/api/documents/${documentId}/annotations/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
      });
      const data = await response.json() as { error?: string; annotation: AnnotationRecord };
      if (!response.ok) throw new Error(data.error);
      setAnnotations((current) => current.map((item) => {
        if (item.id !== id) return item;
        return pending.current.has(id) ? { ...item, updatedAt: data.annotation.updatedAt } : data.annotation;
      }));
      setSaveState(pending.current.size ? "saving" : "saved");
    } catch (cause) {
      pending.current.set(id, { ...changes, ...pending.current.get(id) });
      setError(errorMessage(cause, "Your note could not be saved."));
      setSaveState("error");
    }
  }, [documentId]);

  const scheduleSave = useCallback((id: string, changes: Partial<AnnotationRecord>) => {
    pending.current.set(id, { ...pending.current.get(id), ...changes });
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(id, setTimeout(() => persist(id), 650));
    setSaveState("saving");
  }, [persist]);

  const createAnnotation = useCallback(async (payload: { type: "text" | "area"; geometry: AnnotationGeometry; selectedText?: string }) => {
    try {
      setSaveState("saving");
      const response = await fetch(`/api/documents/${documentId}/annotations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, pageNumber, color: payload.type === "text" ? "gold" : "sage", bodyMarkdown: "" }),
      });
      const data = await response.json() as { error?: string; annotation: AnnotationRecord };
      if (!response.ok) throw new Error(data.error);
      setAnnotations((current) => [...current, data.annotation]);
      setSelectedId(data.annotation.id); setSidebarOpen(true); setSaveState("saved");
      requestAnimationFrame(() => window.document.querySelector<HTMLTextAreaElement>(`[data-editor="${data.annotation.id}"]`)?.focus());
    } catch (cause) {
      setError(errorMessage(cause, "We could not create this annotation.")); setSaveState("error");
    }
  }, [documentId, pageNumber]);

  function handleTextSelection() {
    if (tool !== "highlight" || !pageRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!pageRef.current.contains(range.commonAncestorContainer)) return;
    const bounds = pageRef.current.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).map((rect) => ({
      x: clamp((rect.left - bounds.left) / bounds.width), y: clamp((rect.top - bounds.top) / bounds.height),
      width: clamp(rect.width / bounds.width), height: clamp(rect.height / bounds.height),
    })).filter((rect) => rect.width > .002 && rect.height > .002 && rect.x < 1 && rect.y < 1);
    const selectedText = selection.toString().replace(/\s+/g, " ").trim();
    if (rects.length && selectedText) createAnnotation({ type: "text", geometry: { rects }, selectedText });
    selection.removeAllRanges();
  }

  function point(event: React.PointerEvent) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) };
  }

  function areaPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "area" || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.classList.contains("resize-handle")) return;
    const p = point(event); gesture.current = { kind: "draw", startX: p.x, startY: p.y };
    setDraftArea({ x: p.x, y: p.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function areaPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    const p = point(event);
    if (active.kind === "draw") {
      setDraftArea({ x: Math.min(active.startX, p.x), y: Math.min(active.startY, p.y), width: Math.abs(p.x - active.startX), height: Math.abs(p.y - active.startY) });
    } else if (active.kind === "resize-draft") {
      setDraftArea((current) => current ? { ...current, width: clamp(p.x - current.x, .015, 1 - current.x), height: clamp(p.y - current.y, .015, 1 - current.y) } : current);
    } else {
      setAnnotations((current) => current.map((item) => item.id === active.id && !isTextGeometry(item.geometry)
        ? { ...item, geometry: { ...item.geometry, width: clamp(p.x - item.geometry.x, .015, 1 - item.geometry.x), height: clamp(p.y - item.geometry.y, .015, 1 - item.geometry.y) } }
        : item));
    }
  }

  function areaPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (active?.kind === "draw") setDraftArea((current) => current && current.width >= .015 && current.height >= .015 ? current : null);
    if (active?.kind === "resize-saved") {
      const item = annotations.find((annotation) => annotation.id === active.id);
      if (item) scheduleSave(item.id, { geometry: item.geometry });
    }
  }

  function updateAnnotation(id: string, changes: Partial<AnnotationRecord>) {
    setAnnotations((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
    scheduleSave(id, changes);
  }

  async function deleteAnnotation(id: string) {
    try {
      const response = await fetch(`/api/documents/${documentId}/annotations/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error);
      setAnnotations((current) => current.filter((item) => item.id !== id));
      setSelectedId(null); setSaveState("saved");
    } catch (cause) { setError(errorMessage(cause, "We could not delete this annotation.")); }
  }

  const selected = annotations.find((item) => item.id === selectedId) ?? null;
  const pageAnnotations = annotations.filter((item) => item.pageNumber === pageNumber);
  const latexError = useMemo(() => selected ? validateMath(selected.bodyMarkdown) : "", [selected]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { setDraftArea(null); gesture.current = null; }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && draftArea) { createAnnotation({ type: "area", geometry: draftArea }); setDraftArea(null); }
    }
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [createAnnotation, draftArea]);

  if (loading) return <main className="reader-status"><span className="spinner" /><h1>Opening your textbook…</h1><p>Preparing the pages and your annotations.</p></main>;
  if (error && !document) return <main className="reader-status"><div className="error-orbit">!</div><h1>We couldn’t open this textbook</h1><p>{error}</p><a className="primary-button" href="/">Return to library</a></main>;

  return (
    <main className={`reader-shell ${sidebarOpen ? "sidebar-is-open" : ""}`}>
      <header className="reader-header">
        <a className="brand compact" href="/"><span className="brand-mark">M</span><span>MathMargin</span></a>
        <div className="reader-title"><strong>{document?.title}</strong><span>{pageCount || document?.pageCount} pages</span></div>
        <div className="save-indicator" data-state={saveState}><span />{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}{saveState === "error" && <button onClick={() => selectedId && persist(selectedId)}>Retry</button>}</div>
      </header>

      <div className="reader-toolbar" aria-label="PDF tools">
        <div className="tool-group"><button className={tool === "highlight" ? "active" : ""} onClick={() => { setTool("highlight"); setDraftArea(null); }} aria-pressed={tool === "highlight"}><span className="tool-icon">T</span> Highlight</button><button className={tool === "area" ? "active" : ""} onClick={() => setTool("area")} aria-pressed={tool === "area"}><span className="tool-icon rectangle-icon" /> Area</button></div>
        <div className="page-controls"><button onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber <= 1} aria-label="Previous page">←</button><label><span className="sr-only">Current page</span><input value={pageNumber} onChange={(event) => setPageNumber(clamp(Number(event.target.value) || 1, 1, pageCount || 1))} /></label><span>of {pageCount || "—"}</span><button onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))} disabled={pageNumber >= pageCount} aria-label="Next page">→</button></div>
        <div className="zoom-controls"><button onClick={() => setZoom((value) => Math.max(.65, value - .1))} aria-label="Zoom out">−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(1.8, value + .1))} aria-label="Zoom in">+</button></div>
        <button className="notes-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-expanded={sidebarOpen}><span>✦</span> Notes <b>{annotations.length}</b></button>
      </div>

      <div className="reader-body">
        <section className="pdf-stage" aria-label={`Page ${pageNumber}`}>
          <div className="tool-tip">{tool === "highlight" ? "Select text to add a note" : "Drag over a formula, figure, or passage"}</div>
          <Document file={`/api/documents/${documentId}/file`} onLoadSuccess={(pdf) => { setPageCount(pdf.numPages); setPageNumber((page) => Math.min(page, pdf.numPages)); }}
            onLoadError={(cause) => setError(/password/i.test(cause.message) ? "This PDF is password-protected." : "The PDF could not be rendered.")}
            loading={<div className="pdf-loading"><span className="spinner" /> Rendering page…</div>}>
            <div className="pdf-page-wrap" ref={pageRef} onMouseUp={handleTextSelection}>
              <Page pageNumber={pageNumber} width={Math.round(760 * zoom)} renderAnnotationLayer={false} renderTextLayer={true} loading="" />
              <div className="annotation-layer" aria-hidden="true">
                {pageAnnotations.flatMap((annotation) => {
                  const rects = isTextGeometry(annotation.geometry) ? annotation.geometry.rects : [annotation.geometry];
                  return rects.map((rect, index) => <button key={`${annotation.id}-${index}`} className={`annotation-mark ${annotation.type} color-${annotation.color} ${selectedId === annotation.id ? "selected" : ""}`}
                    style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
                    onClick={() => { setSelectedId(annotation.id); setSidebarOpen(true); }} tabIndex={index === 0 ? 0 : -1} aria-label={`Open annotation on page ${annotation.pageNumber}`} />);
                })}
              </div>
              {tool === "area" && <div className="area-interaction" onPointerDown={areaPointerDown} onPointerMove={areaPointerMove} onPointerUp={areaPointerUp} onPointerCancel={areaPointerUp}>
                {draftArea && <div className="draft-area" style={{ left: `${draftArea.x * 100}%`, top: `${draftArea.y * 100}%`, width: `${draftArea.width * 100}%`, height: `${draftArea.height * 100}%` }}>
                  <button className="resize-handle" aria-label="Resize annotation area" onPointerDown={(event) => { event.stopPropagation(); gesture.current = { kind: "resize-draft" }; event.currentTarget.setPointerCapture(event.pointerId); }} />
                  {draftArea.width >= .015 && draftArea.height >= .015 && <div className="draft-actions"><button onClick={(event) => { event.stopPropagation(); createAnnotation({ type: "area", geometry: draftArea }); setDraftArea(null); }}>Annotate area</button><button onClick={(event) => { event.stopPropagation(); setDraftArea(null); }}>Cancel</button></div>}
                </div>}
                {selected?.type === "area" && !isTextGeometry(selected.geometry) && <button className="resize-handle saved" aria-label="Resize selected annotation" style={{ left: `${(selected.geometry.x + selected.geometry.width) * 100}%`, top: `${(selected.geometry.y + selected.geometry.height) * 100}%` }}
                  onPointerDown={(event) => { event.stopPropagation(); gesture.current = { kind: "resize-saved", id: selected.id }; event.currentTarget.setPointerCapture(event.pointerId); }} />}
              </div>}
            </div>
          </Document>
          {error && <div className="reader-toast" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
        </section>

        <aside className="notes-panel" aria-label="Annotations">
          <div className="notes-header"><div><p className="eyebrow">Notebook</p><h2>Annotations</h2></div><button onClick={() => setSidebarOpen(false)} aria-label="Close annotations">×</button></div>
          {selected ? (
            <div className="note-editor">
              <button className="back-to-notes" onClick={() => setSelectedId(null)}>← All annotations</button>
              <div className="note-meta"><span>{selected.type === "text" ? "Highlighted text" : "Selected area"}</span><button onClick={() => { setPageNumber(selected.pageNumber); }}>Page {selected.pageNumber}</button></div>
              {selected.selectedText && <blockquote>“{selected.selectedText}”</blockquote>}
              <div className="color-row"><span>Marker</span>{ANNOTATION_COLORS.map((color) => <button key={color} className={`color-dot ${color} ${selected.color === color ? "active" : ""}`} onClick={() => updateAnnotation(selected.id, { color: color as AnnotationColor })} aria-label={`Use ${color} marker`} aria-pressed={selected.color === color} />)}</div>
              <label className="editor-label" htmlFor={`note-${selected.id}`}>Your note <span>Markdown + LaTeX</span></label>
              <textarea id={`note-${selected.id}`} data-editor={selected.id} value={selected.bodyMarkdown} onChange={(event) => updateAnnotation(selected.id, { bodyMarkdown: event.target.value })} onBlur={() => persist(selected.id)} placeholder={"Write your reasoning…\n\nUse $x^2$ for inline math or:\n$$\\int_a^b f(x)\\,dx$$"} />
              {latexError && <div className="latex-error" role="status"><strong>LaTeX needs attention</strong>{latexError}</div>}
              <div className="preview-label">Rendered preview</div>
              <div className={`note-preview ${!selected.bodyMarkdown ? "empty" : ""}`}>
                {selected.bodyMarkdown ? <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{selected.bodyMarkdown}</ReactMarkdown> : <span>Your formatted note will appear here.</span>}
              </div>
              <div className="editor-footer"><span>{selected.bodyMarkdown.length.toLocaleString()} characters</span><button className="delete-note" onClick={() => deleteAnnotation(selected.id)}>Delete annotation</button></div>
            </div>
          ) : (
            <div className="notes-list">
              {annotations.length ? annotations.map((annotation) => <button key={annotation.id} className="note-card" onClick={() => { setSelectedId(annotation.id); setPageNumber(annotation.pageNumber); }}>
                <span className={`note-stripe ${annotation.color}`} /><span className="note-card-copy"><span className="note-card-meta">Page {annotation.pageNumber} · {annotation.type === "text" ? "Highlight" : "Area"}</span><strong>{annotation.bodyMarkdown || annotation.selectedText || "Untitled annotation"}</strong></span><span>→</span>
              </button>) : <div className="notes-empty"><div>∴</div><h3>No annotations yet</h3><p>Select text or draw an area on the page. Your note will open here.</p></div>}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

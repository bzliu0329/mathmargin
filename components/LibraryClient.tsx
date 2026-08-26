"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentRecord } from "@/lib/types";
import { MAX_PDF_SIZE } from "@/lib/types";

function formatSize(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function LibraryClient() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/documents").then(async (response) => {
      const data = await response.json() as { error?: string; documents: DocumentRecord[] };
      if (!response.ok) throw new Error(data.error);
      setDocuments(data.documents);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "We could not load your library."))
      .finally(() => setLoading(false));
  }, []);

  async function upload(file?: File) {
    if (!file || uploading) return;
    setError("");
    if (file.size > MAX_PDF_SIZE) return setError("This PDF is larger than the 120 MB limit.");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return setError("Choose a PDF file to continue.");
    setUploading(true);
    try {
      const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
      GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const loadingTask = getDocument({ data: await file.arrayBuffer() });
      const pdf = await loadingTask.promise;
      const pageCount = pdf.numPages;
      await pdf.destroy();
      const form = new FormData();
      form.set("file", file);
      form.set("pageCount", String(pageCount));
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const data = await response.json() as { error?: string; document: DocumentRecord };
      if (!response.ok) throw new Error(data.error);
      setDocuments((current) => [data.document, ...current]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "We could not read this PDF.";
      if (/password/i.test(message)) setError("Password-protected PDFs are not supported yet.");
      else if (/invalid|missing pdf|format/i.test(message)) setError("This PDF appears to be corrupted or invalid.");
      else setError(message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function saveTitle(document: DocumentRecord) {
    const title = draftTitle.trim();
    if (!title) return;
    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
      });
      const data = await response.json() as { error?: string; document: DocumentRecord };
      if (!response.ok) throw new Error(data.error);
      setDocuments((current) => current.map((item) => item.id === document.id ? data.document : item));
      setEditingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not rename this textbook.");
    }
  }

  async function removeDocument(document: DocumentRecord) {
    if (!window.confirm(`Delete “${document.title}” and all of its annotations?`)) return;
    try {
      const response = await fetch(`/api/documents/${document.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not delete this textbook.");
    }
  }

  return (
    <main className="library-shell">
      <header className="library-header">
        <a className="brand" href="/" aria-label="MathMargin home"><span className="brand-mark">M</span><span>MathMargin</span></a>
        <span className="privacy-pill"><span aria-hidden="true">●</span> Private workspace</span>
      </header>

      <section className="library-hero">
        <div>
          <p className="eyebrow">Your mathematical reading room</p>
          <h1>Read closely.<br />Think in the margins.</h1>
          <p className="hero-copy">Upload a textbook, highlight the ideas that matter, and keep notes with beautifully rendered LaTeX right beside the page.</p>
        </div>
        <div>
          <label className={`upload-card ${dragging ? "is-dragging" : ""} ${uploading ? "is-uploading" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files[0]); }}>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" onChange={(event) => upload(event.target.files?.[0])} disabled={uploading} />
            <span className="upload-icon" aria-hidden="true">{uploading ? "…" : "↑"}</span>
            <strong>{uploading ? "Reading and saving your PDF…" : "Drop a PDF here"}</strong>
            <span>{uploading ? "This can take a moment for a large textbook" : "or choose a file from your computer"}</span>
            <small>PDF · up to 120 MB</small>
          </label>
          {error && <div className="library-error" role="alert"><span>!</span>{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
        </div>
      </section>

      <section className="books-section" aria-labelledby="books-title">
        <div className="section-heading"><div><p className="eyebrow">Library</p><h2 id="books-title">Your textbooks</h2></div><span className="book-count">{documents.length} {documents.length === 1 ? "book" : "books"}</span></div>
        {loading ? (
          <div className="loading-row"><span className="spinner" /> Opening your library…</div>
        ) : documents.length === 0 ? (
          <div className="empty-library"><div className="empty-glyph" aria-hidden="true">∫</div><div><h3>Your library is ready</h3><p>Upload your first textbook to begin making mathematical notes.</p></div><button className="text-button" onClick={() => inputRef.current?.click()}>Choose PDF</button></div>
        ) : (
          <div className="book-grid">
            {documents.map((document, index) => (
              <article className="book-card" key={document.id}>
                <a className={`book-cover cover-${index % 4}`} href={`/reader/${document.id}`} aria-label={`Open ${document.title}`}>
                  <span className="cover-symbol">{index % 3 === 0 ? "∫" : index % 3 === 1 ? "Σ" : "π"}</span>
                  <span className="cover-pages">{document.pageCount} pages</span>
                </a>
                <div className="book-info">
                  {editingId === document.id ? (
                    <form onSubmit={(event) => { event.preventDefault(); saveTitle(document); }} className="rename-form">
                      <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} autoFocus maxLength={160} aria-label="Textbook title" />
                      <button type="submit">Save</button><button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                    </form>
                  ) : <a href={`/reader/${document.id}`}><h3>{document.title}</h3></a>}
                  <p>{formatSize(document.fileSize)} · {document.pageCount} pages</p>
                  <div className="book-actions">
                    <a className="open-button" href={`/reader/${document.id}`}>Open textbook <span>→</span></a>
                    <button onClick={() => { setEditingId(document.id); setDraftTitle(document.title); }} aria-label={`Rename ${document.title}`}>Rename</button>
                    <button className="danger-action" onClick={() => removeDocument(document)} aria-label={`Delete ${document.title}`}>Delete</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

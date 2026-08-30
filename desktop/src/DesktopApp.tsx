import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { Document, Page, pdfjs } from "react-pdf";
import katex from "katex";
import "katex/contrib/mhchem/mhchem.js";
import type { AnnotationColor, AnnotationGeometry, AnnotationRecord, BookStructureEntry, DocumentRecord, DocumentType, LibraryFolder, NormalizedRect } from "../../lib/types";
import { ANNOTATION_COLORS, MAX_PDF_SIZE } from "../../lib/types";
import { getAnnotation, getDocument, listAllAnnotations, listAnnotations, listDocuments, listFolders, putAnnotation, putDocument, putFolder, removeAnnotation, removeDocument, removeFolder, type LocalDocument } from "./storage";
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
const OPEN_BOOKS_KEY = "mathmargin:open-books";
const EXPLORER_LAYOUT_KEY = "mathmargin:explorer-layout";
const AREA_RESIZE_HANDLES = ["nw", "ne", "sw", "se"] as const;
type AreaResizeHandle = typeof AREA_RESIZE_HANDLES[number];

function clamp(value: number, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function isTextGeometry(value: AnnotationGeometry): value is { rects: NormalizedRect[] } { return "rects" in value; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function formatSize(bytes: number) { return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
function documentTypeOf(document: DocumentRecord): DocumentType { return document.documentType ?? "textbook"; }
function documentTypeLabel(type: DocumentType) { return type === "problem-set" ? "Problem set" : "Textbook"; }
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
function moveAreaRect(rect: NormalizedRect, deltaX: number, deltaY: number) {
  return { ...rect, x: clamp(rect.x + deltaX, 0, 1 - rect.width), y: clamp(rect.y + deltaY, 0, 1 - rect.height) };
}
function annotationDescription(annotation: AnnotationRecord) {
  const content = annotation.title?.trim() || annotation.bodyMarkdown.trim() || annotation.selectedText?.trim();
  return content ? content.replace(/\s+/g, " ").slice(0, 90) : `${annotation.type === "area" ? "Area" : "Highlight"} annotation`;
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
  const [openBooks, setOpenBooks] = useState<{ id: string; title: string }[]>([]);
  const [tabsHydrated, setTabsHydrated] = useState(false);
  const [initialActiveId] = useState(activeId);
  useEffect(() => {
    const change = () => setActiveId(location.hash.match(/^#\/reader\/(.+)$/)?.[1] ?? "");
    addEventListener("hashchange", change); return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const storedIds = (() => {
      try { return JSON.parse(sessionStorage.getItem(OPEN_BOOKS_KEY) ?? "[]") as string[]; }
      catch { return []; }
    })();
    listDocuments().then((documents) => {
      const requestedIds = [...new Set([...storedIds, ...(initialActiveId ? [initialActiveId] : [])])];
      const documentsById = new Map(documents.map((document) => [document.id, document]));
      setOpenBooks(requestedIds.flatMap((id) => {
        const document = documentsById.get(id);
        return document ? [{ id, title: document.title }] : [];
      }));
    }).catch(() => undefined).finally(() => setTabsHydrated(true));
  }, [initialActiveId]);
  useEffect(() => {
    if (!activeId || openBooks.some((book) => book.id === activeId)) return;
    getDocument(activeId).then((document) => {
      if (document) setOpenBooks((current) => current.some((book) => book.id === document.id) ? current : [...current, { id: document.id, title: document.title }]);
      else location.hash = "";
    }).catch(() => undefined);
  }, [activeId, openBooks]);
  useEffect(() => { if (tabsHydrated) sessionStorage.setItem(OPEN_BOOKS_KEY, JSON.stringify(openBooks.map((book) => book.id))); }, [openBooks, tabsHydrated]);

  function openBook(document: Pick<LocalDocument, "id" | "title">) {
    setOpenBooks((current) => current.some((book) => book.id === document.id) ? current : [...current, { id: document.id, title: document.title }]);
    location.hash = `/reader/${document.id}`;
  }
  function closeBook(id: string) {
    setOpenBooks((current) => {
      const index = current.findIndex((book) => book.id === id);
      const next = current.filter((book) => book.id !== id);
      if (activeId === id) {
        const replacement = next[Math.min(index, next.length - 1)];
        location.hash = replacement ? `/reader/${replacement.id}` : "";
      }
      return next;
    });
  }
  function updateBookTitle(id: string, title: string) { setOpenBooks((current) => current.map((book) => book.id === id ? { ...book, title } : book)); }
  function removeBook(id: string) { closeBook(id); }

  return <div className="desktop-app-shell">
    <nav className="book-tabs desktop-drag-region" aria-label="Open PDFs">
      <button type="button" className={`library-tab ${!activeId ? "active" : ""}`} onClick={() => { location.hash = ""; }} aria-label="Open library" title="Library"><span className="brand-mark">M</span><span>Library</span></button>
      <div className="book-tab-list">{openBooks.map((book) => <div className={`book-tab ${activeId === book.id ? "active" : ""}`} key={book.id}><button type="button" className="book-tab-title" onClick={() => { location.hash = `/reader/${book.id}`; }} title={book.title}>{book.title}</button><button type="button" className="book-tab-close" onClick={() => closeBook(book.id)} aria-label={`Close ${book.title}`} title="Close tab">×</button></div>)}</div>
    </nav>
    <div className="desktop-view-stack">
      <div className={`desktop-view ${activeId ? "is-hidden" : ""}`}><DesktopLibrary onOpen={openBook} onRename={updateBookTitle} onDelete={removeBook} /></div>
      {openBooks.map((book) => <div className={`desktop-view ${activeId === book.id ? "" : "is-hidden"}`} key={book.id}><DesktopReader documentId={book.id} isActive={activeId === book.id} onBack={() => { location.hash = ""; }} /></div>)}
    </div>
  </div>;
}

function BookCover({ document, onSelect, onOpen }: { document: LocalDocument; onSelect: () => void; onOpen: () => void }) {
  const fileUrl = useMemo(() => URL.createObjectURL(document.file instanceof Blob ? document.file : new Blob([document.file], { type: "application/pdf" })), [document.file]);
  useEffect(() => () => URL.revokeObjectURL(fileUrl), [fileUrl]);
  return <button className="book-cover pdf-book-cover" onClick={onSelect} onDoubleClick={onOpen} aria-label={`Select ${document.title}`} title="Double-click to open">
    <Document file={fileUrl} loading={<span className="cover-loading"><span className="spinner" /> Loading cover…</span>} error={<span className="cover-loading">Cover unavailable</span>}><Page pageNumber={1} height={190} renderAnnotationLayer={false} renderTextLayer={false} /></Document>
    <span className="cover-pages">{document.pageCount} pages</span>
  </button>;
}

function DesktopLibrary({ onOpen, onRename, onDelete }: { onOpen: (document: LocalDocument) => void; onRename: (id: string, title: string) => void; onDelete: (id: string) => void }) {
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [libraryView, setLibraryView] = useState("all");
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
  const [pendingDocumentType, setPendingDocumentType] = useState<DocumentType>("textbook");
  const [pendingFolderId, setPendingFolderId] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState("");
  const [folderBeingRenamed, setFolderBeingRenamed] = useState<LibraryFolder | null>(null);
  const [folderPendingDelete, setFolderPendingDelete] = useState<LibraryFolder | null>(null);
  const [folderMenuId, setFolderMenuId] = useState("");
  const [pendingFolderImport, setPendingFolderImport] = useState<{ name: string; files: File[] } | null>(null);
  const [folderImportType, setFolderImportType] = useState<DocumentType>("textbook");
  const [folderImporting, setFolderImporting] = useState(false);
  const [folderImportProgress, setFolderImportProgress] = useState(0);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [explorerLayout, setExplorerLayout] = useState<"icons" | "details">(() => localStorage.getItem(EXPLORER_LAYOUT_KEY) === "details" ? "details" : "icons");
  const [folderDropTargetId, setFolderDropTargetId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draggedId, setDraggedId] = useState("");
  const [dropTargetId, setDropTargetId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([listDocuments(), listFolders()]).then(([savedDocuments, savedFolders]) => {
      setDocuments(savedDocuments); setFolders(savedFolders);
    }).catch((cause) => setError(message(cause, "Your library could not be opened."))).finally(() => setLoading(false));
  }, []);
  useEffect(() => { localStorage.setItem(EXPLORER_LAYOUT_KEY, explorerLayout); }, [explorerLayout]);
  useEffect(() => { folderInputRef.current?.setAttribute("webkitdirectory", ""); }, []);

  function chooseUpload(file?: File, destinationFolderId?: string) {
    if (!file || uploading) return;
    setError("");
    if (file.size > MAX_PDF_SIZE) return setError("This PDF is larger than the 120 MB limit.");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return setError("Choose a PDF file to continue.");
    setPendingUpload(file); setPendingDocumentType("textbook");
    setPendingFolderId(destinationFolderId !== undefined ? destinationFolderId : libraryView.startsWith("folder:") ? libraryView.slice(7) : "");
  }

  async function upload() {
    const file = pendingUpload;
    if (!file || uploading) return;
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
        fileSize: file.size, pageCount: pdf.numPages, createdAt: now, updatedAt: now, lastOpenedAt: now, libraryOrder: 0,
        documentType: pendingDocumentType, folderId: pendingFolderId || null,
        file: data,
      };
      stage = "closing the PDF validator";
      await pdf.destroy();
      stage = "saving the PDF locally";
      const reordered = [record, ...documents].map((document, index) => ({ ...document, libraryOrder: index }));
      await Promise.all(reordered.map(putDocument));
      setDocuments(reordered);
      if (pendingFolderId) setLibraryView(`folder:${pendingFolderId}`);
      else setLibraryView(pendingDocumentType === "problem-set" ? "problem-sets" : "textbooks");
      setPendingUpload(null);
    } catch (cause) {
      const detail = message(cause, "This PDF could not be read.");
      setError(/password/i.test(detail) ? "Password-protected PDFs are not supported yet." : /invalid|format|missing pdf/i.test(detail) ? "This PDF appears to be corrupted or invalid." : `${detail} (${stage})`);
    } finally { setUploading(false); if (inputRef.current) inputRef.current.value = ""; }
  }

  function cancelUpload() { if (uploading) return; setPendingUpload(null); if (inputRef.current) inputRef.current.value = ""; }

  async function createFolder() {
    const name = folderName.trim(); if (!name) return;
    setFolderError("");
    const now = new Date().toISOString();
    const folder: LibraryFolder = { id: crypto.randomUUID(), name: name.slice(0, 80), createdAt: now, updatedAt: now, libraryOrder: folders.length };
    try { await putFolder(folder); setFolders((current) => [...current, folder]); setFolderName(""); setCreatingFolder(false); setLibraryView(`folder:${folder.id}`); }
    catch (cause) { setFolderError(message(cause, "The folder could not be created.")); }
  }

  function openFolderCreator() { setFolderName(""); setFolderError(""); setCreatingFolder(true); }

  function openFolderRenamer(folder: LibraryFolder) { setFolderMenuId(""); setFolderName(folder.name); setFolderError(""); setFolderBeingRenamed(folder); }

  async function renameFolder() {
    const folder = folderBeingRenamed; const name = folderName.trim(); if (!folder || !name) return;
    if (name === folder.name) { setFolderBeingRenamed(null); return; }
    const updated = { ...folder, name: name.slice(0, 80), updatedAt: new Date().toISOString() };
    try { await putFolder(updated); setFolders((current) => current.map((item) => item.id === folder.id ? updated : item)); setFolderBeingRenamed(null); setFolderName(""); }
    catch (cause) { setFolderError(message(cause, "The folder could not be renamed.")); }
  }

  async function discardFolder(folder: LibraryFolder) {
    try {
      await removeFolder(folder.id);
      setFolders((current) => current.filter((item) => item.id !== folder.id));
      setDocuments((current) => current.map((document) => document.folderId === folder.id ? { ...document, folderId: null, updatedAt: new Date().toISOString() } : document));
      if (libraryView === `folder:${folder.id}`) setLibraryView("unfiled");
      setFolderPendingDelete(null); setFolderMenuId("");
    } catch (cause) { setError(message(cause, "The folder could not be deleted.")); }
  }

  function chooseFolderImport(files?: FileList | null) {
    const selected = [...(files ?? [])];
    const pdfFiles = selected.filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    if (!pdfFiles.length) { setError("That folder does not contain any PDF files."); if (folderInputRef.current) folderInputRef.current.value = ""; return; }
    const sourceName = pdfFiles[0].webkitRelativePath.split("/")[0]?.trim() || "Imported PDFs";
    let name = sourceName; let suffix = 2;
    while (folders.some((folder) => folder.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) name = `${sourceName} (${suffix++})`;
    setPendingFolderImport({ name, files: selected }); setFolderImportType("textbook"); setFolderImportProgress(0); setError("");
  }

  async function importFolder() {
    const pending = pendingFolderImport; if (!pending || folderImporting) return;
    const pdfFiles = pending.files.filter((file) => (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) && file.size <= MAX_PDF_SIZE);
    if (!pdfFiles.length) { setError("Every PDF in that folder is larger than the 120 MB limit."); setPendingFolderImport(null); return; }
    setFolderImporting(true); setFolderImportProgress(0);
    const now = new Date().toISOString();
    const folder: LibraryFolder = { id: crypto.randomUUID(), name: pending.name.slice(0, 80), createdAt: now, updatedAt: now, libraryOrder: folders.length };
    const added: LocalDocument[] = [];
    let failed = pending.files.length - pdfFiles.length;
    try {
      await putFolder(folder);
      for (let index = 0; index < pdfFiles.length; index++) {
        const file = pdfFiles[index]; setFolderImportProgress(index + 1);
        try {
          const data = await file.arrayBuffer();
          const pdf = await pdfjs.getDocument({ data: data.slice(0) }).promise;
          const relativeName = file.webkitRelativePath.split("/").slice(1).join(" / ") || file.name;
          added.push({ id: crypto.randomUUID(), title: relativeName.replace(/\.pdf$/i, ""), originalFilename: file.name, fileSize: file.size, pageCount: pdf.numPages, createdAt: now, updatedAt: now, lastOpenedAt: now, libraryOrder: index, documentType: folderImportType, folderId: folder.id, file: data });
          await pdf.destroy();
        } catch { failed++; }
      }
      if (!added.length) { await removeFolder(folder.id); throw new Error("None of the PDFs in that folder could be read."); }
      const reordered = [...added, ...documents].map((document, index) => ({ ...document, libraryOrder: index }));
      await Promise.all(reordered.map(putDocument));
      setFolders((current) => [...current, folder]); setDocuments(reordered); setLibraryView(`folder:${folder.id}`); setSelectedDocumentId(""); setSearchQuery("");
      setPendingFolderImport(null); if (failed) setError(`${added.length} PDFs imported. ${failed} unsupported, oversized, password-protected, or invalid files were skipped.`);
    } catch (cause) { setError(message(cause, "The folder could not be imported.")); }
    finally { setFolderImporting(false); setFolderImportProgress(0); if (folderInputRef.current) folderInputRef.current.value = ""; }
  }

  async function moveDocument(document: LocalDocument, folderId: string) {
    const updated = { ...document, folderId: folderId || null, updatedAt: new Date().toISOString() };
    try { await putDocument(updated); setDocuments((current) => current.map((item) => item.id === document.id ? updated : item)); }
    catch (cause) { setError(message(cause, "The PDF could not be moved.")); }
  }

  async function dropDocumentIntoFolder(event: DragEvent, folderId: string) {
    event.preventDefault(); event.stopPropagation(); setFolderDropTargetId("");
    if (event.dataTransfer.files.length) { setDragging(false); chooseUpload(event.dataTransfer.files[0], folderId); return; }
    const id = event.dataTransfer.getData("application/x-mathmargin-document-id") || event.dataTransfer.getData("text/plain") || draggedId;
    const document = documents.find((item) => item.id === id);
    if (!document || (document.folderId ?? "") === folderId) return;
    await moveDocument(document, folderId);
  }

  async function rename(document: LocalDocument) {
    const title = draftTitle.trim(); if (!title) return;
    const updated = { ...document, title: title.slice(0, 160), updatedAt: new Date().toISOString() };
    await putDocument(updated); setDocuments((current) => current.map((item) => item.id === document.id ? updated : item)); onRename(document.id, updated.title); setEditingId("");
  }

  async function discard(document: LocalDocument) {
    if (!confirm(`Delete “${document.title}” and all of its annotations?`)) return;
    await removeDocument(document.id); setDocuments((current) => current.filter((item) => item.id !== document.id)); onDelete(document.id);
  }

  async function commitOrder(next: LocalDocument[]) {
    const ordered = next.map((document, index) => ({ ...document, libraryOrder: index, updatedAt: new Date().toISOString() }));
    setDocuments(ordered);
    try { await Promise.all(ordered.map(putDocument)); }
    catch (cause) { setError(message(cause, "The new book order could not be saved.")); }
  }
  function moveBook(id: string, targetId: string) {
    if (!id || id === targetId) return;
    const from = documents.findIndex((document) => document.id === id);
    const to = documents.findIndex((document) => document.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...documents];
    const [moved] = next.splice(from, 1); next.splice(to, 0, moved);
    void commitOrder(next);
  }
  const query = searchQuery.trim().toLowerCase();
  const visibleDocuments = documents.filter((document) => {
    if (libraryView === "textbooks") return documentTypeOf(document) === "textbook";
    if (libraryView === "problem-sets") return documentTypeOf(document) === "problem-set";
    if (libraryView === "unfiled") return !document.folderId;
    if (libraryView.startsWith("folder:")) return document.folderId === libraryView.slice(7);
    return true;
  }).filter((document) => !query || `${document.title} ${document.originalFilename} ${documentTypeLabel(documentTypeOf(document))}`.toLowerCase().includes(query));
  const selectedFolder = libraryView.startsWith("folder:") ? folders.find((folder) => folder.id === libraryView.slice(7)) : undefined;
  const viewTitle = selectedFolder?.name ?? (libraryView === "textbooks" ? "Textbooks" : libraryView === "problem-sets" ? "Problem sets" : libraryView === "unfiled" ? "Unfiled PDFs" : "All PDFs");
  const selectedDocument = documents.find((document) => document.id === selectedDocumentId);
  const visibleFolders = folders.filter((folder) => !query || folder.name.toLowerCase().includes(query));
  const pendingImportPdfs = pendingFolderImport?.files.filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) ?? [];
  const pendingImportEligible = pendingImportPdfs.filter((file) => file.size <= MAX_PDF_SIZE);
  function selectView(view: string) { setLibraryView(view); setSelectedDocumentId(""); setSearchQuery(""); }
  function startDocumentDrag(event: DragEvent, document: LocalDocument) {
    setDraggedId(document.id); setSelectedDocumentId(document.id); event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-mathmargin-document-id", document.id); event.dataTransfer.setData("text/plain", document.id);
  }
  function moveVisibleBookBy(id: string, delta: number) {
    const index = visibleDocuments.findIndex((document) => document.id === id);
    const target = visibleDocuments[index + delta]; if (target) moveBook(id, target.id);
  }

  return <main className="library-shell desktop-library">
    <header className="library-header desktop-drag-region"><div className="brand"><span className="brand-mark">M</span><span>MathMargin</span></div><span className="desktop-local-pill">Stored locally · works offline</span></header>
    <input ref={inputRef} className="explorer-file-input" type="file" accept="application/pdf,.pdf" onChange={(event) => chooseUpload(event.target.files?.[0])} />
    <input ref={folderInputRef} className="explorer-file-input explorer-folder-input" type="file" accept="application/pdf,.pdf" multiple onChange={(event) => chooseFolderImport(event.target.files)} />
    <section className="explorer-command-bar" aria-label="Library commands">
      <button type="button" className="primary-command" onClick={() => inputRef.current?.click()} disabled={uploading}><span>＋</span>{uploading ? "Adding PDF…" : "Add PDF"}</button>
      <button type="button" onClick={openFolderCreator}><span className="command-folder-glyph" />New folder</button><button type="button" className="import-folder-command" onClick={() => folderInputRef.current?.click()} disabled={folderImporting}><span>⇩</span>Import folder</button><span className="command-divider" />
      <button type="button" disabled={!selectedDocument} onClick={() => { if (selectedDocument) { setEditingId(selectedDocument.id); setDraftTitle(selectedDocument.title); } }}>Rename</button>
      <button type="button" disabled={!selectedDocument} onClick={() => { if (selectedDocument) void discard(selectedDocument); }}>Delete</button>
      <button type="button" disabled={!selectedDocument} onClick={() => { if (selectedDocument) onOpen(selectedDocument); }}>Open</button>
      {selectedFolder && <><span className="command-divider" /><button type="button" className="rename-folder-command" onClick={() => openFolderRenamer(selectedFolder)}>Rename folder</button><button type="button" className="delete-folder-command" onClick={() => setFolderPendingDelete(selectedFolder)}>Delete folder</button></>}
      <span className="command-spacer" /><div className="explorer-view-toggle" aria-label="Layout"><button type="button" className={explorerLayout === "icons" ? "active" : ""} onClick={() => setExplorerLayout("icons")} title="Icon view">▦</button><button type="button" className={explorerLayout === "details" ? "active" : ""} onClick={() => setExplorerLayout("details")} title="Details view">☷</button></div>
    </section>
    <section className="explorer-address-row"><button type="button" className="explorer-up-button" onClick={() => selectView("all")} disabled={libraryView === "all"} title="Up to All PDFs">↑</button><div className="explorer-address"><button type="button" onClick={() => selectView("all")}>MathMargin</button><span>›</span><strong>{viewTitle}</strong></div><label className="explorer-search"><span>⌕</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={`Search ${viewTitle}`} aria-label={`Search ${viewTitle}`} /></label></section>
    {error && <div className="library-error explorer-error" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
    <section className={`library-workspace ${dragging ? "is-file-dragging" : ""}`} onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); chooseUpload(event.dataTransfer.files[0]); } }}>
      {dragging && <div className="explorer-file-drop-overlay"><strong>Drop PDF to add it</strong><span>You’ll choose its type and folder next</span></div>}
      <aside className="library-folders" aria-label="PDF library filters"><div className="folder-heading"><span>Library</span></div>
        <nav className="folder-nav">
          <button className={libraryView === "all" ? "active" : ""} onClick={() => selectView("all")}><span>▣ All PDFs</span><small>{documents.length}</small></button>
          <button className={libraryView === "textbooks" ? "active" : ""} onClick={() => selectView("textbooks")}><span>▤ Textbooks</span><small>{documents.filter((document) => documentTypeOf(document) === "textbook").length}</small></button>
          <button className={libraryView === "problem-sets" ? "active" : ""} onClick={() => selectView("problem-sets")}><span>☑ Problem sets</span><small>{documents.filter((document) => documentTypeOf(document) === "problem-set").length}</small></button>
          <button className={`${libraryView === "unfiled" ? "active" : ""} ${folderDropTargetId === "unfiled" ? "drop-target" : ""}`} onClick={() => selectView("unfiled")} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setFolderDropTargetId("unfiled"); }} onDragLeave={() => setFolderDropTargetId("")} onDrop={(event) => void dropDocumentIntoFolder(event, "")}><span>⌂ Unfiled</span><small>{documents.filter((document) => !document.folderId).length}</small></button>
        </nav>
        {!!folders.length && <><div className="folder-list-heading">Folders</div><nav className="explorer-folder-tree">{folders.map((folder) => <button type="button" key={folder.id} className={`${libraryView === `folder:${folder.id}` ? "active" : ""} ${folderDropTargetId === folder.id ? "drop-target" : ""}`} onClick={() => selectView(`folder:${folder.id}`)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setFolderDropTargetId(folder.id); }} onDragLeave={() => setFolderDropTargetId("")} onDrop={(event) => void dropDocumentIntoFolder(event, folder.id)}><span className="tree-folder-glyph" /><strong>{folder.name}</strong><small>{documents.filter((document) => document.folderId === folder.id).length}</small></button>)}</nav></>}
      </aside>
      <section className="books-section"><div className="section-heading explorer-pane-heading"><div><h2>{viewTitle}</h2>{selectedFolder && <p className="folder-management-hint">Use the toolbar above to rename or delete this folder.</p>}</div><span className="book-count">{visibleDocuments.length} {visibleDocuments.length === 1 ? "item" : "items"}</span></div>
      {libraryView === "all" && !loading && <section className="file-manager-folders" aria-labelledby="folders-heading"><div className="file-manager-heading"><h3 id="folders-heading">Folders</h3><span>{visibleFolders.length} shown</span></div><div className="folder-icon-grid"><button type="button" className="library-folder-tile create-folder-tile" onClick={openFolderCreator}><span className="new-folder-icon" aria-hidden="true">+</span><strong>New folder</strong><small>Create a folder</small></button>{visibleFolders.map((folder) => { const count = documents.filter((document) => document.folderId === folder.id).length; return <div className={`library-folder-item ${folderMenuId === folder.id ? "menu-open" : ""}`} key={folder.id}><button type="button" className={`library-folder-tile ${folderDropTargetId === folder.id ? "drop-target" : ""}`} onClick={() => selectView(`folder:${folder.id}`)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setFolderDropTargetId(folder.id); }} onDragLeave={() => setFolderDropTargetId("")} onDrop={(event) => void dropDocumentIntoFolder(event, folder.id)} aria-label={`Open ${folder.name}, ${count} ${count === 1 ? "PDF" : "PDFs"}`}><span className="windows-folder-icon" aria-hidden="true"><i /></span><strong>{folder.name}</strong><small>{count} {count === 1 ? "PDF" : "PDFs"}</small></button><button type="button" className="folder-more-button" onClick={() => setFolderMenuId((current) => current === folder.id ? "" : folder.id)} aria-label={`Options for ${folder.name}`} title="Folder options">•••</button>{folderMenuId === folder.id && <div className="folder-context-menu"><button type="button" onClick={() => openFolderRenamer(folder)}>Rename folder</button><button type="button" className="danger-action" onClick={() => { setFolderMenuId(""); setFolderPendingDelete(folder); }}>Delete folder</button></div>}</div>; })}</div></section>}
      {loading ? <div className="loading-row"><span className="spinner" /> Opening your library…</div> : !documents.length ? <div className="empty-library"><div className="empty-glyph">∫</div><div><h3>This folder is empty</h3><p>Add a PDF or drag one here from your computer.</p></div><button className="text-button" onClick={() => inputRef.current?.click()}>Add PDF</button></div> : !visibleDocuments.length ? <div className="empty-library filtered-empty"><div className="empty-glyph">∅</div><div><h3>{query ? "No matching PDFs" : "This folder is empty"}</h3><p>{query ? "Try another search." : "Drag a PDF onto this folder or add one from your computer."}</p></div>{!query && <button className="text-button" onClick={() => inputRef.current?.click()}>Add PDF</button>}</div> :
        <div className={`book-grid explorer-${explorerLayout}`}>{visibleDocuments.map((document, index) => <article className={`book-card ${selectedDocumentId === document.id ? "is-selected" : ""} ${draggedId === document.id ? "is-dragging" : ""} ${dropTargetId === document.id ? "is-drop-target" : ""}`} key={document.id} draggable={editingId !== document.id} onClick={() => setSelectedDocumentId(document.id)} onDoubleClick={() => onOpen(document)} onDragStart={(event) => startDocumentDrag(event, document)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetId(document.id); }} onDragLeave={() => setDropTargetId((current) => current === document.id ? "" : current)} onDrop={(event) => { event.preventDefault(); moveBook(event.dataTransfer.getData("application/x-mathmargin-document-id") || event.dataTransfer.getData("text/plain") || draggedId, document.id); setDraggedId(""); setDropTargetId(""); }} onDragEnd={() => { setDraggedId(""); setDropTargetId(""); setFolderDropTargetId(""); }}>
          <BookCover document={document} onSelect={() => setSelectedDocumentId(document.id)} onOpen={() => onOpen(document)} />
          <div className="book-info"><div className={`document-type-badge ${documentTypeOf(document)}`}>{documentTypeLabel(documentTypeOf(document))}</div>{editingId === document.id ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void rename(document); }} onClick={(event) => event.stopPropagation()}><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} autoFocus /><button>Save</button><button type="button" onClick={() => setEditingId("")}>Cancel</button></form> : <button className="desktop-book-title" onClick={() => setSelectedDocumentId(document.id)} onDoubleClick={() => onOpen(document)}><h3>{document.title}</h3></button>}<p>{formatSize(document.fileSize)} · {document.pageCount} pages</p><span className="explorer-location">{folders.find((folder) => folder.id === document.folderId)?.name ?? "Unfiled"}</span><div className="book-position-actions" aria-label={`Move ${document.title}`}><span>Drag to move</span><button type="button" onClick={() => moveVisibleBookBy(document.id, -1)} disabled={index === 0} aria-label={`Move ${document.title} earlier`}>←</button><button type="button" onClick={() => moveVisibleBookBy(document.id, 1)} disabled={index === visibleDocuments.length - 1} aria-label={`Move ${document.title} later`}>→</button></div><div className="book-actions"><button className="open-button" onClick={() => onOpen(document)}>Open <span>→</span></button><button onClick={() => { setEditingId(document.id); setDraftTitle(document.title); }}>Rename</button><button className="danger-action" onClick={() => void discard(document)}>Delete</button></div></div>
        </article>)}</div>}
        <footer className="explorer-status-bar"><span>{visibleDocuments.length} {visibleDocuments.length === 1 ? "item" : "items"}</span>{selectedDocument && <span>1 item selected · {formatSize(selectedDocument.fileSize)}</span>}<span>Drag PDFs onto a folder to move them</span></footer>
      </section>
    </section>
    {creatingFolder && <div className="library-modal-backdrop"><section className="library-modal folder-create-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title"><button type="button" className="modal-close-button" onClick={() => setCreatingFolder(false)} aria-label="Cancel folder creation">×</button><span className="windows-folder-icon modal-folder-icon" aria-hidden="true"><i /></span><p className="eyebrow">Organize your library</p><h2 id="folder-dialog-title">Create a new folder</h2><p className="folder-dialog-copy">Give this folder a name. You can move textbooks and problem sets into it at any time.</p><form className="folder-create-form" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}><label htmlFor="new-folder-name">Folder name</label><input id="new-folder-name" className="folder-name-input" value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="For example: Algebra II" autoFocus maxLength={80} />{folderError && <div className="folder-dialog-error" role="alert">{folderError}</div>}<div className="modal-actions"><button type="button" onClick={() => setCreatingFolder(false)}>Cancel</button><button type="submit" className="confirm-folder-button" disabled={!folderName.trim()}>Create folder</button></div></form></section></div>}
    {folderBeingRenamed && <div className="library-modal-backdrop"><section className="library-modal folder-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-folder-dialog-title"><button type="button" className="modal-close-button" onClick={() => setFolderBeingRenamed(null)} aria-label="Cancel folder rename">×</button><span className="windows-folder-icon modal-folder-icon" aria-hidden="true"><i /></span><p className="eyebrow">Folder options</p><h2 id="rename-folder-dialog-title">Rename folder</h2><form className="folder-create-form" onSubmit={(event) => { event.preventDefault(); void renameFolder(); }}><label htmlFor="rename-folder-name">Folder name</label><input id="rename-folder-name" className="folder-rename-input" value={folderName} onChange={(event) => setFolderName(event.target.value)} autoFocus maxLength={80} />{folderError && <div className="folder-dialog-error" role="alert">{folderError}</div>}<div className="modal-actions"><button type="button" onClick={() => setFolderBeingRenamed(null)}>Cancel</button><button type="submit" className="confirm-folder-button" disabled={!folderName.trim()}>Save name</button></div></form></section></div>}
    {folderPendingDelete && <div className="library-modal-backdrop"><section className="library-modal folder-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-folder-dialog-title"><button type="button" className="modal-close-button" onClick={() => setFolderPendingDelete(null)} aria-label="Cancel folder deletion">×</button><div className="delete-folder-glyph" aria-hidden="true">!</div><p className="eyebrow">Folder options</p><h2 id="delete-folder-dialog-title">Delete “{folderPendingDelete.name}”?</h2><p className="folder-dialog-copy">The folder will be removed. Its {documents.filter((document) => document.folderId === folderPendingDelete.id).length} PDFs and all their annotations will be kept and moved to Unfiled.</p><div className="modal-actions"><button type="button" onClick={() => setFolderPendingDelete(null)}>Cancel</button><button type="button" className="confirm-delete-folder-button" onClick={() => void discardFolder(folderPendingDelete)}>Delete folder</button></div></section></div>}
    {pendingFolderImport && <div className="library-modal-backdrop"><section className="library-modal folder-import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-folder-dialog-title"><button type="button" className="modal-close-button" onClick={() => { if (!folderImporting) setPendingFolderImport(null); }} disabled={folderImporting} aria-label="Cancel folder import">×</button><span className="windows-folder-icon modal-folder-icon" aria-hidden="true"><i /></span><p className="eyebrow">Import from Windows</p><h2 id="import-folder-dialog-title">Import “{pendingFolderImport.name}”</h2><p className="folder-dialog-copy">MathMargin found {pendingImportPdfs.length} {pendingImportPdfs.length === 1 ? "PDF" : "PDFs"}, including PDFs in subfolders. They will be placed together in a new MathMargin folder.</p><div className="folder-import-summary"><span><strong>{pendingImportEligible.length}</strong> ready to import</span>{pendingImportPdfs.length !== pendingImportEligible.length && <span className="warning"><strong>{pendingImportPdfs.length - pendingImportEligible.length}</strong> over 120 MB</span>}</div><div className="folder-import-type"><span>Import these PDFs as</span><div className="document-type-grid" role="radiogroup" aria-label="Imported PDF type"><button type="button" role="radio" aria-checked={folderImportType === "textbook"} className={`document-type-option ${folderImportType === "textbook" ? "selected" : ""}`} onClick={() => setFolderImportType("textbook")} disabled={folderImporting}><span className="document-type-icon">T</span><strong>Textbooks</strong><small>Books and reading material</small></button><button type="button" role="radio" aria-checked={folderImportType === "problem-set"} className={`document-type-option ${folderImportType === "problem-set" ? "selected" : ""}`} onClick={() => setFolderImportType("problem-set")} disabled={folderImporting}><span className="document-type-icon">P</span><strong>Problem sets</strong><small>Assignments and exercises</small></button></div></div>{folderImporting && <div className="folder-import-progress"><span style={{ width: `${Math.round(folderImportProgress / Math.max(1, pendingImportEligible.length) * 100)}%` }} /><small>Importing PDF {Math.min(folderImportProgress, pendingImportEligible.length)} of {pendingImportEligible.length}…</small></div>}<div className="modal-actions"><button type="button" onClick={() => setPendingFolderImport(null)} disabled={folderImporting}>Cancel</button><button type="button" className="confirm-folder-import-button" onClick={() => void importFolder()} disabled={folderImporting || !pendingImportEligible.length}>{folderImporting ? "Importing…" : `Import ${pendingImportEligible.length} PDFs`}</button></div></section></div>}
    {pendingUpload && <div className="library-modal-backdrop"><section className="library-modal upload-type-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-dialog-title"><button type="button" className="modal-close-button" onClick={cancelUpload} disabled={uploading} aria-label="Cancel upload">×</button><p className="eyebrow">Add to your library</p><h2 id="upload-dialog-title">What kind of PDF is this?</h2><p className="upload-file-name" title={pendingUpload.name}>{pendingUpload.name}</p><div className="document-type-grid" role="radiogroup" aria-label="PDF type"><button type="button" role="radio" aria-checked={pendingDocumentType === "textbook"} className={`document-type-option ${pendingDocumentType === "textbook" ? "selected" : ""}`} onClick={() => setPendingDocumentType("textbook")}><span className="document-type-icon">T</span><strong>Textbook</strong><small>Chapters, sections, and reading notes</small></button><button type="button" role="radio" aria-checked={pendingDocumentType === "problem-set"} className={`document-type-option ${pendingDocumentType === "problem-set" ? "selected" : ""}`} onClick={() => setPendingDocumentType("problem-set")}><span className="document-type-icon">P</span><strong>Problem set</strong><small>Exercises, assignments, and solutions</small></button></div><label className="upload-folder-field"><span>Put it in a folder</span><select value={pendingFolderId} onChange={(event) => setPendingFolderId(event.target.value)}><option value="">Unfiled</option>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label><div className="modal-actions"><button type="button" onClick={cancelUpload} disabled={uploading}>Cancel</button><button type="button" className="confirm-upload-button" onClick={() => void upload()} disabled={uploading}>{uploading ? "Adding PDF…" : "Add to library"}</button></div></section></div>}
  </main>;
}

function DesktopReader({ documentId, isActive, onBack }: { documentId: string; isActive: boolean; onBack: () => void }) {
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
  const [areaOptionsOpenId, setAreaOptionsOpenId] = useState("");
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkLibrary, setLinkLibrary] = useState<{ documents: DocumentRecord[]; annotations: AnnotationRecord[] }>({ documents: [], annotations: [] });
  const [linkLibraryState, setLinkLibraryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
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
  const areaMoveStart = useRef<{ pointerId: number; annotationId: string; clientX: number; clientY: number; geometry: NormalizedRect } | null>(null);
  const [activeAreaResize, setActiveAreaResize] = useState<AreaResizeHandle | null>(null);
  const [activeAreaMove, setActiveAreaMove] = useState(false);

  useEffect(() => {
    Promise.all([getDocument(documentId), listAnnotations(documentId)]).then(async ([record, saved]) => {
      if (!record) throw new Error("This PDF was not found in the local library.");
      const opened = { ...record, lastOpenedAt: new Date().toISOString() }; await putDocument(opened);
      setDocument(opened); setAnnotations(saved); setBookStructure(opened.bookStructure ?? []);
      const pendingAnnotationId = sessionStorage.getItem("mathmargin:open-annotation");
      const pendingAnnotation = saved.find((annotation) => annotation.id === pendingAnnotationId);
      if (pendingAnnotation) {
        setSelectedId(pendingAnnotation.id); setPageNumber(pendingAnnotation.pageNumber); setSidebarOpen(true);
        sessionStorage.removeItem("mathmargin:open-annotation");
      }
      if (opened.bookStructureScannedAt && opened.bookStructureVersion === BOOK_STRUCTURE_VERSION) setStructureState(opened.bookStructure?.length ? "ready" : "empty");
    }).catch((cause) => setError(message(cause, "This PDF could not be opened."))).finally(() => setLoading(false));
  }, [documentId]);
  useEffect(() => {
    if (!isActive) return;
    const pendingAnnotationId = sessionStorage.getItem("mathmargin:open-annotation");
    const pendingAnnotation = annotations.find((annotation) => annotation.id === pendingAnnotationId);
    if (!pendingAnnotation) return;
    sessionStorage.removeItem("mathmargin:open-annotation");
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setSelectedId(pendingAnnotation.id); setPageNumber(pendingAnnotation.pageNumber); setSidebarOpen(true);
    });
    return () => { cancelled = true; };
  }, [annotations, isActive]);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) setLinkLibraryState("loading"); });
    Promise.all([listDocuments(), listAllAnnotations()]).then(([documents, saved]) => {
      const summaries: DocumentRecord[] = documents.map((item) => ({
        id: item.id, title: item.title, originalFilename: item.originalFilename, fileSize: item.fileSize, pageCount: item.pageCount,
        createdAt: item.createdAt, updatedAt: item.updatedAt, lastOpenedAt: item.lastOpenedAt, documentType: item.documentType, folderId: item.folderId, bookStructure: item.bookStructure,
        bookStructureScannedAt: item.bookStructureScannedAt, bookStructureVersion: item.bookStructureVersion,
      }));
      if (!cancelled) { setLinkLibrary({ documents: summaries, annotations: saved }); setLinkLibraryState("ready"); }
    }).catch(() => { if (!cancelled) setLinkLibraryState("error"); });
    return () => { cancelled = true; };
  }, [selectedId]);
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
  async function discard(id: string) {
    const timer = saveTimers.current.get(id); if (timer) clearTimeout(timer); saveTimers.current.delete(id);
    await removeAnnotation(id); setAnnotations((current) => current.filter((item) => item.id !== id)); setSelectedId("");
  }

  async function linkAnnotations(target: AnnotationRecord) {
    if (!selected || selected.id === target.id) return;
    const currentTarget = annotations.find((annotation) => annotation.id === target.id) ?? target;
    const now = new Date().toISOString();
    const sourceNext = { ...selected, linkedAnnotationIds: [...new Set([...(selected.linkedAnnotationIds ?? []), currentTarget.id])], updatedAt: now };
    const targetNext = { ...currentTarget, linkedAnnotationIds: [...new Set([...(currentTarget.linkedAnnotationIds ?? []), selected.id])], updatedAt: now };
    const sourceTimer = saveTimers.current.get(selected.id); if (sourceTimer) clearTimeout(sourceTimer);
    const targetTimer = saveTimers.current.get(currentTarget.id); if (targetTimer) clearTimeout(targetTimer);
    saveTimers.current.delete(selected.id); saveTimers.current.delete(currentTarget.id);
    setAnnotations((current) => current.map((annotation) => annotation.id === sourceNext.id ? sourceNext : annotation.id === targetNext.id ? targetNext : annotation));
    setLinkLibrary((current) => ({ ...current, annotations: current.annotations.map((annotation) => annotation.id === sourceNext.id ? sourceNext : annotation.id === targetNext.id ? targetNext : annotation) }));
    setSaveState("saving");
    try { await Promise.all([putAnnotation(sourceNext), putAnnotation(targetNext)]); setSaveState("saved"); }
    catch (cause) { setSaveState("error"); setError(message(cause, "The annotation link could not be saved.")); }
  }

  async function unlinkAnnotations(targetId: string) {
    if (!selected) return;
    const target = annotations.find((annotation) => annotation.id === targetId) ?? linkLibrary.annotations.find((annotation) => annotation.id === targetId) ?? await getAnnotation(targetId);
    const now = new Date().toISOString();
    const sourceNext = { ...selected, linkedAnnotationIds: (selected.linkedAnnotationIds ?? []).filter((id) => id !== targetId), updatedAt: now };
    const targetNext = target ? { ...target, linkedAnnotationIds: (target.linkedAnnotationIds ?? []).filter((id) => id !== selected.id), updatedAt: now } : null;
    const sourceTimer = saveTimers.current.get(selected.id); if (sourceTimer) clearTimeout(sourceTimer); saveTimers.current.delete(selected.id);
    const targetTimer = saveTimers.current.get(targetId); if (targetTimer) clearTimeout(targetTimer); saveTimers.current.delete(targetId);
    setAnnotations((current) => current.map((annotation) => annotation.id === sourceNext.id ? sourceNext : targetNext && annotation.id === targetNext.id ? targetNext : annotation));
    setLinkLibrary((current) => ({ ...current, annotations: current.annotations.map((annotation) => annotation.id === sourceNext.id ? sourceNext : targetNext && annotation.id === targetNext.id ? targetNext : annotation) }));
    setSaveState("saving");
    try { await Promise.all([putAnnotation(sourceNext), ...(targetNext ? [putAnnotation(targetNext)] : [])]); setSaveState("saved"); }
    catch (cause) { setSaveState("error"); setError(message(cause, "The annotation link could not be removed.")); }
  }

  function openLinkedAnnotation(annotation: AnnotationRecord) {
    setLinkPickerOpen(false); setAreaOptionsOpenId("");
    if (annotation.documentId === documentId) {
      setSelectedId(annotation.id); setPageNumber(annotation.pageNumber); setSidebarOpen(true);
      return;
    }
    sessionStorage.setItem("mathmargin:open-annotation", annotation.id);
    window.location.assign(`#/reader/${annotation.documentId}`);
  }

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

  function beginSavedAreaMove(event: React.PointerEvent<HTMLButtonElement>, annotation: AnnotationRecord) {
    if (isTextGeometry(annotation.geometry)) return;
    event.preventDefault(); event.stopPropagation();
    areaMoveStart.current = { pointerId: event.pointerId, annotationId: annotation.id, clientX: event.clientX, clientY: event.clientY, geometry: annotation.geometry };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic test pointers do not have an active native pointer. */ }
    setActiveAreaMove(true); setAreaOptionsOpenId("");
  }
  function moveSavedArea(event: React.PointerEvent<HTMLButtonElement>) {
    const start = areaMoveStart.current;
    const bounds = pageRef.current?.getBoundingClientRect();
    if (!start || start.pointerId !== event.pointerId || !bounds) return;
    event.preventDefault(); event.stopPropagation();
    update(start.annotationId, { geometry: moveAreaRect(start.geometry, (event.clientX - start.clientX) / bounds.width, (event.clientY - start.clientY) / bounds.height) });
  }
  function endSavedAreaMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (areaMoveStart.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); areaMoveStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setActiveAreaMove(false);
  }
  function moveSavedAreaWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, annotation: AnnotationRecord) {
    if (isTextGeometry(annotation.geometry)) return;
    const step = event.shiftKey ? .02 : .005;
    const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const deltaY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (!deltaX && !deltaY) return;
    event.preventDefault(); event.stopPropagation();
    update(annotation.id, { geometry: moveAreaRect(annotation.geometry, deltaX, deltaY) });
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
  const documentTitles = new Map(linkLibrary.documents.map((item) => [item.id, item.title]));
  const linkedAnnotations = (selected?.linkedAnnotationIds ?? []).map((id) => annotations.find((annotation) => annotation.id === id) ?? linkLibrary.annotations.find((annotation) => annotation.id === id)).filter((annotation): annotation is AnnotationRecord => Boolean(annotation));
  const linkCandidates = linkLibrary.annotations.filter((annotation) => annotation.id !== selectedId && `${documentTitles.get(annotation.documentId) ?? "Unknown book"} ${annotationDescription(annotation)} page ${annotation.pageNumber}`.toLowerCase().includes(linkSearch.trim().toLowerCase()));
  const pageAnnotations = annotations.filter((item) => item.pageNumber === pageNumber);
  const latexError = selected ? mathError(selected.bodyMarkdown) : "";
  const annotationGroups = useMemo(() => groupAnnotationsByStructure(annotations, bookStructure), [annotations, bookStructure]);
  const sidebarMaximum = Math.floor(viewportWidth / 2);
  const notesFontScale = clamp(1 + (sidebarWidth - 360) / 1800, 1, 1.2);
  const readerStyle = { "--notes-width": `${sidebarWidth}px`, "--notes-font-scale": notesFontScale } as CSSProperties;
  const readerBodyStyle = sidebarOpen ? { gridTemplateColumns: `minmax(0, 1fr) ${Math.min(sidebarWidth, sidebarMaximum)}px` } : undefined;
  if (loading) return <main className="reader-status"><span className="spinner" /><h1>Opening your PDF…</h1></main>;
  if (!document) return <main className="reader-status"><div className="error-orbit">!</div><h1>We couldn’t open this PDF</h1><p>{error}</p><button className="primary-button" onClick={onBack}>Return to library</button></main>;

  return <main className={`reader-shell ${sidebarOpen ? "sidebar-is-open" : ""} ${resizingSidebar ? "is-resizing-sidebar" : ""}`} style={readerStyle}>
    <header className="reader-header desktop-drag-region"><button className="brand compact desktop-back-brand" onClick={onBack}><span className="brand-mark">M</span><span>MathMargin</span></button><div className="reader-title"><strong>{document.title}</strong><span>{document.pageCount} pages · stored locally</span></div><div className="save-indicator" data-state={saveState}><span />{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</div></header>
    <div className="reader-toolbar"><div className="tool-group"><button className={tool === "highlight" ? "active" : ""} onClick={() => { setTool("highlight"); setDraftArea(null); }}><span className="tool-icon">T</span> Highlight</button><button className={tool === "area" ? "active" : ""} onClick={() => setTool("area")}><span className="tool-icon rectangle-icon" /> Area</button></div><div className="page-controls"><button onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber === 1}>←</button><input value={pageNumber} onChange={(event) => setPageNumber(clamp(Number(event.target.value) || 1, 1, document.pageCount))} /><span>of {document.pageCount}</span><button onClick={() => setPageNumber((page) => Math.min(document.pageCount, page + 1))} disabled={pageNumber === document.pageCount}>→</button></div><div className="zoom-controls" title="Pinch on a touchpad or hold Ctrl while using the mouse wheel"><button onClick={() => setZoom((value) => Math.max(.5, value - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(3, value + .1))}>+</button></div><button className="notes-toggle" onClick={() => setSidebarOpen((value) => !value)}><span>✦</span> Notes <b>{annotations.length}</b></button></div>
    <div className="reader-body" style={readerBodyStyle}><section className="pdf-stage" ref={pdfStageRef}><div className="tool-tip">{tool === "highlight" ? "Select text to add a note" : "Drag over a formula, figure, or passage"} · Pinch or Ctrl+wheel to zoom</div><Document file={pdfUrl} loading={<div className="pdf-loading"><span className="spinner" /> Rendering page…</div>} onLoadSuccess={(pdf) => readBookStructure(pdf as unknown as Parameters<typeof extractBookStructure>[0])} onLoadError={(cause) => setError(message(cause, "The PDF could not be rendered."))}><div className="pdf-page-wrap" ref={pageRef} onMouseUp={selectText}><Page pageNumber={pageNumber} width={Math.round(760 * zoom)} renderAnnotationLayer={false} renderTextLayer />
      <div className="annotation-layer">
        {pageAnnotations.flatMap((annotation) => (isTextGeometry(annotation.geometry) ? annotation.geometry.rects : [annotation.geometry]).map((rect, index) => <button key={`${annotation.id}-${index}`} type="button" aria-label={`Open ${annotation.type === "area" ? "area" : "highlight"} annotation on page ${annotation.pageNumber}`} title="Open annotation" className={`annotation-mark ${annotation.type} color-${annotation.color} ${selectedId === annotation.id ? "selected" : ""}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} onClick={(event) => { event.stopPropagation(); setSelectedId(annotation.id); setSidebarOpen(true); }} />))}
        {selected?.type === "area" && selected.pageNumber === pageNumber && !isTextGeometry(selected.geometry) && <div className="saved-area-controls" style={{ left: `${selected.geometry.x * 100}%`, top: `${selected.geometry.y * 100}%`, width: `${selected.geometry.width * 100}%`, height: `${selected.geometry.height * 100}%` }}>
          <button type="button" className={`saved-area-move-surface ${activeAreaMove ? "active" : ""}`} aria-label="Move selected area" title="Drag to move this box. Use arrow keys for precise movement." onClick={(event) => { event.stopPropagation(); setSidebarOpen(true); }} onPointerDown={(event) => beginSavedAreaMove(event, selected)} onPointerMove={moveSavedArea} onPointerUp={endSavedAreaMove} onPointerCancel={endSavedAreaMove} onKeyDown={(event) => moveSavedAreaWithKeyboard(event, selected)}><span>Move</span></button>
          <div className="area-options-anchor">
            <button type="button" className="area-options-trigger" aria-expanded={areaOptionsOpenId === selected.id} onClick={(event) => { event.stopPropagation(); setAreaOptionsOpenId((openId) => openId === selected.id ? "" : selected.id); }}>••• Options</button>
            {areaOptionsOpenId === selected.id && <div className="area-options-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAreaOptionsOpenId(""); setSidebarOpen(true); setLinkPickerOpen(true); }}>↗ Link annotation…</button>
              <div className="area-options-colors"><span>Box color</span>{ANNOTATION_COLORS.map((color) => <button key={color} type="button" aria-label={`Use ${color} box color`} className={`color-dot ${color} ${selected.color === color ? "active" : ""}`} onClick={() => update(selected.id, { color })} />)}</div>
              <div className="area-options-help">Drag inside the box to move it. Drag a corner to resize.</div>
              <button type="button" role="menuitem" className="area-options-delete" onClick={() => { if (confirm("Delete this box and its note?")) { setAreaOptionsOpenId(""); discard(selected.id); } }}>Delete box</button>
            </div>}
          </div>
          {AREA_RESIZE_HANDLES.map((handle) => <button key={handle} type="button" className={`area-resize-handle ${handle} ${activeAreaResize === handle ? "active" : ""}`} aria-label={`Resize area from ${handle === "nw" ? "top left" : handle === "ne" ? "top right" : handle === "sw" ? "bottom left" : "bottom right"}`} title="Drag to resize area" onPointerDown={(event) => beginSavedAreaResize(event, selected, handle)} onPointerMove={moveSavedAreaResize} onPointerUp={endSavedAreaResize} onPointerCancel={endSavedAreaResize} onKeyDown={(event) => resizeSavedAreaWithKeyboard(event, selected, handle)} />)}
        </div>}
      </div>
      {tool === "area" && <div className="area-interaction" onPointerDown={beginArea} onPointerMove={moveArea} onPointerUp={endArea}>{draftArea && <div className="draft-area" style={{ left: `${draftArea.x * 100}%`, top: `${draftArea.y * 100}%`, width: `${draftArea.width * 100}%`, height: `${draftArea.height * 100}%` }}>{draftArea.width >= .015 && draftArea.height >= .015 && <div className="draft-actions"><button onClick={() => { create("area", draftArea); setDraftArea(null); }}>Annotate area</button><button onClick={() => setDraftArea(null)}>Cancel</button></div>}</div>}</div>}
    </div></Document>{error && <div className="reader-toast"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}</section>
      <aside className="notes-panel">{sidebarOpen && <div className="notes-resizer" role="separator" aria-label="Resize annotation panel" aria-orientation="vertical" aria-valuemin={Math.min(320, sidebarMaximum)} aria-valuemax={sidebarMaximum} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0} title="Drag to resize annotations" onPointerDown={beginSidebarResize} onPointerMove={moveSidebarResize} onPointerUp={endSidebarResize} onPointerCancel={endSidebarResize} onKeyDown={resizeSidebarWithKeyboard} />}<div className="notes-header"><div><p className="eyebrow">Local notebook</p><h2>Annotations</h2></div><button onClick={() => setSidebarOpen(false)}>×</button></div>{selected ? <div className="note-editor"><button className="back-to-notes" onClick={() => setSelectedId("")}>← All annotations</button><div className="note-meta"><span>{selected.type === "text" ? "Highlighted text" : "Selected area"}</span><button onClick={() => setPageNumber(selected.pageNumber)}>Page {selected.pageNumber}</button></div>{selected.selectedText && <blockquote>“{selected.selectedText}”</blockquote>}<div className="color-row"><span>Marker</span>{ANNOTATION_COLORS.map((color) => <button key={color} className={`color-dot ${color} ${selected.color === color ? "active" : ""}`} onClick={() => update(selected.id, { color: color as AnnotationColor })} />)}</div>
        <label className="annotation-name-label" htmlFor={`annotation-name-${selected.id}`}>Annotation name</label><input id={`annotation-name-${selected.id}`} className="annotation-name-input" value={selected.title ?? ""} onChange={(event) => update(selected.id, { title: event.target.value.slice(0, 120) })} placeholder={`Page ${selected.pageNumber} ${selected.type === "text" ? "highlight" : "area"}`} />
        <section className="annotation-links" aria-label="Linked annotations"><div className="annotation-links-heading"><div><strong>Linked annotations</strong><span>{linkedAnnotations.length || "None yet"}</span></div><button type="button" onClick={() => setLinkPickerOpen((open) => !open)}>{linkPickerOpen ? "Close" : "+ Link"}</button></div>
          {linkedAnnotations.length > 0 && <div className="annotation-linked-list">{linkedAnnotations.map((annotation) => <div className="annotation-linked-item" key={annotation.id}><button type="button" onClick={() => openLinkedAnnotation(annotation)}><span>{documentTitles.get(annotation.documentId) ?? (annotation.documentId === documentId ? document.title : "Another textbook")}</span><strong>{annotationDescription(annotation)}</strong><small>Page {annotation.pageNumber} · {annotation.type}</small></button><button type="button" className="unlink-annotation" aria-label={`Unlink ${annotationDescription(annotation)}`} title="Unlink annotation" onClick={() => unlinkAnnotations(annotation.id)}>×</button></div>)}</div>}
          {linkPickerOpen && <div className="annotation-link-picker"><label htmlFor="annotation-link-search">Link another note</label><input id="annotation-link-search" value={linkSearch} onChange={(event) => setLinkSearch(event.target.value)} placeholder="Search every textbook…" />{linkLibraryState === "loading" ? <div className="link-picker-status"><span className="spinner" /> Loading annotations…</div> : linkLibraryState === "error" ? <div className="link-picker-status error">Annotations could not be loaded.</div> : <div className="link-candidate-list">{linkCandidates.map((annotation) => { const linked = selected.linkedAnnotationIds?.includes(annotation.id); return <button type="button" key={annotation.id} data-document-id={annotation.documentId} data-annotation-type={annotation.type} className={linked ? "linked" : ""} onClick={() => linked ? unlinkAnnotations(annotation.id) : linkAnnotations(annotation)}><span>{documentTitles.get(annotation.documentId) ?? "Unknown textbook"}</span><strong>{annotationDescription(annotation)}</strong><small>Page {annotation.pageNumber} · {annotation.type}<b>{linked ? "Unlink" : "Link"}</b></small></button>; })}{!linkCandidates.length && linkLibraryState === "ready" && <div className="link-picker-status">No matching annotations.</div>}</div>}</div>}
        </section>
        <label className="editor-label">Your note <span>Obsidian-style live editing</span></label><div className="note-input-tools"><div className="latex-suite-status" title="Your active Obsidian LaTeX Suite snippet set is enabled. Automatic snippets expand as you type; press Tab for manual snippets and placeholder navigation."><span>⌨</span> LaTeX Suite · {LATEX_SUITE_SHORTCUT_COUNT} shortcuts · Tab to expand</div><button type="button" className="insert-callout-button" onClick={insertCallout} title="Insert an Obsidian-style note callout">＋ Callout</button></div><LiveNoteEditor key={selected.id} value={selected.bodyMarkdown} onChange={editNote} viewRef={liveEditorViewRef} macros={KATEX_MACROS} />{latexError && <div className="latex-error"><strong>LaTeX needs attention</strong>{latexError}</div>}<div className="editor-footer"><span>{selected.bodyMarkdown.length.toLocaleString()} characters</span><button className="delete-note" onClick={() => discard(selected.id)}>Delete annotation</button></div></div> : <div className="notes-list">{structureState === "scanning" && <div className="structure-status"><span className="spinner" /> Reading chapters and sections{structureProgress ? ` · ${structureProgress}%` : "…"}</div>}{structureState === "error" && <div className="structure-status warning">Chapter detection could not finish. Notes are still grouped by page.</div>}{structureState === "empty" && <div className="structure-status">No chapter headings were found in this PDF.</div>}{annotationGroups.length ? annotationGroups.map((chapter) => <section className="annotation-chapter" key={chapter.key}><button type="button" className="annotation-chapter-heading" data-page-number={chapter.pageNumber} onClick={() => setPageNumber(chapter.pageNumber)} title={`Go to page ${chapter.pageNumber}`}><strong>{chapter.number ? `Chapter ${chapter.number} · ` : ""}{structureTitle(chapter.title, chapter.number, 0)}</strong><span>{chapter.sections.reduce((total, section) => total + section.annotations.length, 0)}</span></button>{chapter.sections.map((section) => <div className="annotation-section" key={section.key}><button type="button" className="annotation-section-heading" data-page-number={section.pageNumber} onClick={() => setPageNumber(section.pageNumber)} title={`Go to page ${section.pageNumber}`}><span>{section.number ? `Section ${section.number} · ` : ""}{structureTitle(section.title, section.number, 1)}</span><small>{section.annotations.length} {section.annotations.length === 1 ? "note" : "notes"}</small></button>{section.annotations.map((annotation) => <button className="note-card" key={annotation.id} onClick={() => { setSelectedId(annotation.id); setPageNumber(annotation.pageNumber); }}><span className={`note-stripe ${annotation.color}`} /><span className="note-card-copy"><span className="note-card-meta">Page {annotation.pageNumber} · {annotation.type}</span><strong>{annotation.title?.trim() || annotation.bodyMarkdown || annotation.selectedText || "Untitled annotation"}</strong></span><span>→</span></button>)}{!section.annotations.length && <div className="empty-section-notes">No notes in this section</div>}</div>)}{!chapter.sections.length && <div className="empty-section-notes chapter-empty">No sections or notes yet</div>}</section>) : <div className="notes-empty"><div>∴</div><h3>No annotations yet</h3><p>Select text or draw an area on the page. Your note will open here.</p></div>}</div>}</aside>
    </div>
  </main>;
}

import type { BookStructureEntry } from "../../lib/types";

// Incrementing this version makes existing textbook records rescan so bookmarks
// take precedence even when an older text-derived structure was already cached.
export const BOOK_STRUCTURE_VERSION = 4;

type PdfOutlineItem = { title?: string; dest?: string | unknown[] | null; items?: PdfOutlineItem[] };
type PdfTextItem = { str: string; transform: number[]; height?: number; fontName?: string };
export type StructurePdf = {
  numPages: number;
  getOutline: () => Promise<PdfOutlineItem[] | null>;
  getDestination: (name: string) => Promise<unknown[] | null>;
  getPageIndex: (reference: unknown) => Promise<number>;
  getPage: (pageNumber: number) => Promise<{
    getViewport: (options: { scale: number }) => { height: number };
    getTextContent: () => Promise<{ items: Array<PdfTextItem | unknown> }>;
    cleanup?: () => void;
  }>;
};

function cleanTitle(value?: string) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function entryId(source: BookStructureEntry["source"], pageNumber: number, level: number, title: string) {
  return `${source}-${pageNumber}-${level}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
}

function explicitNumber(entry: BookStructureEntry) {
  if (entry.level === 1) return entry.title.match(/^(\d+(?:\.\d+)+)\b/)?.[1];
  return entry.title.match(/^(?:chapter|part|appendix)\s+([A-Z0-9IVXLC]+)\b/i)?.[1]
    ?? entry.title.match(/^(\d+|[IVXLC]+)\b/)?.[1];
}

function numberStructure(entries: BookStructureEntry[]) {
  let chapterIndex = 0;
  let sectionIndex = 0;
  let chapterNumber = "";
  return entries.map((entry) => {
    if (entry.level === 0) {
      chapterIndex += 1; sectionIndex = 0;
      chapterNumber = explicitNumber(entry) ?? String(chapterIndex);
      return { ...entry, number: chapterNumber };
    }
    sectionIndex += 1;
    return { ...entry, number: explicitNumber(entry) ?? `${chapterNumber || chapterIndex || 1}.${sectionIndex}` };
  });
}

async function destinationPage(pdf: StructurePdf, destination: PdfOutlineItem["dest"]) {
  try {
    const resolved = typeof destination === "string" ? await pdf.getDestination(destination) : destination;
    const target = resolved?.[0];
    if (typeof target === "number") return target + 1;
    if (target && typeof target === "object") return (await pdf.getPageIndex(target)) + 1;
  } catch { /* A broken bookmark should not prevent the rest of the contents from loading. */ }
  return null;
}

async function readOutline(pdf: StructurePdf) {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const found: Array<BookStructureEntry & { depth: number }> = [];

  async function visit(items: PdfOutlineItem[], depth: number) {
    for (const item of items) {
      const title = cleanTitle(item.title);
      const pageNumber = await destinationPage(pdf, item.dest);
      if (title && pageNumber) found.push({ id: "", title, pageNumber, level: depth ? 1 : 0, source: "outline", depth });
      if (item.items?.length) await visit(item.items, depth + 1);
    }
  }
  await visit(outline, 0);
  if (!found.length) return [];

  const baseDepth = Math.min(...found.map((entry) => entry.depth));
  return found
    .map((entry) => ({ ...entry, level: (entry.depth > baseDepth || /^\d+(?:\.\d+)+\b/.test(entry.title) ? 1 : 0) as 0 | 1 }))
    .map(({ depth: _depth, ...entry }) => ({ ...entry, id: entryId(entry.source, entry.pageNumber, entry.level, entry.title) }))
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function extractBookmarkStructure(pdf: StructurePdf) {
  return numberStructure(await readOutline(pdf));
}

export function mapBookmarkStructure(entries: BookStructureEntry[], sourcePageCount: number, targetPageCount: number) {
  const sourcePages = Math.max(1, sourcePageCount);
  const targetPages = Math.max(1, targetPageCount);
  const exact = sourcePages === targetPages;
  return entries.map((entry) => {
    const pageNumber = exact
      ? clampPage(entry.pageNumber, targetPages)
      : Math.round(((clampPage(entry.pageNumber, sourcePages) - 1) / Math.max(1, sourcePages - 1)) * Math.max(0, targetPages - 1)) + 1;
    return { ...entry, pageNumber, source: "outline" as const, id: entryId("outline", pageNumber, entry.level, entry.title) };
  });
}

function clampPage(pageNumber: number, pageCount: number) {
  return Math.min(pageCount, Math.max(1, Math.round(pageNumber)));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) / 2)];
}

function textHeading(line: string, fontSize: number, bodySize: number) {
  const chapter = line.match(/^(chapter|part|appendix)\s+([A-Z0-9IVXLC]+)(?:\s*[:.\-–—]\s*|\s+)?(.*)$/i);
  if (chapter && fontSize >= bodySize * 1.05) return { level: 0 as const, title: cleanTitle(line) };
  if (/^\d{1,3}\s+[A-Z][A-Z\s,'’:&\-–—]{2,}$/.test(line) && fontSize >= bodySize * 1.15) return { level: 0 as const, title: cleanTitle(line) };
  const section = line.match(/^(\d+(?:\.\d+){1,3})\.?\s+(.{2,140})$/);
  if (section && fontSize >= bodySize * 1.08) return { level: 1 as const, title: cleanTitle(line) };
  return null;
}

async function inferFromText(pdf: StructurePdf, onProgress?: (pageNumber: number, pageCount: number) => void) {
  const entries: BookStructureEntry[] = [];
  const seen = new Set<string>();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is PdfTextItem => Boolean(item && typeof item === "object" && "str" in item && "transform" in item));
    const sizes = items.map((item) => Math.abs(item.transform[3] || item.height || 0)).filter((size) => size > 0);
    const bodySize = median(sizes) || 10;
    const rows = new Map<number, PdfTextItem[]>();
    for (const item of items) {
      if (!item.str.trim()) continue;
      const y = Math.round((item.transform[5] ?? 0) / 2) * 2;
      const row = rows.get(y) ?? [];
      row.push(item); rows.set(y, row);
    }
    const candidates = [...rows.entries()]
      .filter(([y]) => y >= viewport.height * .42)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 22);
    for (const [, row] of candidates) {
      row.sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
      const line = cleanTitle(row.map((item) => item.str).join(" "));
      const fontSize = Math.max(...row.map((item) => Math.abs(item.transform[3] || item.height || 0)));
      const heading = textHeading(line, fontSize, bodySize);
      if (!heading) continue;
      const signature = `${heading.level}:${heading.title.toLowerCase()}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      entries.push({ id: entryId("text", pageNumber, heading.level, heading.title), title: heading.title, pageNumber, level: heading.level, source: "text" });
    }
    page.cleanup?.();
    onProgress?.(pageNumber, pdf.numPages);
  }

  const chapterPrefixes = new Set(entries.filter((entry) => entry.level === 0).map((entry) => entry.title.match(/\d+/)?.[0]).filter(Boolean));
  const synthetic: BookStructureEntry[] = [];
  for (const section of entries.filter((entry) => entry.level === 1)) {
    const prefix = section.title.match(/^([0-9]+)\./)?.[1];
    if (!prefix || chapterPrefixes.has(prefix)) continue;
    chapterPrefixes.add(prefix);
    const title = `Chapter ${prefix}`;
    synthetic.push({ id: entryId("text", section.pageNumber, 0, title), title, pageNumber: section.pageNumber, level: 0, source: "text" });
  }
  return [...entries, ...synthetic].sort((a, b) => a.pageNumber - b.pageNumber || a.level - b.level);
}

export async function extractBookStructure(pdf: StructurePdf, onProgress?: (pageNumber: number, pageCount: number) => void) {
  const outline = await extractBookmarkStructure(pdf);
  // A usable PDF outline is authoritative. Text scanning is only a fallback for
  // PDFs without bookmarks (or whose bookmark destinations are broken).
  return outline.length ? outline : numberStructure(await inferFromText(pdf, onProgress));
}

export type DocumentRecord = {
  id: string;
  title: string;
  originalFilename: string;
  fileSize: number;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  bookStructure?: BookStructureEntry[];
  bookStructureScannedAt?: string;
  bookStructureVersion?: number;
};

export type BookStructureEntry = {
  id: string;
  title: string;
  number?: string;
  pageNumber: number;
  level: 0 | 1;
  source: "outline" | "text";
};

export type NormalizedRect = { x: number; y: number; width: number; height: number };
export type AnnotationGeometry = { rects: NormalizedRect[] } | NormalizedRect;
export type AnnotationColor = "sage" | "gold" | "rose" | "blue";

export type AnnotationRecord = {
  id: string;
  documentId: string;
  pageNumber: number;
  type: "text" | "area";
  geometry: AnnotationGeometry;
  selectedText: string | null;
  bodyMarkdown: string;
  color: AnnotationColor;
  createdAt: string;
  updatedAt: string;
};

export const ANNOTATION_COLORS: AnnotationColor[] = ["sage", "gold", "rose", "blue"];
export const MAX_PDF_SIZE = 75 * 1024 * 1024;

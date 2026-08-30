export type DocumentRecord = {
  id: string;
  title: string;
  originalFilename: string;
  fileSize: number;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  treatAsTextbook?: boolean;
  /** Legacy classification retained so existing local libraries can be migrated without data loss. */
  documentType?: DocumentType;
  folderId?: string | null;
  libraryOrder?: number;
  bookStructure?: BookStructureEntry[];
  bookStructureScannedAt?: string;
  bookStructureVersion?: number;
};

export type DocumentType = "textbook" | "problem-set";

export type LibraryFolder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  libraryOrder?: number;
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
  title?: string;
  bodyMarkdown: string;
  color: AnnotationColor;
  linkedAnnotationIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export const ANNOTATION_COLORS: AnnotationColor[] = ["sage", "gold", "rose", "blue"];
export const MAX_PDF_SIZE = 120 * 1024 * 1024;

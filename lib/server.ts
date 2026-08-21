import { env } from "cloudflare:workers";
import type { AnnotationGeometry, AnnotationRecord, DocumentRecord, NormalizedRect } from "./types";
import { ANNOTATION_COLORS } from "./types";

type Bindings = { DB: D1Database; FILES: R2Bucket };

export function getBindings(): Bindings {
  const bindings = env as unknown as Partial<Bindings>;
  if (!bindings.DB) throw new Error("The document database is unavailable.");
  if (!bindings.FILES) throw new Error("The PDF store is unavailable.");
  return bindings as Bindings;
}

export function apiError(error: unknown, fallback = "Something went wrong.") {
  console.error(error);
  const message = error instanceof Error && error.message.includes("unavailable") ? error.message : fallback;
  return Response.json({ error: message }, { status: 500 });
}

export function documentFromRow(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id), title: String(row.title), originalFilename: String(row.original_filename),
    fileSize: Number(row.file_size), pageCount: Number(row.page_count), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), lastOpenedAt: String(row.last_opened_at),
  };
}

export function annotationFromRow(row: Record<string, unknown>): AnnotationRecord {
  return {
    id: String(row.id), documentId: String(row.document_id), pageNumber: Number(row.page_number),
    type: row.type === "area" ? "area" : "text", geometry: JSON.parse(String(row.geometry)) as AnnotationGeometry,
    selectedText: row.selected_text == null ? null : String(row.selected_text), bodyMarkdown: String(row.body_markdown ?? ""),
    color: ANNOTATION_COLORS.includes(row.color as never) ? row.color as AnnotationRecord["color"] : "sage",
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function validRect(value: unknown): value is NormalizedRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]) && Number(rect[key]) >= 0 && Number(rect[key]) <= 1)
    && Number(rect.x) + Number(rect.width) <= 1.001 && Number(rect.y) + Number(rect.height) <= 1.001;
}

export function validGeometry(type: "text" | "area", value: unknown): value is AnnotationGeometry {
  if (type === "area") return validRect(value);
  if (!value || typeof value !== "object") return false;
  const rects = (value as { rects?: unknown }).rects;
  return Array.isArray(rects) && rects.length > 0 && rects.length <= 200 && rects.every(validRect);
}

export async function findDocument(id: string) {
  return getBindings().DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

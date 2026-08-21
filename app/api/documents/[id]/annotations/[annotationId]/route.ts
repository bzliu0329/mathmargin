import { annotationFromRow, apiError, getBindings, validGeometry } from "@/lib/server";
import { ANNOTATION_COLORS } from "@/lib/types";

type Context = { params: Promise<{ id: string; annotationId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id, annotationId } = await params;
    const existing = await getBindings().DB.prepare("SELECT * FROM annotations WHERE id = ? AND document_id = ?")
      .bind(annotationId, id).first<Record<string, unknown>>();
    if (!existing) return Response.json({ error: "This annotation was not found." }, { status: 404 });
    const payload = await request.json() as Record<string, unknown>;
    const body = typeof payload.bodyMarkdown === "string" ? payload.bodyMarkdown.slice(0, 100000) : String(existing.body_markdown);
    const color = ANNOTATION_COLORS.includes(payload.color as never) ? String(payload.color) : String(existing.color);
    const geometry = payload.geometry === undefined ? JSON.parse(String(existing.geometry)) : payload.geometry;
    const type = existing.type === "area" ? "area" : "text";
    if (!validGeometry(type, geometry)) return Response.json({ error: "This annotation has an invalid shape." }, { status: 400 });
    const row = await getBindings().DB.prepare(`
      UPDATE annotations SET body_markdown = ?, color = ?, geometry = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND document_id = ? RETURNING *
    `).bind(body, color, JSON.stringify(geometry), annotationId, id).first<Record<string, unknown>>();
    if (!row) return Response.json({ error: "This annotation was not found." }, { status: 404 });
    return Response.json({ annotation: annotationFromRow(row) });
  } catch (error) {
    return apiError(error, "We could not save this annotation.");
  }
}

export async function DELETE(_: Request, { params }: Context) {
  try {
    const { id, annotationId } = await params;
    const result = await getBindings().DB.prepare("DELETE FROM annotations WHERE id = ? AND document_id = ?")
      .bind(annotationId, id).run();
    if (!result.meta.changes) return Response.json({ error: "This annotation was not found." }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error, "We could not delete this annotation.");
  }
}

import { annotationFromRow, apiError, findDocument, getBindings, validGeometry } from "@/lib/server";
import { ANNOTATION_COLORS } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Context) {
  try {
    const { id } = await params;
    if (!await findDocument(id)) return Response.json({ error: "This textbook was not found." }, { status: 404 });
    const result = await getBindings().DB.prepare("SELECT * FROM annotations WHERE document_id = ? ORDER BY page_number, created_at")
      .bind(id).all<Record<string, unknown>>();
    return Response.json({ annotations: result.results.map(annotationFromRow) });
  } catch (error) {
    return apiError(error, "We could not load your annotations.");
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { id: documentId } = await params;
    const document = await findDocument(documentId);
    if (!document) return Response.json({ error: "This textbook was not found." }, { status: 404 });
    const payload = await request.json() as Record<string, unknown>;
    const type = payload.type === "area" ? "area" : payload.type === "text" ? "text" : null;
    const pageNumber = Number(payload.pageNumber);
    if (!type || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > Number(document.page_count)) {
      return Response.json({ error: "This annotation has an invalid page." }, { status: 400 });
    }
    if (!validGeometry(type, payload.geometry)) return Response.json({ error: "This annotation has an invalid shape." }, { status: 400 });
    const color = ANNOTATION_COLORS.includes(payload.color as never) ? String(payload.color) : "sage";
    const selectedText = type === "text" && typeof payload.selectedText === "string" ? payload.selectedText.trim().slice(0, 10000) : null;
    const body = typeof payload.bodyMarkdown === "string" ? payload.bodyMarkdown.slice(0, 100000) : "";
    const row = await getBindings().DB.prepare(`
      INSERT INTO annotations (id, document_id, page_number, type, geometry, selected_text, body_markdown, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).bind(crypto.randomUUID(), documentId, pageNumber, type, JSON.stringify(payload.geometry), selectedText, body, color)
      .first<Record<string, unknown>>();
    if (!row) throw new Error("The annotation could not be saved.");
    return Response.json({ annotation: annotationFromRow(row) }, { status: 201 });
  } catch (error) {
    return apiError(error, "We could not create this annotation.");
  }
}

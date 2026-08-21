import { apiError, documentFromRow, findDocument, getBindings } from "@/lib/server";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Context) {
  try {
    const { id } = await params;
    const row = await findDocument(id);
    if (!row) return Response.json({ error: "This textbook was not found." }, { status: 404 });
    await getBindings().DB.prepare("UPDATE documents SET last_opened_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return Response.json({ document: documentFromRow({ ...row, last_opened_at: new Date().toISOString() }) });
  } catch (error) {
    return apiError(error, "We could not open this textbook.");
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const payload = await request.json() as { title?: unknown };
    const title = typeof payload.title === "string" ? payload.title.trim().slice(0, 160) : "";
    if (!title) return Response.json({ error: "A title is required." }, { status: 400 });
    const row = await getBindings().DB.prepare("UPDATE documents SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *")
      .bind(title, id).first<Record<string, unknown>>();
    if (!row) return Response.json({ error: "This textbook was not found." }, { status: 404 });
    return Response.json({ document: documentFromRow(row) });
  } catch (error) {
    return apiError(error, "We could not rename this textbook.");
  }
}

export async function DELETE(_: Request, { params }: Context) {
  try {
    const { id } = await params;
    const row = await findDocument(id);
    if (!row) return Response.json({ error: "This textbook was not found." }, { status: 404 });
    const { DB, FILES } = getBindings();
    await DB.batch([
      DB.prepare("DELETE FROM annotations WHERE document_id = ?").bind(id),
      DB.prepare("DELETE FROM documents WHERE id = ?").bind(id),
    ]);
    await FILES.delete(String(row.r2_key));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error, "We could not delete this textbook.");
  }
}

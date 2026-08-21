import { apiError, documentFromRow, getBindings } from "@/lib/server";
import { MAX_PDF_SIZE } from "@/lib/types";

export async function GET() {
  try {
    const result = await getBindings().DB.prepare("SELECT * FROM documents ORDER BY last_opened_at DESC, created_at DESC").all<Record<string, unknown>>();
    return Response.json({ documents: result.results.map(documentFromRow) });
  } catch (error) {
    return apiError(error, "We could not load your library.");
  }
}

export async function POST(request: Request) {
  let storedKey: string | null = null;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a PDF to upload." }, { status: 400 });
    if (file.size > MAX_PDF_SIZE) return Response.json({ error: "This PDF is larger than the 75 MB limit." }, { status: 413 });
    if (file.size < 5) return Response.json({ error: "This file is not a valid PDF." }, { status: 400 });

    const signature = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
    if (signature !== "%PDF-") return Response.json({ error: "This file is not a valid PDF." }, { status: 400 });

    const pageCount = Number(form.get("pageCount"));
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100000) {
      return Response.json({ error: "We could not read the pages in this PDF." }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const cleanFilename = file.name.slice(0, 240) || "textbook.pdf";
    const suppliedTitle = String(form.get("title") ?? "").trim();
    const title = (suppliedTitle || cleanFilename.replace(/\.pdf$/i, "")).slice(0, 160);
    storedKey = `documents/${id}.pdf`;
    const { DB, FILES } = getBindings();

    await FILES.put(storedKey, file.stream(), {
      httpMetadata: { contentType: "application/pdf", contentDisposition: `inline; filename="${cleanFilename.replace(/["\\]/g, "")}"` },
      customMetadata: { originalFilename: cleanFilename },
    });

    const row = await DB.prepare(`
      INSERT INTO documents (id, title, original_filename, r2_key, file_size, page_count)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *
    `).bind(id, title, cleanFilename, storedKey, file.size, pageCount).first<Record<string, unknown>>();
    if (!row) throw new Error("The uploaded document could not be saved.");
    return Response.json({ document: documentFromRow(row) }, { status: 201 });
  } catch (error) {
    if (storedKey) await getBindings().FILES.delete(storedKey).catch(() => undefined);
    return apiError(error, "We could not upload this PDF.");
  }
}

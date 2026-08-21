import { apiError, findDocument, getBindings } from "@/lib/server";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const document = await findDocument(id);
    if (!document) return Response.json({ error: "This textbook was not found." }, { status: 404 });

    const size = Number(document.file_size);
    const rangeHeader = request.headers.get("Range");
    let object: R2ObjectBody | null;
    let status = 200;
    const headers = new Headers({
      "Content-Type": "application/pdf", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${String(document.original_filename).replace(/["\\]/g, "")}"`,
    });

    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end < start) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      object = await getBindings().FILES.get(String(document.r2_key), { range: { offset: start, length: end - start + 1 } });
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(end - start + 1));
      status = 206;
    } else {
      object = await getBindings().FILES.get(String(document.r2_key));
      headers.set("Content-Length", String(size));
    }
    if (!object) return Response.json({ error: "The PDF file is missing." }, { status: 404 });
    return new Response(object.body, { status, headers });
  } catch (error) {
    return apiError(error, "We could not load this PDF.");
  }
}

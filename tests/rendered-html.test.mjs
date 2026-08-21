import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: { batch: async () => [], prepare: () => ({}) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders MathMargin metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Library · MathMargin<\/title>/i);
  assert.match(html, /Read closely\. Think in the margins\./);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps storage, annotation, and safety contracts in source", async () => {
  const [hosting, schema, library, reader, layout] = await Promise.all([
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("components/LibraryClient.tsx", root), "utf8"),
    readFile(new URL("components/ReaderClient.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "FILES"/);
  assert.match(schema, /annotations_document_page_idx/);
  assert.match(library, /MAX_PDF_SIZE/);
  assert.match(library, /password-protected/i);
  assert.match(reader, /remarkMath/);
  assert.match(reader, /rehypeKatex/);
  assert.doesNotMatch(reader, /rehypeRaw|dangerouslySetInnerHTML/);
  assert.match(layout, /MathMargin/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});

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
  assert.match(library, /120 MB/);
  assert.match(library, /password-protected/i);
  assert.match(reader, /remarkMath/);
  assert.match(reader, /rehypeKatex/);
  assert.doesNotMatch(reader, /rehypeRaw|dangerouslySetInnerHTML/);
  assert.match(layout, /MathMargin/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});

test("keeps desktop PDF folders and optional textbook treatment persistent", async () => {
  const [desktop, storage, types] = await Promise.all([
    readFile(new URL("desktop/src/DesktopApp.tsx", root), "utf8"),
    readFile(new URL("desktop/src/storage.ts", root), "utf8"),
    readFile(new URL("lib/types.ts", root), "utf8"),
  ]);
  assert.match(types, /treatAsTextbook\?: boolean/);
  assert.match(types, /folderId\?: string \| null/);
  assert.match(types, /parentFolderId\?: string \| null/);
  assert.match(types, /bookStructureImportedFrom\?: string/);
  assert.match(types, /bookStructureImportMode\?: "exact" \| "proportional"/);
  assert.match(storage, /createObjectStore\("folders"/);
  assert.match(storage, /export async function removeFolder/);
  assert.match(storage, /removedDocumentIds/);
  assert.match(storage, /removedAnnotationIds/);
  assert.match(storage, /removedFolderIds/);
  assert.match(desktop, /Treat as textbook/);
  assert.match(desktop, /Automatically detect chapters and sections/);
  assert.match(desktop, /!treatsDocumentAsTextbook/);
  assert.doesNotMatch(desktop, /What kind of PDF is this\?/);
  assert.doesNotMatch(desktop, />Problem set</);
  assert.match(desktop, /Put it in a folder/);
  assert.match(desktop, /library-folder-tile/);
  assert.match(desktop, /Create a new folder/);
  assert.match(desktop, /explorer-command-bar/);
  assert.match(desktop, /explorer-address-row/);
  assert.match(desktop, /application\/x-mathmargin-document-id/);
  assert.match(desktop, /dropDocumentIntoFolder/);
  assert.match(desktop, /Import folder/);
  assert.match(desktop, /webkitdirectory/);
  assert.match(desktop, /relativeDirectoryPaths/);
  assert.match(desktop, /folderByRelativePath/);
  assert.match(desktop, /folderSubtreeIds/);
  assert.match(desktop, /folderLineage/);
  assert.match(desktop, /original subfolder hierarchy will be preserved/i);
  assert.match(desktop, /folder-rename-dialog/);
  assert.match(desktop, /folder-delete-dialog/);
  assert.match(desktop, /folder-import-dialog/);
  assert.match(desktop, /useState\("unfiled"\)/);
  assert.doesNotMatch(desktop, /▣ All PDFs/);
  assert.match(desktop, /All of them will be removed from your library/);
  assert.match(desktop, /selectedDocumentIds/);
  assert.match(desktop, /Ctrl\+click, Shift\+click/);
  assert.match(desktop, /application\/x-mathmargin-document-ids/);
  assert.match(desktop, /move-to-folder-command/);
  assert.match(desktop, /move-pdf-dialog/);
  assert.match(desktop, /Choose the destination folder/);
  assert.match(desktop, /confirmMove/);
  assert.match(desktop, /discardDocuments/);
  assert.match(desktop, /LIVE_ANNOTATION_EVENT/);
  assert.match(desktop, /publishLiveAnnotation/);
  assert.match(desktop, /mergeLiveAnnotations/);
  assert.match(desktop, /relatedAnnotations/);
  assert.match(desktop, /annotationsAreLinked/);
  assert.match(desktop, /two-way/);
  assert.match(storage, /repairBidirectionalAnnotationLinks/);
  assert.match(storage, /putAnnotationPair/);
  assert.match(desktop, /Search by annotation name, note, or PDF/);
  assert.match(desktop, /data-annotation-name/);
  assert.match(desktop, /name === normalizedLinkSearch/);
  assert.match(desktop, /data-structure-source/);
  assert.match(desktop, /Using this PDF’s bookmarks/);
  assert.match(desktop, /bookmark-import-input/);
  assert.match(desktop, /bookmark-import-dialog/);
  assert.match(desktop, /confirm-bookmark-import-button/);
  assert.match(desktop, /not added to your MathMargin library or stored separately/i);
  const structure = await readFile(new URL("desktop/src/bookStructure.ts", root), "utf8");
  assert.match(structure, /BOOK_STRUCTURE_VERSION = 4/);
  assert.match(structure, /extractBookmarkStructure/);
  assert.match(structure, /mapBookmarkStructure/);
  assert.match(structure, /outline\.length \? outline : numberStructure/);
});

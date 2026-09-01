import assert from "node:assert/strict";
import test from "node:test";
import type { BookStructureEntry } from "../lib/types.ts";
import { mapBookmarkStructure } from "../desktop/src/bookStructure.ts";

const outline: BookStructureEntry[] = [
  { id: "chapter", title: "Chapter 1", number: "1", pageNumber: 1, level: 0, source: "outline" },
  { id: "section", title: "1.1 Groups", number: "1.1", pageNumber: 51, level: 1, source: "outline" },
  { id: "last", title: "Appendix A", number: "A", pageNumber: 101, level: 0, source: "outline" },
];

test("keeps bookmark destinations exact when editions have the same page count", () => {
  const mapped = mapBookmarkStructure(outline, 101, 101);
  assert.deepEqual(mapped.map((entry) => entry.pageNumber), [1, 51, 101]);
  assert.deepEqual(mapped.map((entry) => entry.number), ["1", "1.1", "A"]);
  assert.ok(mapped.every((entry) => entry.source === "outline"));
});

test("maps bookmark destinations proportionally when editions have different page counts", () => {
  const mapped = mapBookmarkStructure(outline, 101, 201);
  assert.deepEqual(mapped.map((entry) => entry.pageNumber), [1, 101, 201]);
  assert.equal(mapped[1].title, "1.1 Groups");
});


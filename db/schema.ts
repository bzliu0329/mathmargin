import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  originalFilename: text("original_filename").notNull(),
  r2Key: text("r2_key").notNull().unique(),
  fileSize: integer("file_size").notNull(),
  pageCount: integer("page_count").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastOpenedAt: text("last_opened_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const annotations = sqliteTable("annotations", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  type: text("type", { enum: ["text", "area"] }).notNull(),
  geometry: text("geometry").notNull(),
  selectedText: text("selected_text"),
  bodyMarkdown: text("body_markdown").notNull().default(""),
  color: text("color").notNull().default("sage"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("annotations_document_page_idx").on(table.documentId, table.pageNumber)]);

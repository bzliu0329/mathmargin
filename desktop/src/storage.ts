import type { AnnotationRecord, DocumentRecord } from "../../lib/types";

export type LocalDocument = DocumentRecord & { file: Blob };

const DB_NAME = "mathmargin-desktop";
const DB_VERSION = 1;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("documents")) {
        database.createObjectStore("documents", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("annotations")) {
        const store = database.createObjectStore("annotations", { keyPath: "id" });
        store.createIndex("documentId", "documentId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Storage transaction was cancelled."));
  });
}

export async function listDocuments() {
  const database = await openDatabase();
  const values = await requestResult(database.transaction("documents", "readonly").objectStore("documents").getAll()) as LocalDocument[];
  database.close();
  return values.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export async function getDocument(id: string) {
  const database = await openDatabase();
  const value = await requestResult(database.transaction("documents", "readonly").objectStore("documents").get(id)) as LocalDocument | undefined;
  database.close();
  return value;
}

export async function putDocument(document: LocalDocument) {
  const database = await openDatabase();
  const transaction = database.transaction("documents", "readwrite");
  transaction.objectStore("documents").put(document);
  await transactionDone(transaction);
  database.close();
}

export async function removeDocument(id: string) {
  const database = await openDatabase();
  const transaction = database.transaction(["documents", "annotations"], "readwrite");
  transaction.objectStore("documents").delete(id);
  const index = transaction.objectStore("annotations").index("documentId");
  const cursor = index.openCursor(IDBKeyRange.only(id));
  cursor.onsuccess = () => {
    const match = cursor.result;
    if (match) { match.delete(); match.continue(); }
  };
  await transactionDone(transaction);
  database.close();
}

export async function listAnnotations(documentId: string) {
  const database = await openDatabase();
  const index = database.transaction("annotations", "readonly").objectStore("annotations").index("documentId");
  const values = await requestResult(index.getAll(IDBKeyRange.only(documentId))) as AnnotationRecord[];
  database.close();
  return values.sort((a, b) => a.pageNumber - b.pageNumber || a.createdAt.localeCompare(b.createdAt));
}

export async function putAnnotation(annotation: AnnotationRecord) {
  const database = await openDatabase();
  const transaction = database.transaction("annotations", "readwrite");
  transaction.objectStore("annotations").put(annotation);
  await transactionDone(transaction);
  database.close();
}

export async function removeAnnotation(id: string) {
  const database = await openDatabase();
  const transaction = database.transaction("annotations", "readwrite");
  transaction.objectStore("annotations").delete(id);
  await transactionDone(transaction);
  database.close();
}

import type { AnnotationRecord, DocumentRecord, LibraryFolder } from "../../lib/types";

export type LocalDocument = DocumentRecord & { file: ArrayBuffer | Blob };

const DB_NAME = "mathmargin-desktop-v2";
const DB_VERSION = 2;

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
      if (!database.objectStoreNames.contains("folders")) database.createObjectStore("folders", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listFolders() {
  const database = await openDatabase();
  const values = await requestResult(database.transaction("folders", "readonly").objectStore("folders").getAll()) as LibraryFolder[];
  database.close();
  return values.sort((left, right) => (left.libraryOrder ?? Number.MAX_SAFE_INTEGER) - (right.libraryOrder ?? Number.MAX_SAFE_INTEGER) || left.name.localeCompare(right.name));
}

export async function putFolder(folder: LibraryFolder) {
  const database = await openDatabase();
  const transaction = database.transaction("folders", "readwrite");
  transaction.objectStore("folders").put(folder);
  await transactionDone(transaction);
  database.close();
}

export async function removeFolder(id: string) {
  const database = await openDatabase();
  const transaction = database.transaction(["folders", "documents", "annotations"], "readwrite");
  transaction.objectStore("folders").delete(id);
  const documentStore = transaction.objectStore("documents");
  const documents = await requestResult(documentStore.getAll()) as LocalDocument[];
  const removedDocumentIds = new Set(documents.filter((document) => document.folderId === id).map((document) => document.id));
  for (const documentId of removedDocumentIds) documentStore.delete(documentId);
  const annotationStore = transaction.objectStore("annotations");
  const annotations = await requestResult(annotationStore.getAll()) as AnnotationRecord[];
  const removedAnnotationIds = new Set(annotations.filter((annotation) => removedDocumentIds.has(annotation.documentId)).map((annotation) => annotation.id));
  const now = new Date().toISOString();
  for (const annotation of annotations) {
    if (removedAnnotationIds.has(annotation.id)) {
      annotationStore.delete(annotation.id);
      continue;
    }
    const linkedAnnotationIds = annotation.linkedAnnotationIds?.filter((linkedId) => !removedAnnotationIds.has(linkedId));
    if (linkedAnnotationIds?.length !== annotation.linkedAnnotationIds?.length) annotationStore.put({ ...annotation, linkedAnnotationIds, updatedAt: now });
  }
  await transactionDone(transaction);
  database.close();
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
  return values.sort((a, b) => {
    const aOrder = Number.isFinite(a.libraryOrder) ? a.libraryOrder! : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(b.libraryOrder) ? b.libraryOrder! : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || b.lastOpenedAt.localeCompare(a.lastOpenedAt);
  });
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
  const annotationStore = transaction.objectStore("annotations");
  const annotations = await requestResult(annotationStore.getAll()) as AnnotationRecord[];
  const removedIds = new Set(annotations.filter((annotation) => annotation.documentId === id).map((annotation) => annotation.id));
  for (const annotation of annotations) {
    if (removedIds.has(annotation.id)) {
      annotationStore.delete(annotation.id);
      continue;
    }
    const linkedAnnotationIds = annotation.linkedAnnotationIds?.filter((linkedId) => !removedIds.has(linkedId));
    if (linkedAnnotationIds?.length !== annotation.linkedAnnotationIds?.length) annotationStore.put({ ...annotation, linkedAnnotationIds, updatedAt: new Date().toISOString() });
  }
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

export async function listAllAnnotations() {
  const database = await openDatabase();
  const values = await requestResult(database.transaction("annotations", "readonly").objectStore("annotations").getAll()) as AnnotationRecord[];
  database.close();
  return values;
}

export async function getAnnotation(id: string) {
  const database = await openDatabase();
  const value = await requestResult(database.transaction("annotations", "readonly").objectStore("annotations").get(id)) as AnnotationRecord | undefined;
  database.close();
  return value;
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
  const store = transaction.objectStore("annotations");
  const annotations = await requestResult(store.getAll()) as AnnotationRecord[];
  store.delete(id);
  for (const annotation of annotations) {
    if (!annotation.linkedAnnotationIds?.includes(id)) continue;
    store.put({ ...annotation, linkedAnnotationIds: annotation.linkedAnnotationIds.filter((linkedId) => linkedId !== id), updatedAt: new Date().toISOString() });
  }
  await transactionDone(transaction);
  database.close();
}

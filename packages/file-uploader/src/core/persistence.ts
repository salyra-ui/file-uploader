import type { PersistenceSnapshot, UploadPersistence } from "./types";
/** The namespace should include the application's current user identity. No files or credentials are stored. */
export function indexedDBPersistence(namespace: string): UploadPersistence {
  if (!namespace.trim()) throw new Error("A persistence namespace is required");
  async function db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("salyra-uploader", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("sessions");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
  }
  return {
    async load() {
      const database = await db();
      try {
        return await new Promise<PersistenceSnapshot | null>(
          (resolve, reject) => {
            const tx = database.transaction("sessions", "readonly");
            const req = tx.objectStore("sessions").get(namespace);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
          },
        );
      } finally {
        database.close();
      }
    },
    async save(value) {
      const database = await db();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction("sessions", "readwrite");
          tx.objectStore("sessions").put(value, namespace);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        database.close();
      }
    },
  };
}

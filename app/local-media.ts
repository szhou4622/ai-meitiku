export type LocalAssetType = "image" | "video" | "audio";

export type LocalFileRecord = {
  key: string;
  path: string;
  file: File;
  handle: FileSystemFileHandleLike;
  type: LocalAssetType;
};

export type PermissionStateLike = "granted" | "denied" | "prompt";

export type FileSystemFileHandleLike = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
};

export type FileSystemDirectoryHandleLike = {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, FileSystemFileHandleLike | FileSystemDirectoryHandleLike]>;
  queryPermission?(options?: { mode: "read" }): Promise<PermissionStateLike>;
  requestPermission?(options?: { mode: "read" }): Promise<PermissionStateLike>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read"; id?: string }) => Promise<FileSystemDirectoryHandleLike>;
  }
}

const DATABASE_NAME = "local-media-library";
const STORE_NAME = "handles";
const VECTOR_STORE_NAME = "vectors";
const DIRECTORY_KEY = "library-directory";

const extensionTypes: Record<string, LocalAssetType> = {
  jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", avif: "image", bmp: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video", mkv: "video", avi: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
};

function openHandleDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(VECTOR_STORE_NAME)) {
        request.result.createObjectStore(VECTOR_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadAssetVectors(): Promise<Record<string, number[]>> {
  const database = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(VECTOR_STORE_NAME, "readonly");
    const store = transaction.objectStore(VECTOR_STORE_NAME);
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();
    transaction.oncomplete = () => {
      const output: Record<string, number[]> = {};
      keysRequest.result.forEach((key, index) => { output[String(key)] = valuesRequest.result[index] as number[]; });
      database.close();
      resolve(output);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveAssetVector(key: string, vector: number[]): Promise<void> {
  const database = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(VECTOR_STORE_NAME, "readwrite");
    transaction.objectStore(VECTOR_STORE_NAME).put(vector, key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function clearAssetVectors(): Promise<void> {
  const database = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(VECTOR_STORE_NAME, "readwrite");
    transaction.objectStore(VECTOR_STORE_NAME).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function readHandle<T>(key: string): Promise<T | null> {
  const database = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function writeHandle(key: string, value: unknown): Promise<void> {
  const database = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export function supportsLocalFolders(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function chooseLibraryDirectory(): Promise<FileSystemDirectoryHandleLike> {
  if (!window.showDirectoryPicker) throw new Error("folder-picker-unsupported");
  const handle = await window.showDirectoryPicker({ mode: "read", id: "media-library-root" });
  await writeHandle(DIRECTORY_KEY, handle);
  return handle;
}

export function loadLibraryDirectory(): Promise<FileSystemDirectoryHandleLike | null> {
  return readHandle<FileSystemDirectoryHandleLike>(DIRECTORY_KEY);
}

export async function getDirectoryPermission(
  handle: FileSystemDirectoryHandleLike,
  request = false,
): Promise<PermissionStateLike> {
  const method = request ? handle.requestPermission : handle.queryPermission;
  if (!method) return request ? "denied" : "prompt";
  return method.call(handle, { mode: "read" });
}

function inferType(file: File): LocalAssetType | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return extensionTypes[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

export async function scanLibraryDirectory(
  root: FileSystemDirectoryHandleLike,
  onProgress?: (count: number) => void,
): Promise<LocalFileRecord[]> {
  const records: LocalFileRecord[] = [];

  async function walk(directory: FileSystemDirectoryHandleLike, prefix: string) {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        if (!name.startsWith(".")) await walk(handle, path);
        continue;
      }
      const file = await handle.getFile();
      const type = inferType(file);
      if (!type) continue;
      records.push({ key: `${path}:${file.size}:${file.lastModified}`, path, file, handle, type });
      onProgress?.(records.length);
    }
  }

  await walk(root, "");
  return records;
}

export function stableLocalId(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 1_000_000 + (hash >>> 0);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

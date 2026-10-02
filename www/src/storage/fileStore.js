// Physical file storage. Imported files are COPIED into app-private storage so the
// archive keeps working even if the original is moved or deleted from the device.
//
// Two interchangeable backends share one interface:
//   put(id, file, { signal, onProgress })  copy bytes; atomic (all-or-nothing), cancellable
//   get(id)      -> File | null            null when the bytes are gone
//   stat(id)     -> { size } | null
//   remove(id)                             idempotent
//   list()       -> string[]               every stored id (used to sweep orphans)
//   refFor(id)   -> string                 human-readable location stored on the record
//
//   OpfsFileStore  Origin Private File System: streamed chunked copy with progress. Preferred.
//   IdbFileStore   Blobs in IndexedDB: fallback for browsers without OPFS writable streams.

import { abortError } from '../domain/errors.js';

const OPFS_DIR = 'archive-files';

export class OpfsFileStore {
  static isSupported() {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.storage?.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      'createWritable' in FileSystemFileHandle.prototype
    );
  }

  constructor() {
    this.kind = 'opfs';
    this._dir = null;
  }

  async dir() {
    if (!this._dir) {
      const root = await navigator.storage.getDirectory();
      this._dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    }
    return this._dir;
  }

  refFor(id) { return `opfs://${OPFS_DIR}/${id}`; }

  async put(id, file, { signal, onProgress } = {}) {
    const dir = await this.dir();
    const handle = await dir.getFileHandle(id, { create: true });
    // createWritable() writes to a swap file; nothing is visible until close() succeeds.
    const writable = await handle.createWritable();
    const reader = file.stream().getReader();
    try {
      let written = 0;
      for (;;) {
        if (signal?.aborted) throw abortError();
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        written += value.byteLength;
        onProgress?.(written, file.size);
      }
      if (signal?.aborted) throw abortError();
      await writable.close();
    } catch (err) {
      try { await reader.cancel(); } catch { /* ignore */ }
      try { await writable.abort(); } catch { /* ignore */ }
      try { await dir.removeEntry(id); } catch { /* ignore */ }
      throw err;
    }
    const saved = await (await dir.getFileHandle(id)).getFile();
    if (saved.size !== file.size) {
      await this.remove(id);
      throw new Error('Copy verification failed: stored size does not match the source.');
    }
  }

  async get(id) {
    try {
      const dir = await this.dir();
      return await (await dir.getFileHandle(id)).getFile();
    } catch (err) {
      if (err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  async stat(id) {
    const f = await this.get(id);
    return f ? { size: f.size } : null;
  }

  async remove(id) {
    try {
      const dir = await this.dir();
      await dir.removeEntry(id);
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
    }
  }

  async list() {
    const dir = await this.dir();
    const ids = [];
    for await (const name of dir.keys()) ids.push(name);
    return ids;
  }
}

const BLOB_DB = 'digital-archive-blobs';

export class IdbFileStore {
  constructor() {
    this.kind = 'idb';
    this._db = null;
  }

  refFor(id) { return `idb://${BLOB_DB}/${id}`; }

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BLOB_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('blobs');
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  }

  async _run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', mode);
      const req = fn(tx.objectStore('blobs'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    });
  }

  async put(id, file, { signal, onProgress } = {}) {
    if (signal?.aborted) throw abortError();
    // Reading into memory first means a unreadable source fails BEFORE anything is written.
    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw abortError();
    await this._run('readwrite', (s) => s.put(new Blob([buffer]), id));
    onProgress?.(file.size, file.size);
    const stored = await this.stat(id);
    if (!stored || stored.size !== file.size) {
      await this.remove(id);
      throw new Error('Copy verification failed: stored size does not match the source.');
    }
  }

  async get(id) {
    const blob = await this._run('readonly', (s) => s.get(id));
    return blob ? new File([blob], id) : null;
  }

  async stat(id) {
    const blob = await this._run('readonly', (s) => s.get(id));
    return blob ? { size: blob.size } : null;
  }

  async remove(id) { await this._run('readwrite', (s) => s.delete(id)); }
  async list() { return (await this._run('readonly', (s) => s.getAllKeys())) || []; }
}

export function createFileStore() {
  return OpfsFileStore.isSupported() ? new OpfsFileStore() : new IdbFileStore();
}

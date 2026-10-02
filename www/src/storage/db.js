// Persistent metadata storage (IndexedDB).
//
// Stores
//   files    one record per archived file            (key: id)
//   tags     user-defined tags / categories          (key: id, unique index: nameKey)
//   journal  "import in progress" markers            (key: id)
//
// The journal is what makes imports crash-safe: a marker is written BEFORE the
// bytes are copied and removed in the SAME transaction that inserts the file
// record (commitImport). A marker that survives a restart therefore always means
// "an import never finished" and its half-copied bytes can be deleted.

const DB_NAME = 'digital-archive';
const DB_VERSION = 1;

const wrap = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export class ArchiveDB {
  constructor(name = DB_NAME) {
    this.name = name;
    this.db = null;
  }

  open() {
    if (this.db) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const files = db.createObjectStore('files', { keyPath: 'id' });
        files.createIndex('fingerprint', 'fingerprint');
        files.createIndex('importedAt', 'importedAt');
        const tags = db.createObjectStore('tags', { keyPath: 'id' });
        tags.createIndex('nameKey', 'nameKey', { unique: true });
        db.createObjectStore('journal', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        this.db = req.result;
        this.db.onversionchange = () => this.db.close();
        resolve(this);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database upgrade blocked by another tab. Close other tabs and reload.'));
    });
  }

  /** Runs `work` inside one transaction; resolves after the transaction has committed. */
  async _tx(storeNames, mode, work) {
    const tx = this.db.transaction(storeNames, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
    let result;
    try {
      result = await work(...storeNames.map((n) => tx.objectStore(n)));
    } catch (err) {
      try { tx.abort(); } catch { /* already finished */ }
      await done.catch(() => {});
      throw err;
    }
    await done;
    return result;
  }

  // ---- files ---------------------------------------------------------------
  getAllFiles() { return this._tx(['files'], 'readonly', (s) => wrap(s.getAll())); }
  getFile(id) { return this._tx(['files'], 'readonly', (s) => wrap(s.get(id))); }
  findByFingerprint(fp) {
    return this._tx(['files'], 'readonly', (s) => wrap(s.index('fingerprint').getAll(fp)));
  }
  deleteFile(id) { return this._tx(['files'], 'readwrite', (s) => wrap(s.delete(id))); }

  /** Atomic read-modify-write. Returns the updated record, or null if it no longer exists. */
  updateFile(id, mutate) {
    return this._tx(['files'], 'readwrite', async (s) => {
      const current = await wrap(s.get(id));
      if (!current) return null;
      const next = mutate(current);
      await wrap(s.put(next));
      return next;
    });
  }

  // ---- import journal ------------------------------------------------------
  addJournal(entry) { return this._tx(['journal'], 'readwrite', (s) => wrap(s.put(entry))); }
  removeJournal(id) { return this._tx(['journal'], 'readwrite', (s) => wrap(s.delete(id))); }
  getJournal() { return this._tx(['journal'], 'readonly', (s) => wrap(s.getAll())); }

  /** Insert the file record and clear its journal marker in ONE transaction. */
  commitImport(record) {
    return this._tx(['files', 'journal'], 'readwrite', async (files, journal) => {
      await wrap(files.put(record));
      await wrap(journal.delete(record.id));
    });
  }

  // ---- tags ----------------------------------------------------------------
  getAllTags() { return this._tx(['tags'], 'readonly', (s) => wrap(s.getAll())); }
  putTag(tag) { return this._tx(['tags'], 'readwrite', (s) => wrap(s.put(tag))); }

  /** Delete a tag and strip it from every file, atomically. */
  deleteTag(id) {
    return this._tx(['tags', 'files'], 'readwrite', async (tags, files) => {
      await wrap(tags.delete(id));
      const all = await wrap(files.getAll());
      for (const f of all) {
        if (f.tagIds.includes(id)) {
          await wrap(files.put({ ...f, tagIds: f.tagIds.filter((t) => t !== id) }));
        }
      }
    });
  }
}

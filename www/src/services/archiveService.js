// Application logic. Knows nothing about the DOM, IndexedDB or OPFS: it talks to
// two injected "ports" (`db` for metadata, `files` for bytes), which is what lets
// the unit tests run the exact same code against in-memory fakes with failure injection.

import { detectCategory, extensionOf, guessMime } from '../domain/fileTypes.js';
import { computeFingerprint } from '../domain/fingerprint.js';
import { ValidationError, FileUnavailableError, abortError, isAbort } from '../domain/errors.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0)); // yield to the UI thread
const safely = async (fn) => { try { await fn(); } catch { /* best-effort cleanup */ } };

export class ArchiveService {
  constructor({ db, files, now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
    this.db = db;
    this.files = files;
    this.now = now;
    this.uuid = uuid;
  }

  async init() {
    await this.db.open();
    return this.recoverInterruptedImports();
  }

  // ===========================================================================
  // Import
  // ===========================================================================

  /**
   * Startup recovery. Any journal marker that is still present belongs to an import
   * that was killed mid-flight (the marker is deleted atomically with the record).
   * Also sweeps stored files that have no record (e.g. a removal that was interrupted).
   */
  async recoverInterruptedImports() {
    const known = new Set((await this.db.getAllFiles()).map((r) => r.id));
    let cleaned = 0;

    for (const entry of await this.db.getJournal()) {
      if (!known.has(entry.id)) {
        await safely(() => this.files.remove(entry.id));
        cleaned++;
      }
      await this.db.removeJournal(entry.id);
    }
    for (const id of await this.files.list()) {
      if (!known.has(id)) {
        await safely(() => this.files.remove(id));
        cleaned++;
      }
    }
    return { cleaned };
  }

  /** Indices of `files` that look identical to something already archived. */
  async detectDuplicates(files) {
    const dupes = new Set();
    for (let i = 0; i < files.length; i++) {
      try {
        const fp = await computeFingerprint(files[i]);
        if ((await this.db.findByFingerprint(fp)).length) dupes.add(i);
      } catch { /* unreadable files are reported during import */ }
    }
    return dupes;
  }

  /**
   * Import many files. Each file is its own unit of work, so one failure never
   * affects the others (partial success is reported per file).
   *
   * @param {File[]} files
   * @param {{signal?: AbortSignal, duplicatePolicy?: 'skip'|'import', onProgress?: Function}} opts
   */
  async importFiles(files, { signal, duplicatePolicy = 'import', onProgress } = {}) {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const base = { name: file.name, index: i };

      if (signal?.aborted) {
        results.push({ ...base, status: 'cancelled' });
        continue;
      }
      onProgress?.({ type: 'file-start', index: i, total: files.length, name: file.name, size: file.size });

      try {
        const record = await this._importOne(file, {
          signal,
          duplicatePolicy,
          onBytes: (written, size) =>
            onProgress?.({ type: 'bytes', index: i, total: files.length, name: file.name, written, size }),
        });
        results.push(record
          ? { ...base, status: 'imported', id: record.id }
          : { ...base, status: 'skipped-duplicate' });
      } catch (err) {
        results.push(isAbort(err)
          ? { ...base, status: 'cancelled' }
          : { ...base, status: 'failed', error: err.message || String(err) });
      }
      await tick();
    }

    const count = (s) => results.filter((r) => r.status === s).length;
    return {
      results,
      imported: count('imported'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      skipped: count('skipped-duplicate'),
    };
  }

  /**
   * Two-phase import:
   *   1. fingerprint (read-only)          -> nothing to undo
   *   2. journal marker                   -> "this id may have partial bytes"
   *   3. copy bytes (atomic, verified)    -> on failure the store removes its partial file
   *   4. commitImport: record + clear marker in one DB transaction
   * Any failure after step 2 deletes the bytes and the marker. A crash at any point
   * leaves a marker that recoverInterruptedImports() cleans up on the next launch.
   * The DB therefore never contains a record without a complete, verified file.
   */
  async _importOne(file, { signal, duplicatePolicy, onBytes }) {
    if (signal?.aborted) throw abortError();
    const fingerprint = await computeFingerprint(file); // also proves the source is readable
    if (duplicatePolicy === 'skip' && (await this.db.findByFingerprint(fingerprint)).length) return null;
    if (signal?.aborted) throw abortError();

    const id = this.uuid();
    await this.db.addJournal({ id, name: file.name, startedAt: this.now() });
    try {
      await this.files.put(id, file, { signal, onProgress: onBytes });
      const ext = extensionOf(file.name);
      const mimeType = file.type || guessMime(file.name) || 'application/octet-stream';
      const record = {
        id,
        name: file.name || 'Untitled',
        originalName: file.name || 'Untitled',
        ext,
        mimeType,
        category: detectCategory(file.name, mimeType),
        size: file.size,
        importedAt: this.now(),
        lastModified: file.lastModified || null,
        tagIds: [],
        storageKey: id,
        fileRef: this.files.refFor(id),
        availability: 'available',
        lastCheckedAt: this.now(),
        fingerprint,
      };
      await this.db.commitImport(record);
      return record;
    } catch (err) {
      await safely(() => this.files.remove(id));
      await safely(() => this.db.removeJournal(id));
      throw err;
    }
  }

  // ===========================================================================
  // Entries
  // ===========================================================================

  listFiles() { return this.db.getAllFiles(); }
  getFile(id) { return this.db.getFile(id); }

  /** Rename changes only the display name. The stored file is keyed by id, so it can't break the link. */
  async renameEntry(id, name) {
    const clean = String(name ?? '').trim();
    if (!clean) throw new ValidationError('Name can’t be empty.');
    if (clean.length > 255) throw new ValidationError('Name must be 255 characters or fewer.');
    const updated = await this.db.updateFile(id, (r) => ({ ...r, name: clean }));
    if (!updated) throw new ValidationError('That entry no longer exists.');
    return updated;
  }

  /**
   * Removing an entry deletes the archive record AND the app's private copy of the file.
   * The original file on the device is never touched (we only ever hold a copy).
   * Record goes first: if file deletion then fails we only leave an orphan, which the
   * next startup sweeps, instead of a record pointing at nothing.
   */
  async removeEntry(id) {
    const record = await this.db.getFile(id);
    if (!record) return;
    await this.db.deleteFile(id);
    await safely(() => this.files.remove(record.storageKey));
  }

  // ===========================================================================
  // Availability
  // ===========================================================================

  /** Checks one record against storage. Never throws. */
  async _probe(record) {
    try {
      const file = await this.files.get(record.storageKey);
      if (!file) return { availability: 'missing', message: 'The archived file is missing from storage. You can re-link it.' };
      if (file.size !== record.size) {
        return { availability: 'unreadable', message: 'The stored file no longer matches its record (size changed).' };
      }
      if (file.size > 0) await file.slice(0, 1).arrayBuffer(); // proves the bytes are readable
      return { availability: 'available', blob: new Blob([file], { type: record.mimeType }) };
    } catch (err) {
      return { availability: 'unreadable', message: `The file can’t be read (${err.message || err.name}).` };
    }
  }

  _setAvailability(id, availability) {
    return this.db.updateFile(id, (r) => ({ ...r, availability, lastCheckedAt: this.now() }));
  }

  /** Returns { record, blob } or throws FileUnavailableError (after persisting the new status). */
  async openFile(id) {
    const record = await this.db.getFile(id);
    if (!record) throw new FileUnavailableError('missing', 'This entry no longer exists.');
    const probe = await this._probe(record);
    if (probe.availability !== record.availability) await this._setAvailability(id, probe.availability);
    if (probe.availability !== 'available') throw new FileUnavailableError(probe.availability, probe.message);
    return { record, blob: probe.blob };
  }

  /** Integrity scanner: re-checks every record, updates statuses, never deletes metadata. */
  async checkIntegrity({ onProgress, signal } = {}) {
    const records = await this.db.getAllFiles();
    const summary = { checked: 0, available: 0, missing: 0, unreadable: 0, changed: 0 };
    for (const record of records) {
      if (signal?.aborted) break;
      const probe = await this._probe(record);
      summary[probe.availability]++;
      if (probe.availability !== record.availability) {
        await this._setAvailability(record.id, probe.availability);
        summary.changed++;
      }
      summary.checked++;
      onProgress?.({ done: summary.checked, total: records.length });
      await tick();
    }
    return summary;
  }

  /** Re-attach a replacement file to an existing (missing/unreadable) entry. Keeps name and tags. */
  async relinkFile(id, file, { signal } = {}) {
    const record = await this.db.getFile(id);
    if (!record) throw new ValidationError('That entry no longer exists.');
    const fingerprint = await computeFingerprint(file);
    await this.files.put(record.storageKey, file, { signal });
    const updated = await this.db.updateFile(id, (r) => ({
      ...r,
      size: file.size,
      lastModified: file.lastModified || r.lastModified,
      fingerprint,
      availability: 'available',
      lastCheckedAt: this.now(),
    }));
    return { record: updated, contentChanged: fingerprint !== record.fingerprint };
  }

  // ===========================================================================
  // Tags
  // ===========================================================================

  listTags() { return this.db.getAllTags(); }

  async _cleanTagName(name, exceptId) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new ValidationError('Tag name can’t be empty.');
    if (clean.length > 40) throw new ValidationError('Tag name must be 40 characters or fewer.');
    const clash = (await this.db.getAllTags()).find((t) => t.nameKey === clean.toLowerCase() && t.id !== exceptId);
    if (clash) throw new ValidationError(`A tag named “${clash.name}” already exists.`);
    return clean;
  }

  async createTag(name) {
    const clean = await this._cleanTagName(name);
    const tag = { id: this.uuid(), name: clean, nameKey: clean.toLowerCase(), createdAt: this.now() };
    await this.db.putTag(tag);
    return tag;
  }

  async renameTag(id, name) {
    const existing = (await this.db.getAllTags()).find((t) => t.id === id);
    if (!existing) throw new ValidationError('That tag no longer exists.');
    const clean = await this._cleanTagName(name, id);
    const tag = { ...existing, name: clean, nameKey: clean.toLowerCase() };
    await this.db.putTag(tag);
    return tag;
  }

  /** Deleting a tag removes it from every file (files themselves are untouched). */
  deleteTag(id) { return this.db.deleteTag(id); }

  async assignTag(fileId, tagId) {
    if (!(await this.db.getAllTags()).some((t) => t.id === tagId)) throw new ValidationError('That tag no longer exists.');
    return this.db.updateFile(fileId, (r) => (r.tagIds.includes(tagId) ? r : { ...r, tagIds: [...r.tagIds, tagId] }));
  }

  unassignTag(fileId, tagId) {
    return this.db.updateFile(fileId, (r) => ({ ...r, tagIds: r.tagIds.filter((t) => t !== tagId) }));
  }
}

// In-memory fakes of the two storage ports, with failure injection for edge-case tests.

export class MemoryDB {
  constructor() {
    this.files = new Map();
    this.tags = new Map();
    this.journal = new Map();
    this.failCommit = false;
  }
  async open() { return this; }
  async getAllFiles() { return [...this.files.values()].map((r) => ({ ...r })); }
  async getFile(id) { return this.files.has(id) ? { ...this.files.get(id) } : undefined; }
  async findByFingerprint(fp) { return [...this.files.values()].filter((r) => r.fingerprint === fp); }
  async deleteFile(id) { this.files.delete(id); }
  async updateFile(id, mutate) {
    const cur = this.files.get(id);
    if (!cur) return null;
    const next = mutate({ ...cur });
    this.files.set(id, next);
    return next;
  }
  async addJournal(e) { this.journal.set(e.id, e); }
  async removeJournal(id) { this.journal.delete(id); }
  async getJournal() { return [...this.journal.values()]; }
  async commitImport(record) {
    if (this.failCommit) throw new Error('simulated database failure');
    this.files.set(record.id, record); // record + journal clear are atomic
    this.journal.delete(record.id);
  }
  async getAllTags() { return [...this.tags.values()].map((t) => ({ ...t })); }
  async putTag(t) { this.tags.set(t.id, t); }
  async deleteTag(id) {
    this.tags.delete(id);
    for (const [k, f] of this.files) this.files.set(k, { ...f, tagIds: f.tagIds.filter((t) => t !== id) });
  }
}

export class MemoryFileStore {
  constructor() {
    this.kind = 'memory';
    this.blobs = new Map();
    this.failPutFor = null;       // file name whose copy should fail mid-way
    this.onPutStart = null;       // hook to e.g. abort during a copy
    this.unreadable = new Set();  // ids whose bytes throw on read
  }
  refFor(id) { return `memory://${id}`; }
  async put(id, file, { signal } = {}) {
    await this.onPutStart?.(file);
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    if (this.failPutFor === file.name) throw new Error('simulated copy failure');
    this.blobs.set(id, new Uint8Array(await file.arrayBuffer()));
  }
  async get(id) {
    if (!this.blobs.has(id)) return null;
    if (this.unreadable.has(id)) {
      return { size: this.blobs.get(id).length, slice: () => ({ arrayBuffer: async () => { throw new Error('I/O error'); } }) };
    }
    return new File([this.blobs.get(id)], id);
  }
  async stat(id) { return this.blobs.has(id) ? { size: this.blobs.get(id).length } : null; }
  async remove(id) { this.blobs.delete(id); }
  async list() { return [...this.blobs.keys()]; }
}

export const makeFile = (name, content = name, type = '') => new File([content], name, { type, lastModified: 1_700_000_000_000 });

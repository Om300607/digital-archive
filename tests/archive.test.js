import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveService } from '../www/src/services/archiveService.js';
import { FileUnavailableError, ValidationError } from '../www/src/domain/errors.js';
import { applyFilters } from '../www/src/domain/filters.js';
import { detectCategory, formatBytes } from '../www/src/domain/fileTypes.js';
import { MemoryDB, MemoryFileStore, makeFile } from './helpers/memory.js';

function setup() {
  const db = new MemoryDB();
  const files = new MemoryFileStore();
  let t = 1000;
  const service = new ArchiveService({ db, files, now: () => ++t });
  return { db, files, service };
}

// ---------------------------------------------------------------- import consistency
test('imports several files and stores all required metadata', async () => {
  const { service, db, files } = setup();
  const out = await service.importFiles([makeFile('a.png', 'aaa', 'image/png'), makeFile('b.pdf', 'bbb'), makeFile('c.docx', 'ccc')]);
  assert.equal(out.imported, 3);
  const [rec] = (await db.getAllFiles()).filter((r) => r.name === 'a.png');
  for (const key of ['name', 'ext', 'category', 'size', 'importedAt', 'lastModified', 'tagIds', 'fileRef', 'availability']) {
    assert.ok(key in rec, `missing ${key}`);
  }
  assert.equal(rec.size, 3);
  assert.equal(rec.category, 'image');
  assert.equal(rec.availability, 'available');
  assert.equal(files.blobs.size, 3);
});

test('partial success: a failing copy leaves no record and no stray bytes, other files still import', async () => {
  const { service, db, files } = setup();
  files.failPutFor = 'bad.pdf';
  const out = await service.importFiles([makeFile('ok1.txt'), makeFile('bad.pdf'), makeFile('ok2.txt', 'different')]);
  assert.deepEqual(out.results.map((r) => r.status), ['imported', 'failed', 'imported']);
  assert.equal((await db.getAllFiles()).length, 2);
  assert.equal(files.blobs.size, 2);
  assert.equal((await db.getJournal()).length, 0);
});

test('database failure rolls back the copied bytes', async () => {
  const { service, db, files } = setup();
  db.failCommit = true;
  const out = await service.importFiles([makeFile('x.txt')]);
  assert.equal(out.failed, 1);
  assert.equal((await db.getAllFiles()).length, 0);
  assert.equal(files.blobs.size, 0);
  assert.equal((await db.getJournal()).length, 0);
});

test('cancelling mid-import keeps finished files and discards the rest', async () => {
  const { service, db, files } = setup();
  const ctl = new AbortController();
  files.onPutStart = (file) => { if (file.name === 'two.txt') ctl.abort(); };
  const out = await service.importFiles(
    [makeFile('one.txt'), makeFile('two.txt', '2'), makeFile('three.txt', '3')],
    { signal: ctl.signal },
  );
  assert.deepEqual(out.results.map((r) => r.status), ['imported', 'cancelled', 'cancelled']);
  assert.equal((await db.getAllFiles()).length, 1);
  assert.equal(files.blobs.size, 1);
  assert.equal((await db.getJournal()).length, 0);
});

test('app killed mid-import: next launch removes the orphan bytes and the journal marker', async () => {
  const { service, db, files } = setup();
  // Simulate a crash after the copy but before the DB commit.
  await db.addJournal({ id: 'ghost', name: 'ghost.txt', startedAt: 1 });
  files.blobs.set('ghost', new Uint8Array([1, 2, 3]));
  files.blobs.set('stray', new Uint8Array([9])); // bytes with no record at all
  const { cleaned } = await service.init();
  assert.equal(cleaned, 2);
  assert.equal(files.blobs.size, 0);
  assert.equal((await db.getJournal()).length, 0);
});

test('recovery never touches a fully imported file', async () => {
  const { service, files, db } = setup();
  await service.importFiles([makeFile('keep.txt')]);
  await service.init();
  assert.equal(files.blobs.size, 1);
  assert.equal((await db.getAllFiles()).length, 1);
});

test('duplicate detection finds identical content under a different name', async () => {
  const { service } = setup();
  await service.importFiles([makeFile('original.txt', 'same bytes')]);
  const dupes = await service.detectDuplicates([makeFile('copy.txt', 'same bytes'), makeFile('new.txt', 'other')]);
  assert.deepEqual([...dupes], [0]);
  const out = await service.importFiles([makeFile('copy.txt', 'same bytes')], { duplicatePolicy: 'skip' });
  assert.equal(out.skipped, 1);
  assert.equal((await service.listFiles()).length, 1);
});

// ---------------------------------------------------------------- availability
test('missing file: open fails gracefully, metadata survives, status is persisted', async () => {
  const { service, files, db } = setup();
  await service.importFiles([makeFile('doc.txt')]);
  const [rec] = await service.listFiles();
  await files.remove(rec.storageKey); // deleted externally
  await assert.rejects(() => service.openFile(rec.id), (e) => e instanceof FileUnavailableError && e.status === 'missing');
  const after = await db.getFile(rec.id);
  assert.equal(after.availability, 'missing');
  assert.equal(after.name, 'doc.txt');
});

test('unreadable file is detected without crashing', async () => {
  const { service, files } = setup();
  await service.importFiles([makeFile('locked.txt', 'secret')]);
  const [rec] = await service.listFiles();
  files.unreadable.add(rec.storageKey);
  await assert.rejects(() => service.openFile(rec.id), (e) => e.status === 'unreadable');
});

test('integrity scan flags missing files and re-link restores them', async () => {
  const { service, files } = setup();
  await service.importFiles([makeFile('a.txt', 'a'), makeFile('b.txt', 'b')]);
  const [a] = (await service.listFiles()).filter((r) => r.name === 'a.txt');
  await files.remove(a.storageKey);
  const summary = await service.checkIntegrity();
  assert.equal(summary.missing, 1);
  assert.equal(summary.available, 1);
  assert.equal((await service.listFiles()).length, 2); // nothing deleted

  const { record, contentChanged } = await service.relinkFile(a.id, makeFile('a-moved.txt', 'a'));
  assert.equal(record.availability, 'available');
  assert.equal(record.name, 'a.txt'); // entry keeps its identity
  assert.equal(contentChanged, false);
  const reopened = await service.openFile(a.id);
  assert.equal(await reopened.blob.text(), 'a');
});

// ---------------------------------------------------------------- organisation
test('tags: unique names, assign/unassign, delete cascades to files', async () => {
  const { service } = setup();
  await service.importFiles([makeFile('x.txt')]);
  const [file] = await service.listFiles();
  const tag = await service.createTag('  Work  ');
  assert.equal(tag.name, 'Work');
  await assert.rejects(() => service.createTag('work'), ValidationError);
  await assert.rejects(() => service.createTag('   '), ValidationError);

  await service.assignTag(file.id, tag.id);
  assert.deepEqual((await service.getFile(file.id)).tagIds, [tag.id]);
  await service.assignTag(file.id, tag.id); // idempotent
  assert.equal((await service.getFile(file.id)).tagIds.length, 1);

  await service.deleteTag(tag.id);
  assert.deepEqual((await service.getFile(file.id)).tagIds, []);
  assert.equal((await service.listTags()).length, 0);
});

test('rename changes only the display name; remove deletes record and archive copy', async () => {
  const { service, files } = setup();
  await service.importFiles([makeFile('old.txt')]);
  const [rec] = await service.listFiles();
  const renamed = await service.renameEntry(rec.id, ' new name.txt ');
  assert.equal(renamed.name, 'new name.txt');
  assert.equal(renamed.storageKey, rec.storageKey);
  await assert.rejects(() => service.renameEntry(rec.id, '  '), ValidationError);

  await service.removeEntry(rec.id);
  assert.equal((await service.listFiles()).length, 0);
  assert.equal(files.blobs.size, 0);
});

// ---------------------------------------------------------------- search & filter
test('search matches file names and tags; filters combine', async () => {
  const { service } = setup();
  await service.importFiles([
    makeFile('Invoice March.pdf', 'p1'), makeFile('holiday.png', 'p2', 'image/png'), makeFile('notes.txt', 'p3'),
  ]);
  const tag = await service.createTag('Finance');
  const invoice = (await service.listFiles()).find((r) => r.name.startsWith('Invoice'));
  await service.assignTag(invoice.id, tag.id);
  await service.db.updateFile((await service.listFiles()).find((r) => r.name === 'notes.txt').id, (r) => ({ ...r, availability: 'missing' }));

  const records = await service.listFiles();
  const tags = await service.listTags();
  const names = (o) => applyFilters(records, tags, o).map((r) => r.name);

  assert.deepEqual(names({ query: 'holi' }), ['holiday.png']);
  assert.deepEqual(names({ query: 'finance' }), ['Invoice March.pdf']);       // by tag
  assert.deepEqual(names({ query: 'invoice finance' }), ['Invoice March.pdf']); // name + tag
  assert.deepEqual(names({ category: 'image' }), ['holiday.png']);
  assert.deepEqual(names({ availability: 'missing' }), ['notes.txt']);
  assert.deepEqual(names({ tagIds: [tag.id] }), ['Invoice March.pdf']);
  assert.deepEqual(names({ query: 'zzz' }), []);
  assert.deepEqual(names({ sort: 'name' }), ['holiday.png', 'Invoice March.pdf', 'notes.txt']);
});

test('helpers', () => {
  assert.equal(detectCategory('x.PDF'), 'pdf');
  assert.equal(detectCategory('x.heic'), 'image');
  assert.equal(detectCategory('x.docx'), 'document');
  assert.equal(detectCategory('x.zip'), 'other');
  assert.equal(formatBytes(1536), '1.5 KB');
});

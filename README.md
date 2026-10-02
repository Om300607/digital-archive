# Digital Archive

A mobile-first app for importing files into a personal archive, organising them with tags, and searching
them offline. It is a dependency-free web app (vanilla ES modules) that runs as an installable PWA and is
packaged as an Android APK with Capacitor.

- **Live demo:** _add your Vercel URL here_
- **APK:** built by GitHub Actions on every push (Actions → latest run → `digital-archive-debug-apk`)

## Requirements checklist

| Requirement | Where |
|---|---|
| Import files, ≥3 types, multi-select | `www/src/ui/main.js` (`runImport`), `ArchiveService.importFiles` |
| Metadata: name, type, size, import date, last modified, tags, file reference, availability | record shape in `ArchiveService._importOne` |
| Create/delete/rename tags, assign/remove, rename entry, remove entry | `ArchiveService` tag + entry methods, `views.js`, `detail.js` |
| Search by name and tags, plus type / availability / tag / sort filters | `www/src/domain/filters.js` |
| Missing, moved, inaccessible, unopenable files | `ArchiveService._probe`, `openFile`, `checkIntegrity`, `relinkFile` |
| Persistence across restarts, no rebuild on launch | IndexedDB (`storage/db.js`) + OPFS (`storage/fileStore.js`) |
| Import consistency | journal + atomic commit, see below |
| Async operations | streamed chunked copy, awaited I/O, yielding between files |
| Optional: duplicate detection, integrity scanner, automated tests | `fingerprint.js`, Health tab, `tests/` |

## Architecture

```
┌────────────── UI (www/src/ui) ──────────────┐   rendering and input only
│ main.js  views.js  detail.js  dom.js        │   no storage calls except via the service
└───────────────────┬─────────────────────────┘
                    │ calls
┌───────────────────▼─────────────────────────┐
│ Application logic: services/archiveService  │   import, tags, availability, integrity
│ Domain (www/src/domain): filters, fileTypes,│   pure functions, no browser APIs
│ fingerprint, errors                         │
└───────────┬───────────────────────┬─────────┘
            │ db port               │ files port
┌───────────▼─────────┐   ┌─────────▼───────────────────┐
│ ArchiveDB           │   │ OpfsFileStore (preferred)   │
│ IndexedDB metadata  │   │ IdbFileStore  (fallback)    │
└─────────────────────┘   └─────────────────────────────┘
```

`main.js` is the only place that constructs concrete storage classes and injects them into
`ArchiveService`. The tests inject in-memory fakes with failure switches into the same service, so the real
import/recovery code is what gets tested.

## Storage strategy

- **Metadata** lives in IndexedDB (`files`, `tags`, `journal` stores). Search and filtering read from these
  persisted records, never from the device file system.
- **Bytes** are *copied* into app-private storage (Origin Private File System, with an IndexedDB blob
  fallback for browsers without OPFS writable streams). Each copy is keyed by the record's id.
- **File reference** (`fileRef`, e.g. `opfs://archive-files/<id>`) plus `storageKey` ties a record to its bytes.
  Because the key is the id and not the name, **renaming an entry can never break the link**.
- On startup the app reads the existing records. It does **not** rescan the device or rebuild the archive.
  It asks the browser for persistent storage (`navigator.storage.persist()`) to reduce eviction risk.

### What "remove" means

Removing an entry deletes the archive record **and the app's private copy**. The original file on the
device is never touched, because the app never modifies originals. The confirmation dialog says this.
The record is deleted first; if deleting the copy then fails, the leftover is swept on the next launch.

## Import consistency

Each file is imported as an independent two-phase unit:

1. **Fingerprint** the source (read-only). An unreadable source fails here, before anything is written.
2. **Journal**: write an "import in progress" marker for the new id.
3. **Copy** the bytes in chunks (cancellable). OPFS writes go to a swap file and only become visible on
   `close()`. The stored size is verified against the source.
4. **Commit**: insert the record and delete the journal marker in **one IndexedDB transaction**.

If anything fails after step 2, the copy and marker are deleted. The database therefore never holds a record
for a file that was not completely and verifiably copied.

| Situation | Result |
|---|---|
| User cancels during import | Current file's partial copy is removed; already-finished files stay; remaining files are reported as cancelled |
| File-copy failure (source vanished, quota, I/O error) | That file is reported as failed, nothing is stored for it, other files continue |
| Database failure on commit | The copied bytes are deleted, no record exists |
| App killed mid-import | A journal marker survives. On next launch `recoverInterruptedImports()` deletes its half-written bytes and the marker. It also sweeps stored files that have no record |
| Multi-file partial success | Per-file results; a summary lists exactly which files failed and why |

## Availability handling

Every record has `availability`: `available`, `missing` or `unreadable`, plus `lastCheckedAt`.

- **Opening** a file first probes it (exists, size matches, first byte readable). On failure the status is
  persisted, a message is shown, and the app carries on. It never crashes and the metadata is kept.
- **Integrity scanner** (Health tab) re-checks every record, with progress, and also runs quietly shortly after launch.
  It only updates status. It never deletes records.
- **Re-link** lets the user pick a replacement file for a missing/unreadable entry. The entry keeps its name, tags
  and import date, and the user is told if the new content differs from the original.
- A red badge on the Health tab counts entries that need attention.

## Async behaviour

All storage calls are asynchronous. Copying streams the file in chunks with progress, reading checks
the abort signal between chunks, and the importer yields to the event loop between files. Duplicate
fingerprints hash only length + first and last 1 MiB, so large files don't stall the UI.

## Duplicate detection

The fingerprint is SHA-256 of `size + first 1 MiB + last 1 MiB`. Before importing, the user is asked whether to
import or skip files that match existing entries. It is a strong heuristic, not a guarantee of identical content.

## Run, test, deploy

```bash
npm test                 # 14 unit tests (Node 20+), no install needed
npx serve www            # run locally at http://localhost:3000
```

**GitHub**

```bash
git init && git add . && git commit -m "Digital Archive"
git branch -M main
git remote add origin https://github.com/<you>/digital-archive.git
git push -u origin main
```

**Vercel**: import the GitHub repo at vercel.com/new. `vercel.json` already sets the framework to none and
the output directory to `www`, so no build settings are needed. (Or run `npx vercel --prod` from this folder.)
The site is served over HTTPS, which the PWA, OPFS and SubtleCrypto all need.

**Android APK**: push to GitHub and open *Actions → Build Android APK → latest run → Artifacts*. To build locally
you need Node 20, JDK 17 and the Android SDK:

```bash
npm install
npx cap add android      # once
npm run apk              # output: android/app/build/outputs/apk/debug/app-debug.apk
```

## Known limitations

- Files are copied, so the archive uses storage equal to its contents. That is the trade-off that lets entries survive
  the original being moved or deleted.
- OPFS/IndexedDB storage is per-app (or per-browser-profile on the web). Clearing app data deletes the archive.
- The recovery sweep assumes one running instance. Two tabs importing at the exact moment a third launches could
  have an in-flight import cleaned up (the import would then report failure, not corrupt data).
- In-app PDF preview depends on the WebView. Where it is blank, "Share or save a copy" opens the file in another app.
- The Android build is a debug APK (debug-signed). A release build needs your own keystore.

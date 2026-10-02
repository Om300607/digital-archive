// Composition root: wires storage -> service -> UI. Only this file knows about concrete classes.

import { ArchiveDB } from '../storage/db.js';
import { createFileStore } from '../storage/fileStore.js';
import { ArchiveService } from '../services/archiveService.js';
import { ACCEPT, formatBytes } from '../domain/fileTypes.js';
import { h, toast, openSheet, askConfirm } from './dom.js';
import { renderArchive, renderTags, renderHealth } from './views.js';

const TITLES = { archive: 'Archive', tags: 'Tags', health: 'Archive health' };
const fileStore = createFileStore();
const service = new ArchiveService({ db: new ArchiveDB(), files: fileStore });

const state = {
  files: [],
  tags: [],
  tab: 'archive',
  showFilters: false,
  storageKind: fileStore.kind,
  filters: { query: '', category: 'all', availability: 'all', tagIds: [], sort: 'newest' },
};

const reloadListeners = new Set();
const ctx = {
  service,
  state,
  toast,
  render,
  onReload(fn) { reloadListeners.add(fn); return () => reloadListeners.delete(fn); },
  async reload() {
    [state.files, state.tags] = await Promise.all([service.listFiles(), service.listTags()]);
    render();
    reloadListeners.forEach((fn) => fn());
  },
};

function render() {
  const bad = state.files.filter((f) => f.availability !== 'available').length;
  const badge = document.getElementById('health-badge');
  badge.hidden = bad === 0;
  badge.textContent = bad;

  document.getElementById('title').textContent = TITLES[state.tab];
  document.getElementById('fab').hidden = state.tab !== 'archive';
  for (const btn of document.querySelectorAll('.tabbar button')) {
    if (btn.dataset.tab === state.tab) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const name of Object.keys(TITLES)) {
    document.getElementById(`view-${name}`).classList.toggle('active', name === state.tab);
  }
  if (state.tab === 'archive') renderArchive(ctx);
  else if (state.tab === 'tags') renderTags(ctx);
  else renderHealth(ctx);
}

// ---------------------------------------------------------------------------
// Import flow
// ---------------------------------------------------------------------------
let importing = false;

async function runImport(fileList) {
  const files = [...fileList];
  if (!files.length || importing) return;
  importing = true;
  try {
    let duplicatePolicy = 'import';
    const dupes = await service.detectDuplicates(files);
    if (dupes.size) {
      const importAnyway = await askConfirm({
        title: 'Possible duplicates',
        message: `${dupes.size} of ${files.length} selected ${files.length === 1 ? 'file looks' : 'files look'} identical to something already archived. Import anyway?`,
        confirmText: 'Import anyway',
        cancelText: 'Skip duplicates',
      });
      duplicatePolicy = importAnyway ? 'import' : 'skip';
    }

    const ac = new AbortController();
    const label = h('p', {}, 'Starting…');
    const bar = h('progress', { max: 1, value: 0, 'aria-label': 'Import progress' });
    const cancel = h('button', { class: 'btn danger', onClick: () => { ac.abort(); cancel.disabled = true; label.textContent = 'Cancelling…'; } }, 'Cancel import');
    const sheet = openSheet('Importing', () => h('div', {}, label, bar, h('div', { class: 'btn-row' }, cancel)), { dismissable: false });

    const outcome = await service.importFiles(files, {
      signal: ac.signal,
      duplicatePolicy,
      onProgress: (e) => {
        if (ac.signal.aborted) return;
        if (e.type === 'file-start') {
          label.textContent = `File ${e.index + 1} of ${e.total}: ${e.name} (${formatBytes(e.size)})`;
          bar.value = e.index / e.total;
        } else if (e.type === 'bytes' && e.size > 0) {
          bar.value = (e.index + e.written / e.size) / e.total;
        }
      },
    });
    sheet.close();
    await ctx.reload();
    showImportSummary(outcome);
  } catch (err) {
    toast(`Import failed: ${err.message}`, { error: true });
  } finally {
    importing = false;
  }
}

function showImportSummary(o) {
  const failures = o.results.filter((r) => r.status === 'failed');
  if (!failures.length && !o.cancelled && !o.skipped) {
    toast(`Imported ${o.imported} ${o.imported === 1 ? 'file' : 'files'}.`);
    return;
  }
  const lines = [`Imported ${o.imported}.`];
  if (o.skipped) lines.push(`Skipped ${o.skipped} duplicate${o.skipped === 1 ? '' : 's'}.`);
  if (o.cancelled) lines.push(`Cancelled ${o.cancelled}; nothing was saved for those.`);
  const sheet = openSheet('Import finished', () => h('div', {},
    h('p', {}, lines.join(' ')),
    failures.length ? h('div', { class: 'notice' }, h('strong', {}, `${failures.length} failed and were not added:`),
      h('ul', {}, failures.map((f) => h('li', {}, `${f.name}: ${f.error}`)))) : null,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: () => sheet.close() }, 'Done')),
  ));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function wireUi() {
  const input = document.getElementById('file-input');
  input.accept = ACCEPT; // images, PDFs and common document types
  // Some Android pickers hide non-matching files; "other" types remain importable via the unfiltered picker.
  document.getElementById('fab').addEventListener('click', () => { input.value = ''; input.click(); });
  input.addEventListener('change', () => runImport(input.files));

  let timer;
  document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.filters.query = e.target.value; render(); }, 120);
  });
  document.getElementById('btn-filter').addEventListener('click', () => { state.showFilters = !state.showFilters; render(); });
  for (const btn of document.querySelectorAll('.tabbar button')) {
    btn.addEventListener('click', () => { state.tab = btn.dataset.tab; render(); document.querySelector('main').scrollTop = 0; });
  }
}

async function boot() {
  wireUi();
  try {
    navigator.storage?.persist?.(); // ask the browser not to evict our data under storage pressure
    const { cleaned } = await service.init();
    if (cleaned) toast(`Recovered from an interrupted import (${cleaned} leftover ${cleaned === 1 ? 'item' : 'items'} cleaned up).`);
    await ctx.reload();
    // Background integrity check: validates existing records, does not rebuild anything.
    setTimeout(() => service.checkIntegrity().then((s) => { if (s.changed) ctx.reload(); }).catch(() => {}), 800);
  } catch (err) {
    document.getElementById('empty').hidden = false;
    document.getElementById('empty').replaceChildren(
      h('h2', {}, 'Storage isn’t available'),
      h('p', {}, `The archive can’t start: ${err.message}. Private browsing modes often block local storage. Open the app in a normal window.`),
    );
    return;
  }

  if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.() && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();

// Archive list, filters, tag manager and health screen. Each render function rebuilds
// only its own region from `ctx.state`, which mirrors what is persisted in the database.

import { h, askConfirm, askText, formatDay } from './dom.js';
import { applyFilters } from '../domain/filters.js';
import { CATEGORY_LABELS, formatBytes } from '../domain/fileTypes.js';
import { openDetail } from './detail.js';

const AVAILABILITY_LABELS = { available: 'Available', missing: 'Missing', unreadable: 'Unreadable' };
const SORT_LABELS = { newest: 'Newest imported', oldest: 'Oldest imported', name: 'Name (A–Z)', size: 'Largest first' };

// ----------------------------------------------------------------------------
// Archive
// ----------------------------------------------------------------------------
export function renderArchive(ctx) {
  renderFilters(ctx);
  const { state } = ctx;
  const tagsById = new Map(state.tags.map((t) => [t.id, t]));
  const visible = applyFilters(state.files, state.tags, state.filters);

  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const summary = document.getElementById('summary');
  list.replaceChildren();

  const filtering = isFiltering(state.filters);
  summary.textContent = state.files.length
    ? `Showing ${visible.length} of ${state.files.length} ${state.files.length === 1 ? 'file' : 'files'}`
    : '';

  if (!visible.length) {
    empty.hidden = false;
    empty.replaceChildren(
      state.files.length === 0
        ? h('div', {}, h('h2', {}, 'Your archive is empty'), h('p', {}, 'Tap + to import images, PDFs and documents. Each file is copied into the app so it stays available.'))
        : h('div', {}, h('h2', {}, 'No matches'), h('p', {}, 'Try a different search or clear the filters.'),
          filtering ? h('button', { class: 'btn', onClick: () => { resetFilters(ctx); } }, 'Clear search and filters') : null),
    );
    return;
  }
  empty.hidden = true;

  for (const r of visible) {
    const unavailable = r.availability !== 'available';
    list.append(h('li', {},
      h('button', {
        class: `card${unavailable ? ' is-unavailable' : ''}`, 'data-category': r.category,
        'aria-label': `${r.name}, ${CATEGORY_LABELS[r.category]}${unavailable ? ', ' + r.availability : ''}`,
        onClick: () => openDetail(ctx, r.id),
      },
      h('span', { class: 'spine' }),
      h('span', { class: 'body' },
        h('span', { class: 'row' },
          h('span', { class: 'name' }, r.name),
          unavailable ? h('span', { class: `status ${r.availability}` }, AVAILABILITY_LABELS[r.availability]) : null,
          h('span', { class: 'stamp' }, r.ext || 'file'),
        ),
        h('span', { class: 'meta' }, `${formatBytes(r.size)}, imported ${formatDay(r.importedAt)}`),
        r.tagIds.length
          ? h('span', { class: 'tags' }, r.tagIds.map((id) => tagsById.get(id)).filter(Boolean).map((t) => h('span', { class: 'tag' }, t.name)))
          : null,
      )),
    ));
  }
}

function isFiltering(f) {
  return Boolean(f.query.trim()) || f.category !== 'all' || f.availability !== 'all' || f.tagIds.length > 0;
}

function resetFilters(ctx) {
  Object.assign(ctx.state.filters, { query: '', category: 'all', availability: 'all', tagIds: [] });
  document.getElementById('search').value = '';
  ctx.render();
}

function chipGroup(options, isOn, onPick) {
  return h('div', { class: 'chips' }, options.map(([value, label]) =>
    h('button', { class: 'chip', 'aria-pressed': String(isOn(value)), onClick: () => onPick(value) }, label)));
}

function renderFilters(ctx) {
  const { state } = ctx;
  const panel = document.getElementById('filters');
  const toggle = document.getElementById('btn-filter');
  panel.hidden = !state.showFilters;
  toggle.setAttribute('aria-pressed', String(state.showFilters));
  const active = state.filters.category !== 'all' || state.filters.availability !== 'all' || state.filters.tagIds.length;
  toggle.textContent = active ? 'Filters •' : 'Filters';
  if (!state.showFilters) return;

  const f = state.filters;
  const set = (patch) => { Object.assign(f, patch); ctx.render(); };

  panel.replaceChildren(
    h('div', {}, h('h3', {}, 'File type'),
      chipGroup([['all', 'All'], ...Object.entries(CATEGORY_LABELS)], (v) => f.category === v, (v) => set({ category: v }))),
    h('div', {}, h('h3', {}, 'Availability'),
      chipGroup([['all', 'All'], ...Object.entries(AVAILABILITY_LABELS)], (v) => f.availability === v, (v) => set({ availability: v }))),
    state.tags.length
      ? h('div', {}, h('h3', {}, 'Tags (file must have all selected)'),
        chipGroup(state.tags.map((t) => [t.id, t.name]), (v) => f.tagIds.includes(v),
          (v) => set({ tagIds: f.tagIds.includes(v) ? f.tagIds.filter((x) => x !== v) : [...f.tagIds, v] })))
      : null,
    h('div', {}, h('h3', {}, 'Sort'),
      h('select', { 'aria-label': 'Sort order', onChange: (e) => set({ sort: e.target.value }) },
        Object.entries(SORT_LABELS).map(([v, label]) => h('option', { value: v, selected: f.sort === v }, label)))),
    isFiltering(f) ? h('button', { class: 'link-btn', onClick: () => resetFilters(ctx) }, 'Clear search and filters') : null,
  );
}

// ----------------------------------------------------------------------------
// Tags
// ----------------------------------------------------------------------------
export function renderTags(ctx) {
  const { service, state } = ctx;
  const root = document.getElementById('view-tags');
  const counts = new Map();
  for (const f of state.files) for (const id of f.tagIds) counts.set(id, (counts.get(id) || 0) + 1);

  const input = h('input', { type: 'text', placeholder: 'New tag, e.g. Receipts', maxLength: 40, 'aria-label': 'New tag name' });
  const create = async () => {
    try {
      await service.createTag(input.value);
      input.value = '';
      await ctx.reload();
    } catch (err) { ctx.toast(err.message, { error: true }); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

  root.replaceChildren(
    h('div', { class: 'panel' },
      h('h2', {}, 'Create a tag'),
      h('div', { class: 'inline-form' }, input, h('button', { class: 'btn primary', onClick: create }, 'Add')),
      h('p', {}, 'Tags group files. Open a file to assign them.'),
    ),
    h('div', { class: 'panel' },
      h('h2', {}, `Tags (${state.tags.length})`),
      state.tags.length === 0 ? h('p', {}, 'No tags yet.') : null,
      [...state.tags].sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
        const n = counts.get(t.id) || 0;
        return h('div', { class: 'tag-row' },
          h('div', { class: 'grow' }, h('strong', {}, t.name), ' ', h('span', { class: 'count' }, `${n} ${n === 1 ? 'file' : 'files'}`)),
          h('button', { class: 'btn', onClick: async () => {
            const name = await askText({ title: 'Rename tag', label: 'Tag name', value: t.name, maxLength: 40 });
            if (name === null) return;
            try { await service.renameTag(t.id, name); await ctx.reload(); } catch (err) { ctx.toast(err.message, { error: true }); }
          } }, 'Rename'),
          h('button', { class: 'btn danger', onClick: async () => {
            const ok = await askConfirm({
              title: `Delete “${t.name}”?`,
              message: n ? `It will be removed from ${n} ${n === 1 ? 'file' : 'files'}. The files themselves are not deleted.` : 'No files use this tag.',
              confirmText: 'Delete tag', danger: true,
            });
            if (!ok) return;
            state.filters.tagIds = state.filters.tagIds.filter((id) => id !== t.id);
            await service.deleteTag(t.id);
            await ctx.reload();
          } }, 'Delete'),
        );
      }),
    ),
  );
}

// ----------------------------------------------------------------------------
// Health / integrity
// ----------------------------------------------------------------------------
export function renderHealth(ctx) {
  const { service, state } = ctx;
  const root = document.getElementById('view-health');
  const count = (s) => state.files.filter((f) => f.availability === s).length;
  const progress = h('progress', { max: 1, value: 0, hidden: true, 'aria-label': 'Scan progress' });
  const result = h('p', { 'aria-live': 'polite' }, state.lastScan || '');
  const usage = h('p', {}, '');

  const scan = h('button', { class: 'btn primary' }, 'Scan archive now');
  scan.addEventListener('click', async () => {
    scan.disabled = true;
    progress.hidden = false;
    try {
      const s = await service.checkIntegrity({ onProgress: ({ done, total }) => { progress.value = total ? done / total : 1; } });
      // Stored in state because reload() re-renders this screen.
      state.lastScan = s.checked === 0
        ? 'Nothing to scan yet.'
        : `Checked ${s.checked}: ${s.available} available, ${s.missing} missing, ${s.unreadable} unreadable.`;
      await ctx.reload();
    } catch (err) {
      ctx.toast(`Scan failed: ${err.message}`, { error: true });
    } finally {
      scan.disabled = false;
      progress.hidden = true;
    }
  });

  navigator.storage?.estimate?.().then((e) => {
    if (e?.usage != null) usage.textContent = `The app is using ${formatBytes(e.usage)} of ${formatBytes(e.quota)} available.`;
  }).catch(() => {});

  root.replaceChildren(
    h('div', { class: 'panel' },
      h('h2', {}, 'Archive health'),
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('b', {}, count('available')), h('span', {}, 'Available')),
        h('div', { class: 'stat' }, h('b', {}, count('missing')), h('span', {}, 'Missing')),
        h('div', { class: 'stat' }, h('b', {}, count('unreadable')), h('span', {}, 'Unreadable')),
      ),
      h('p', {}, 'The scan checks that every archived file is still stored and readable. It never deletes records, so missing files keep their name, tags and dates.'),
      h('div', { class: 'btn-row' }, scan), progress, result,
    ),
    h('div', { class: 'panel' },
      h('h2', {}, 'How storage works'),
      h('p', {}, `Importing copies each file into private app storage (${state.storageKind === 'opfs' ? 'origin private file system' : 'IndexedDB'}). The originals on your device are never changed or deleted.`),
      h('p', {}, 'Removing an entry deletes the archive record and the app’s copy. Your original file stays where it is.'),
      usage,
    ),
  );
}

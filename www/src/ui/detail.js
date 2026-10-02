// File detail sheet and in-app viewer.

import { h, openSheet, askConfirm, askText, formatDate } from './dom.js';
import { CATEGORY_LABELS, formatBytes, previewKind } from '../domain/fileTypes.js';
import { FileUnavailableError, isAbort } from '../domain/errors.js';
import { saveOrShare } from './native.js';

export function openDetail(ctx, id) {
  const { service, state } = ctx;
  const current = () => state.files.find((f) => f.id === id);
  let sheet;

  // Keep the sheet in sync whenever the archive reloads (e.g. status changed by a failed open).
  const unsubscribe = ctx.onReload(() => {
    if (!current()) sheet.close();
    else sheet.update(current().name);
  });

  const guard = (fn) => async () => {
    try { await fn(); } catch (err) {
      if (!isAbort(err)) ctx.toast(err.message || String(err), { error: true });
    }
  };

  const render = () => {
    const r = current();
    if (!r) return h('div');
    const unavailable = r.availability !== 'available';

    return h('div', {},
      unavailable
        ? h('div', { class: `notice${r.availability === 'unreadable' ? ' warn' : ''}` },
          r.availability === 'missing'
            ? 'The archived copy of this file is missing. The entry, tags and dates are kept. Re-link a replacement to restore it.'
            : 'The archived copy can’t be read right now. The entry, tags and dates are kept.')
        : null,

      h('dl', { class: 'facts' },
        h('dt', {}, 'Type'), h('dd', {}, `${CATEGORY_LABELS[r.category]}${r.ext ? ` (.${r.ext})` : ''}`),
        h('dt', {}, 'Size'), h('dd', {}, formatBytes(r.size)),
        h('dt', {}, 'Imported'), h('dd', {}, formatDate(r.importedAt)),
        h('dt', {}, 'Last modified'), h('dd', {}, formatDate(r.lastModified)),
        h('dt', {}, 'Status'), h('dd', {}, `${r.availability[0].toUpperCase()}${r.availability.slice(1)} (checked ${formatDate(r.lastCheckedAt)})`),
        h('dt', {}, 'Location'), h('dd', {}, r.fileRef),
        h('dt', {}, 'Original name'), h('dd', {}, r.originalName),
      ),

      h('div', { class: 'field' }, h('label', {}, 'Tags'),
        state.tags.length
          ? h('div', { class: 'chips' }, state.tags.map((t) => {
            const on = r.tagIds.includes(t.id);
            return h('button', {
              class: 'chip', 'aria-pressed': String(on),
              onClick: guard(async () => {
                await (on ? service.unassignTag(r.id, t.id) : service.assignTag(r.id, t.id));
                await ctx.reload();
              }),
            }, t.name);
          }))
          : h('p', { class: 'meta' }, 'No tags yet. Create one below.'),
        h('button', { class: 'link-btn', onClick: guard(async () => {
          const name = await askText({ title: 'New tag', label: 'Tag name', maxLength: 40, confirmText: 'Create and assign' });
          if (name === null) return;
          const tag = await service.createTag(name);
          await service.assignTag(r.id, tag.id);
          await ctx.reload();
        }) }, '+ New tag'),
      ),

      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', disabled: unavailable, onClick: guard(() => openViewer(ctx, r.id)) }, 'Open'),
        h('button', { class: 'btn', disabled: unavailable, onClick: guard(async () => {
          const { blob, record } = await service.openFile(r.id).catch((e) => { handleUnavailable(ctx, e); throw e; });
          await saveOrShare(blob, record.name);
        }) }, 'Share or save a copy'),
        h('button', { class: 'btn', onClick: guard(async () => {
          const name = await askText({ title: 'Rename entry', label: 'Name in the archive', value: r.name });
          if (name === null) return;
          await service.renameEntry(r.id, name);
          await ctx.reload();
        }) }, 'Rename'),
        unavailable
          ? h('button', { class: 'btn', onClick: guard(() => relink(ctx, r)) }, 'Re-link file…')
          : h('button', { class: 'btn', onClick: guard(async () => {
            try { await service.openFile(r.id); ctx.toast('File is available.'); } catch (e) { handleUnavailable(ctx, e); }
            await ctx.reload();
          }) }, 'Check file'),
        h('button', { class: 'btn danger', onClick: guard(async () => {
          const ok = await askConfirm({
            title: 'Remove from archive?',
            message: `“${r.name}” will be removed from the archive and the copy stored inside this app will be deleted. The original file on your device is not affected.`,
            confirmText: 'Remove', danger: true,
          });
          if (!ok) return;
          await service.removeEntry(r.id);
          sheet.close();
          await ctx.reload();
          ctx.toast('Removed from archive.');
        }) }, 'Remove'),
      ),
    );
  };

  sheet = openSheet(current()?.name ?? 'File', render, { onClose: unsubscribe });
  return sheet;
}

function handleUnavailable(ctx, err) {
  if (err instanceof FileUnavailableError) {
    ctx.toast(err.message, { error: true });
    return true;
  }
  return false;
}

async function relink(ctx, record) {
  const input = h('input', { type: 'file' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { contentChanged } = await ctx.service.relinkFile(record.id, file);
      ctx.toast(contentChanged ? 'Re-linked. Note: the new file’s content differs from the original.' : 'File restored.');
    } catch (err) {
      ctx.toast(`Couldn’t re-link: ${err.message}`, { error: true });
    }
    await ctx.reload();
  });
  input.click();
}

export async function openViewer(ctx, id) {
  let opened;
  try {
    opened = await ctx.service.openFile(id);
  } catch (err) {
    await ctx.reload(); // status was persisted by the service; refresh the UI
    if (!handleUnavailable(ctx, err)) ctx.toast(`Couldn’t open the file: ${err.message}`, { error: true });
    return;
  }

  const { record, blob } = opened;
  const kind = previewKind(record);
  let url = null;
  const viewer = h('div', { class: 'viewer' });

  try {
    if (kind === 'image') {
      url = URL.createObjectURL(blob);
      viewer.append(h('img', { src: url, alt: record.name, onerror: () => viewer.replaceChildren(h('p', { class: 'meta' }, 'This image can’t be previewed. Use “Share or save a copy”.')) }));
    } else if (kind === 'pdf') {
      url = URL.createObjectURL(blob);
      viewer.append(h('iframe', { src: url, title: record.name }));
    } else if (kind === 'text') {
      viewer.append(h('pre', {}, await blob.slice(0, 200_000).text() + (blob.size > 200_000 ? '\n\n… (preview truncated)' : '')));
    } else {
      viewer.append(h('p', { class: 'meta', style: 'padding:16px;text-align:center' }, 'No in-app preview for this file type. Use “Share or save a copy” to open it in another app.'));
    }
  } catch (err) {
    viewer.replaceChildren(h('p', { class: 'meta' }, `Preview failed: ${err.message}`));
  }

  const sheet = openSheet(record.name, () => h('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;gap:10px' },
    viewer,
    kind === 'pdf' ? h('p', { class: 'meta' }, 'If the preview is blank on your device, share or save a copy to open it in a PDF app.') : null,
    h('div', { class: 'btn-row', style: 'margin-top:0' },
      h('button', { class: 'btn', onClick: () => saveOrShare(blob, record.name).catch((e) => ctx.toast(e.message, { error: true })) }, 'Share or save a copy'),
      h('button', { class: 'btn', onClick: () => sheet.close() }, 'Close'),
    ),
  ), { full: true, onClose: () => { if (url) URL.revokeObjectURL(url); } });
}

// File type detection and formatting helpers. Pure functions, no browser APIs.

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'avif']);
const DOC_EXT = new Set([
  'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'epub',
]);
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'json']);

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
};

/** Value for the <input type="file" accept> attribute. Anything else can still be imported as "other". */
export const ACCEPT = 'image/*,.pdf,.doc,.docx,.txt,.md,.rtf,.odt,.xls,.xlsx,.ppt,.pptx,.csv,.json';

export const CATEGORY_LABELS = { image: 'Images', pdf: 'PDFs', document: 'Documents', other: 'Other' };

export function extensionOf(name = '') {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

export function guessMime(name) {
  return MIME_BY_EXT[extensionOf(name)] || '';
}

export function detectCategory(name, mime = '') {
  const ext = extensionOf(name);
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    DOC_EXT.has(ext) || mime.startsWith('text/') || mime.includes('word') ||
    mime.includes('officedocument') || mime.includes('opendocument')
  ) return 'document';
  return 'other';
}

/** How the in-app viewer can show a record: 'image' | 'pdf' | 'text' | 'none'. */
export function previewKind(record) {
  if (record.category === 'image' && record.ext !== 'heic' && record.ext !== 'heif') return 'image';
  if (record.category === 'pdf') return 'pdf';
  if (TEXT_EXT.has(record.ext) || (record.mimeType || '').startsWith('text/')) return 'text';
  return 'none';
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

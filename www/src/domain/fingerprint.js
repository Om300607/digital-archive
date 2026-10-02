// Cheap content fingerprint for duplicate detection.
// SHA-256 over: byte length + first 1 MiB + last 1 MiB. Two files with the same
// fingerprint are "very likely identical"; it avoids reading multi-GB files fully.

const CHUNK = 1024 * 1024;

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export async function computeFingerprint(file) {
  const head = new Uint8Array(await file.slice(0, CHUNK).arrayBuffer());
  const tail = file.size > CHUNK
    ? new Uint8Array(await file.slice(Math.max(CHUNK, file.size - CHUNK)).arrayBuffer())
    : new Uint8Array(0);
  const prefix = new TextEncoder().encode(`${file.size}:`);
  const all = new Uint8Array(prefix.length + head.length + tail.length);
  all.set(prefix, 0);
  all.set(head, prefix.length);
  all.set(tail, prefix.length + head.length);

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', all);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `fnv-${fnv1a(all)}`; // non-secure contexts have no SubtleCrypto
}

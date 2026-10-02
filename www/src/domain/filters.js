// Search + filter + sort over archive records. Pure: operates on the records
// loaded from the persistent database, never on the device file system.

const SORTERS = {
  newest: (a, b) => b.importedAt - a.importedAt,
  oldest: (a, b) => a.importedAt - b.importedAt,
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  size: (a, b) => b.size - a.size,
};

/**
 * @param {Array} records   archive records
 * @param {Array} tags      all tags ({id, name})
 * @param {object} opts     { query, category, availability, tagIds, sort }
 */
export function applyFilters(records, tags, opts = {}) {
  const { query = '', category = 'all', availability = 'all', tagIds = [], sort = 'newest' } = opts;
  const tagName = new Map(tags.map((t) => [t.id, t.name.toLowerCase()]));
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const out = records.filter((r) => {
    if (category !== 'all' && r.category !== category) return false;
    if (availability !== 'all' && r.availability !== availability) return false;
    if (tagIds.length && !tagIds.every((id) => r.tagIds.includes(id))) return false;
    if (tokens.length) {
      // Every search word must match the file name or at least one of its tags.
      const haystack = [r.name.toLowerCase(), ...r.tagIds.map((id) => tagName.get(id) || '')];
      return tokens.every((t) => haystack.some((h) => h.includes(t)));
    }
    return true;
  });

  return out.sort(SORTERS[sort] || SORTERS.newest);
}

const terms = query => query.match(/\S+/gu) ?? [];
const sameTag = (term, tag) => term.toLowerCase() === `#${tag}`.toLowerCase();

export function tagCatalog(plugins) {
  const tags = new Map();
  for (const plugin of plugins) for (const tag of plugin.tags ?? []) {
    if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b, 'en'));
}

export function tagAtCaret(query, start, end = start) {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > query.length) return null;
  const match = query.slice(0, start).match(/(?:^|\s)#([^\s]*)$/u);
  if (!match) return null;
  const from = start - match[1].length - 1;
  const rest = query.slice(start).match(/^\S*/u)[0];
  return { start: from, end: start + rest.length, prefix: match[1] };
}

export function suggestTags(catalog, query, token) {
  if (!token) return [];
  const selected = terms(query.slice(0, token.start) + ' ' + query.slice(token.end));
  return catalog.filter(tag => tag.toLowerCase().startsWith(token.prefix.toLowerCase()) &&
    !selected.some(term => sameTag(term, tag)));
}

export function insertTag(query, tag, token = null) {
  const before = token ? query.slice(0, token.start) : query.trimEnd();
  const after = token ? query.slice(token.end) : '';
  const exists = terms(before + ' ' + after).some(term => sameTag(term, tag));
  if (exists && !token) return { query, caret: query.length };
  const head = token ? before : before + (before ? ' ' : '');
  const value = exists ? '' : `#${tag}`;
  const separator = value && !/^\s/u.test(after) ? ' ' : '';
  const next = head + value + separator + after;
  return { query: next, caret: head.length + value.length + (separator ? 1 : /^\s/u.test(after) ? 1 : 0) };
}

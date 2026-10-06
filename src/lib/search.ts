/**
 * Searching a list of projects by name. Every word you type has to appear
 * somewhere in the name, in any order, ignoring capitals and accents, so
 * "lofi night" finds "Night drive (Lo-Fi)" the way people expect.
 */

/** Lower case, no accents, hyphens and punctuation treated as spaces. */
function simplify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function matchesQuery(name: string, query: string): boolean {
  const words = simplify(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;

  const haystack = simplify(name);
  // Words are matched against the name with its spaces removed as well, so
  // "lofi" finds "Lo-Fi" and "neondrive" finds "Neon Drive".
  const squashed = haystack.replace(/ /g, "");
  return words.every((word) => haystack.includes(word) || squashed.includes(word));
}

export function filterByName<T>(items: readonly T[], query: string, nameOf: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  return items.filter((item) => matchesQuery(nameOf(item), query));
}

/** Lists shorter than this don't need a search box. */
export const SEARCH_FROM = 6;

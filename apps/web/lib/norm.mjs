// Shared by the autocomplete generator (scripts/autocomplete/gen.mjs) and the search (lib/autocomplete.ts), so both
// agree on which names and aliases are the same.

/** Letters NFD doesn't decompose, folded to their usual ASCII spelling: "Łódź" matches "lodz". */
const FOLD = { ł: 'l', ø: 'o', ı: 'i', đ: 'd', ð: 'd', ħ: 'h', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th' };
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'g');

const ASCII = /^[\x20-\x7e]*$/;

/** Lower case, no diacritics or punctuation: "São Paulo" and "sao paulo" match. */
export function norm(s) {
  // Most names are plain ASCII, which needs no folding: this halves the index build.
  if (ASCII.test(s))
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return s
    .toLowerCase()
    .replace(FOLD_RE, (c) => FOLD[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

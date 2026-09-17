// Shared text normalisation for the social formatters.
//
// WHY THIS IS A MODULE AND NOT A REGEX. The characters this strips cannot be written as escape
// sequences in this repository: the editing tooling decodes a backslash-u escape into the raw
// character it names, so a regex class naming zero-width characters becomes a regex class CONTAINING
// them — invisible, unreviewable, and corrupting on the next edit. HANDOFF.md records this. So the
// set is expressed as NUMBERS and compared by code point, which no tool can silently rewrite.

const NBSP = 0xa0;                                         // non-breaking space -> ordinary space
const ZERO_WIDTH = new Set([
  0x200b,  // zero width space
  0x200c,  // zero width non-joiner
  0x200d,  // zero width joiner
  0xfeff,  // byte order mark / zero width no-break space
]);

/**
 * Presentation cleanup for copy that is about to be published: collapse the whitespace a publisher's
 * feed leaves behind, and remove characters that render as nothing but count against a platform's
 * length limit. It never changes a word, a number, or a unit.
 */
export function normalizeSocialText(input) {
  const source = String(input ?? '');
  let out = '';
  for (const ch of source) {
    const code = ch.codePointAt(0);
    if (code === NBSP) { out += ' '; continue; }
    if (ZERO_WIDTH.has(code)) continue;
    out += ch;
  }
  return out
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True if the string contains a character this module would strip — used by the tests as a tripwire. */
export function hasInvisibleCharacters(input) {
  for (const ch of String(input ?? '')) {
    const code = ch.codePointAt(0);
    if (code === NBSP || ZERO_WIDTH.has(code)) return true;
  }
  return false;
}

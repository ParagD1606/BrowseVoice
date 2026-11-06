/** Utilities for keeping selected-page context readable and model-safe. */

/** Removes icon-font/private-use glyphs and invisible formatting noise. */
export function cleanSnippetText(value: string): string {
  return value
    .replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[\t\r ]+/g, " ")
    .trim();
}

/** Normalizes lines while preserving their visual order and meaningful repeats. */
export function cleanSnippetLines(lines: string[], maxCharacters = 5000): string {
  const cleaned: string[] = [];
  for (const line of lines) {
    const value = cleanSnippetText(line);
    if (!value || /^[\s\p{P}\p{S}]+$/u.test(value)) continue;
    if (cleaned.at(-1) === value) continue;
    cleaned.push(value);
  }
  return cleaned.join("\n").slice(0, maxCharacters);
}

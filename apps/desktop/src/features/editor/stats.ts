export interface DocStats {
  words: number;
  chars: number;
  charsNoSpaces: number;
  paragraphs: number;
  lines: number;
  /** Minutes de lecture à 230 mots/minute, au moins 1 pour un texte non vide. */
  readingMinutes: number;
}

const WORDS_PER_MINUTE = 230;

/** Statistiques calculées à partir du texte brut (blocs séparés par un saut de ligne). */
export function docStats(text: string): DocStats {
  const blocks = text.split('\n');
  const trimmed = text.trim();
  const words =
    trimmed === '' ? 0 : (trimmed.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0);
  const chars = [...text.replace(/\n/g, '')].length;
  return {
    words,
    chars,
    charsNoSpaces: [...text.replace(/\s/g, '')].length,
    paragraphs: blocks.filter((b) => b.trim() !== '').length,
    lines: trimmed === '' ? 0 : blocks.length,
    readingMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
  };
}

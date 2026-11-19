/**
 * Search over note titles and notebook names. Forgiving, like the search in most apps: case and
 * accents are ignored, words can come in any order, the start of a word is enough, and a small
 * typo still finds the title. Closer matches rank higher (exact, then the start, then a word start,
 * then anywhere, then typos). "Quoted text" must appear exactly as written.
 */

export const MAX_QUERY = 200;

/** Lowercase, without accents, with runs of spaces and punctuation made single spaces. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Edit distance with swaps (Damerau–Levenshtein, optimal string alignment), stopping early past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** How many typos a word of this length may have and still match. */
const allowedTypos = (n: number) => (n >= 8 ? 2 : n >= 4 ? 1 : 0);

export interface ParsedQuery {
  /** Words that may match loosely. */
  words: string[];
  /** "Quoted" phrases that must appear as written (accents and case still ignored). */
  phrases: string[];
  /** The whole query, normalised, for exact / starts-with ranking. */
  whole: string;
}

export function parseQuery(q: string): ParsedQuery {
  const query = q.slice(0, MAX_QUERY);
  const phrases: string[] = [];
  const rest = query.replace(/"([^"]*)"/g, (_, p: string) => {
    const n = normalize(p);
    if (n) phrases.push(n);
    return ' ';
  });
  const words = normalize(rest).split(' ').filter(Boolean).slice(0, 12);
  return { words, phrases, whole: normalize(query.replace(/"/g, '')) };
}

/**
 * How well a name matches (0: not at all). Every query word must be found in the name, as a word
 * start, anywhere inside it, or (for longer words) a word within a typo or two.
 */
export function score(name: string, q: ParsedQuery): number {
  const text = normalize(name);
  if (!text || (!q.words.length && !q.phrases.length)) return 0;
  for (const p of q.phrases) if (!` ${text} `.includes(` ${p} `) && !text.includes(p)) return 0;
  const tokens = text.split(' ');
  let total = 0;
  for (const w of q.words) {
    let best = 0;
    for (const t of tokens) {
      if (t === w) best = Math.max(best, 100);
      else if (t.startsWith(w)) best = Math.max(best, 80);
      else if (t.includes(w)) best = Math.max(best, w.length >= 2 ? 50 : 0);
      else {
        const typos = allowedTypos(w.length);
        if (typos) {
          // Compare with the word, or with its start when the query word is shorter (typing in progress).
          const d = Math.min(editDistance(w, t, typos), t.length > w.length ? editDistance(w, t.slice(0, w.length), typos) : typos + 1);
          if (d <= typos) best = Math.max(best, 30 - d * 8);
        }
      }
    }
    if (!best) return 0;
    total += best;
  }
  // Whole-name bonuses: the name is the query, or starts with it.
  if (q.whole && text === q.whole) total += 400;
  else if (q.whole && text.startsWith(q.whole)) total += 200;
  else if (q.whole && text.includes(q.whole)) total += 100;
  return total + q.phrases.length * 60;
}

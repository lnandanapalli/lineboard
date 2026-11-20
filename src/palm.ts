/**
 * Automatic palm detection: learns how big this person's writing contacts are (a finger, a
 * rubber-tipped stylus, a fine tip...) from their first few strokes each time Lineboard opens, and
 * from then on treats a touch much bigger than that as a resting palm. Nothing to set up, and it
 * adapts when someone else picks up the tablet or switches from a stylus to a finger.
 *
 * Contact size is what the browser reports for a touch (CSS pixels across); some devices report
 * none at all, and then size cannot tell a palm from a pen, so it is not used (the locked strips
 * and the one-stroke-at-a-time rule still keep palms out).
 */

/** Strokes to learn from before the limit is set. */
export const LEARN_STROKES = 4;
/**
 * While learning, contacts above this are taken for a palm: well above a fingertip or stylus on
 * common tablets, below most palms. Someone whose writing contact is bigger is caught by missed().
 */
export const LEARN_LIMIT = 70;
export const MIN_LIMIT = 20;
export const MAX_LIMIT = 150;
/**
 * Refused touches that make it learn again: each alone on the screen, in the writing area, and
 * moving like writing (a resting palm stays still, so resting it never counts).
 */
const MISSES_TO_RELEARN = 3;
const MISS_WINDOW_MS = 10_000;

export class PalmLearner {
  private samples: number[] = [];
  private limit: number | null = null;
  private misses: number[] = [];
  /** The limit while learning (raised when someone writes with a bigger contact). */
  private cap = LEARN_LIMIT;

  /** The largest contact (px) that still writes. Infinity: size is not reported, so not used. */
  get threshold(): number {
    return this.limit ?? this.cap;
  }

  get learning() {
    return this.limit === null;
  }

  get sampleCount() {
    return this.samples.length;
  }

  /** A stroke was written with a contact this big. */
  record(size: number) {
    if (!this.learning || !Number.isFinite(size) || size < 0) return;
    this.samples.push(size);
    if (this.samples.length >= LEARN_STROKES) this.limit = limitFrom(this.samples);
  }

  /**
   * A stroke that is writing (it has been going for a while) reached this contact size: make sure
   * the limit leaves room for it, so the next strokes like it are not taken for a palm.
   */
  widen(size: number) {
    if (!Number.isFinite(size) || size <= 0) return;
    const room = Math.round(Math.min(MAX_LIMIT, size * 1.3 + 6));
    if (this.limit !== null && this.limit !== Infinity && room > this.limit) this.limit = room;
    if (this.limit === null && room > this.cap) this.cap = room;
  }

  /**
   * A touch of this size, alone and moving like writing in the writing area, was refused as a
   * palm. A few of those in a row mean someone writes with a bigger contact (another person, a
   * finger instead of a stylus): learn again, with room for that contact. Returns true then.
   */
  missed(size: number, now = Date.now()): boolean {
    this.misses = [...this.misses.filter((t) => now - t < MISS_WINDOW_MS), now];
    if (this.misses.length < MISSES_TO_RELEARN) return false;
    this.reset();
    this.cap = Math.round(Math.min(MAX_LIMIT, Math.max(LEARN_LIMIT, size * 1.3 + 6)));
    return true;
  }

  reset() {
    this.samples = [];
    this.limit = null;
    this.misses = [];
    this.cap = LEARN_LIMIT;
  }
}

/**
 * The palm limit from writing contacts: comfortably above the biggest of them (palms are several
 * times bigger than a fingertip or stylus), within MIN_LIMIT..MAX_LIMIT.
 */
export function limitFrom(samples: number[]): number {
  if (!samples.length) return LEARN_LIMIT;
  if (samples.every((s) => s <= 1)) return Infinity; // size not reported by this device
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  return Math.round(Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.max(median * 1.7, max * 1.3) + 6)));
}

/**
 * Limits on what users can enter or add, in one place. Each one is also enforced where the data
 * ends up (the database's checks in supabase/schema.sql, the file reader in lbd.ts), so the app
 * stops people early with a clear message and the server refuses anything that gets past it.
 * README.md lists them all.
 */

/** Text. (Minimums: an empty title becomes "Untitled", an empty notebook name "Untitled notebook".) */
export const MAX_NOTE_TITLE = 200;
export const MAX_NOTEBOOK_NAME = 120;
export const MAX_VERSION_NAME = 120;
export const MAX_EMAIL = 254; // the longest address the email standards allow

/** Supabase Auth hashes passwords with bcrypt, which reads at most 72 bytes; it refuses longer ones. */
export const MAX_PASSWORD = 72;
/** Shortest password accepted for new passwords; keep in step with the project's Auth setting. */
export const MIN_PASSWORD = 8;
/** The encryption passphrase (stretched with PBKDF2, so length costs nothing; this only stops absurd input). */
export const MAX_PASSPHRASE = 256;

/** Pictures added in one go (paste, drop or the picker). */
export const MAX_PICTURES_AT_ONCE = 20;
/** A file to import (.lbd or .zip); the unpacked content has its own limits in lbd.ts. */
export const MAX_IMPORT_FILE = 1_500_000_000;
/** A version's snapshot, packed (the database keeps at most 16 million characters of base64). */
export const MAX_SNAPSHOT_BYTES = 11_000_000;

/** Trim a typed name to its limit without cutting a character in half. */
export function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : Array.from(t).slice(0, max).join('').trim();
}

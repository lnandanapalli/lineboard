/**
 * End-to-end encryption primitives (Web Crypto only, no dependencies).
 *
 * Key hierarchy (the same envelope scheme password managers use):
 *
 *   data key (DEK)      random AES-256-GCM key; encrypts note titles, notebook names and ink.
 *   passphrase key      PBKDF2-SHA256(passphrase, random salt, 600k rounds) -> wraps the DEK.
 *   recovery key        160 random bits shown to the user once; HKDF -> wraps the DEK again.
 *
 * The server only ever stores the two wrapped copies of the DEK plus ciphertext, so neither the
 * operator nor anyone with database access can read notes. Changing the passphrase re-wraps the
 * DEK; nothing has to be re-encrypted. Losing both the passphrase and the recovery key means the
 * DEK (and therefore the notes) cannot be recovered by anyone.
 */

export const PBKDF2_ITERATIONS = 600_000; // OWASP recommendation for PBKDF2-HMAC-SHA256
const CIPHER_PREFIX = 'v1.';
const enc = new TextEncoder();
const dec = new TextDecoder();

export class CryptoError extends Error {}

// ----------------------------- encoding -----------------------------

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Crockford base32: no I, L, O, U, so it is easy to read back and type.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Recovery key bytes -> "ABCD-EFGH-..." (8 groups of 4). */
export function formatRecoveryKey(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** Parse what the user typed; forgiving about case, spaces, dashes and look-alike letters. */
export function parseRecoveryKey(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== RECOVERY_CHARS) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out.slice(0, RECOVERY_BYTES));
}

const RECOVERY_BYTES = 20; // 160 bits
const RECOVERY_CHARS = Math.ceil((RECOVERY_BYTES * 8) / 5); // 32

export function newRecoveryKey(): { bytes: Uint8Array<ArrayBuffer>; text: string } {
  const bytes = randomBytes(RECOVERY_BYTES);
  return { bytes, text: formatRecoveryKey(bytes) };
}

// ----------------------------- keys -----------------------------

export interface KdfParams {
  name: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
}

export function newKdfParams(): KdfParams {
  return { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(randomBytes(16)) };
}

/** Key-encryption key from the passphrase (slow on purpose, to resist guessing). */
export async function passphraseKek(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  if (kdf.name !== 'PBKDF2-SHA256') throw new CryptoError('Unsupported key derivation: ' + kdf.name);
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(kdf.salt), iterations: kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Key-encryption key from the recovery key (already high-entropy, so a fast KDF is enough). */
export async function recoveryKek(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('lineboard recovery key v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A fresh data key, as raw bytes (only kept in memory long enough to wrap it). */
export function newDataKeyBytes(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}

/** Import the data key for use. Non-extractable: page scripts can use it but never read it out. */
export function importDataKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const WRAP_AAD = enc.encode('lineboard data key v1');

export async function wrapDataKey(raw: Uint8Array<ArrayBuffer>, kek: CryptoKey): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, kek, raw));
  return CIPHER_PREFIX + toB64(concat(iv, ct));
}

/** Throws CryptoError when the key-encryption key is wrong (wrong passphrase / recovery key). */
export async function unwrapDataKey(wrapped: string, kek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const { iv, ct } = split(wrapped);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, kek, ct));
  } catch {
    throw new CryptoError('Wrong key');
  }
}

// ----------------------------- data -----------------------------

/**
 * Encrypt a JSON value. `context` (e.g. "stroke:<id>") is bound into the ciphertext as associated
 * data, so a ciphertext copied onto another row fails to decrypt instead of showing the wrong content.
 */
export async function seal(key: CryptoKey, context: string, value: unknown): Promise<string> {
  const iv = randomBytes(12);
  const data = enc.encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, data));
  return CIPHER_PREFIX + toB64(concat(iv, ct));
}

export async function open<T>(key: CryptoKey, context: string, sealed: string): Promise<T> {
  const { iv, ct } = split(sealed);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, ct);
    return JSON.parse(dec.decode(plain)) as T;
  } catch {
    throw new CryptoError('Could not decrypt ' + context.split(':')[0]);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function split(sealed: string) {
  if (!sealed.startsWith(CIPHER_PREFIX)) throw new CryptoError('Unknown ciphertext format');
  const bytes = fromB64(sealed.slice(CIPHER_PREFIX.length));
  if (bytes.length < 12 + 16) throw new CryptoError('Ciphertext too short');
  return { iv: bytes.slice(0, 12), ct: bytes.slice(12) };
}

// ----------------------------- binary data (images) -----------------------------

/** Encrypted files start with these bytes, so a reader can tell them from plain images. */
const BYTES_MAGIC = new Uint8Array([0x4c, 0x42, 0x45, 0x31]); // "LBE1"

export function isSealedBytes(bytes: Uint8Array): boolean {
  return bytes.length > BYTES_MAGIC.length && BYTES_MAGIC.every((b, i) => bytes[i] === b);
}

/** Encrypt a file's bytes; `context` (e.g. "image:<id>") is bound in as associated data. */
export async function sealBytes(key: CryptoKey, context: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, data));
  const out = new Uint8Array(BYTES_MAGIC.length + iv.length + ct.length);
  out.set(BYTES_MAGIC);
  out.set(iv, BYTES_MAGIC.length);
  out.set(ct, BYTES_MAGIC.length + iv.length);
  return out;
}

export async function openBytes(key: CryptoKey, context: string, sealed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const iv = sealed.slice(BYTES_MAGIC.length, BYTES_MAGIC.length + 12);
  const ct = sealed.slice(BYTES_MAGIC.length + 12);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, ct));
  } catch {
    throw new CryptoError('Could not decrypt image');
  }
}

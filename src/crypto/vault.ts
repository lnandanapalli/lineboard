import type { SupabaseClient } from '@supabase/supabase-js';
import { uuid } from '../util';
import {
  CryptoError,
  importDataKey,
  newDataKeyBytes,
  newKdfParams,
  newRecoveryKey,
  parseRecoveryKey,
  passphraseKek,
  recoveryKek,
  unwrapDataKey,
  wrapDataKey,
  type KdfParams,
} from './cipher';

/**
 * off         nothing is encrypted (or encryption was turned off).
 * encrypting  turned on; existing notes are being encrypted. New writes are already encrypted.
 * on          everything is encrypted; the server refuses plaintext notes.
 * decrypting  being turned off; notes are being decrypted. New writes are plaintext.
 */
export type EncryptionState = 'off' | 'encrypting' | 'on' | 'decrypting';

interface KeyRow {
  user_id: string;
  state: EncryptionState;
  key_id: string;
  kdf: KdfParams;
  pass_wrapped: string;
  recovery_wrapped: string;
  updated_at?: string;
}

export const MIN_PASSPHRASE = 10;

/** Error from a wrong passphrase or recovery key, worded for the user. */
export class WrongSecretError extends Error {}

const REFRESH_MS = 60_000;

/**
 * The user's encryption keys. The server keeps only wrapped copies (see cipher.ts); the usable data
 * key lives in memory, and optionally on this device in IndexedDB as a non-extractable CryptoKey.
 */
export class KeyVault {
  private row: KeyRow | null = null;
  private dataKey: CryptoKey | null = null;
  private loadedAt = 0;
  /** False when the database has not been updated for encryption yet (older schema). */
  supported = true;
  /** Called when another device turned encryption on and this one has no key yet. */
  onLocked: () => void = () => {};

  constructor(
    private sb: SupabaseClient,
    private userId: string,
  ) {}

  get state(): EncryptionState {
    return this.row?.state ?? 'off';
  }
  /** New writes must be encrypted. */
  get writeEncrypted() {
    return this.state === 'encrypting' || this.state === 'on';
  }
  /** Reading notes needs the key (some or all of them are encrypted). */
  get needsKey() {
    return this.state !== 'off';
  }
  /** The account has keys, even if encryption is currently off. */
  get hasKeys() {
    return !!this.row;
  }
  get key() {
    return this.dataKey;
  }
  get unlocked() {
    return !!this.dataKey;
  }

  /** Fetch the key row. Returns the current state. */
  async refresh(): Promise<EncryptionState> {
    const { data, error } = await this.sb.from('user_keys').select('user_id,state,key_id,kdf,pass_wrapped,recovery_wrapped,updated_at').maybeSingle();
    if (error) {
      // Table missing: the project's database predates encryption (run supabase/schema.sql again).
      if (error.code === '42P01' || error.code === 'PGRST205' || /user_keys/.test(error.message ?? '')) {
        this.supported = false;
        this.row = null;
        this.loadedAt = Date.now();
        return 'off';
      }
      throw new Error(error.message || 'Could not load encryption settings');
    }
    this.supported = true;
    this.row = (data as KeyRow | null) ?? null;
    this.loadedAt = Date.now();
    if (this.dataKey && this.row && this.keyIdOfMemory !== this.row.key_id) {
      // Keys were replaced elsewhere (encryption reset and set up again).
      this.dataKey = null;
      await forgetKey(this.userId);
    }
    return this.state;
  }

  /** Re-check the state now and then, so a device notices encryption changing on another device. */
  async refreshIfStale() {
    if (Date.now() - this.loadedAt > REFRESH_MS) {
      try {
        await this.refresh();
      } catch {
        /* offline: keep the last known state */
      }
    }
  }

  private keyIdOfMemory: string | null = null;

  private setKey(key: CryptoKey, keyId: string) {
    this.dataKey = key;
    this.keyIdOfMemory = keyId;
  }

  /** Use the key remembered on this device, if it belongs to the current keys. */
  async restore(): Promise<boolean> {
    if (!this.row) return false;
    const saved = await loadKey(this.userId);
    if (!saved || saved.keyId !== this.row.key_id) return false;
    this.setKey(saved.key, saved.keyId);
    return true;
  }

  async unlockWithPassphrase(passphrase: string, remember: boolean) {
    const raw = await this.unwrapWithPassphrase(passphrase);
    await this.useRaw(raw, remember);
  }

  async unlockWithRecoveryKey(text: string, remember: boolean) {
    const raw = await this.unwrapWithRecovery(text);
    await this.useRaw(raw, remember);
  }

  private async useRaw(raw: Uint8Array<ArrayBuffer>, remember: boolean) {
    const row = this.requireRow();
    const key = await importDataKey(raw);
    raw.fill(0);
    this.setKey(key, row.key_id);
    if (remember) await saveKey(this.userId, row.key_id, key);
    else await forgetKey(this.userId);
  }

  private requireRow(): KeyRow {
    if (!this.row) throw new Error('Encryption is not set up');
    return this.row;
  }

  private async unwrapWithPassphrase(passphrase: string) {
    const row = this.requireRow();
    try {
      return await unwrapDataKey(row.pass_wrapped, await passphraseKek(passphrase, row.kdf));
    } catch (e) {
      if (e instanceof CryptoError) throw new WrongSecretError('That passphrase is not right.');
      throw e;
    }
  }

  private async unwrapWithRecovery(text: string) {
    const row = this.requireRow();
    const bytes = parseRecoveryKey(text);
    if (!bytes) throw new WrongSecretError('A recovery key has 32 letters and digits, like ABCD-EFGH-....');
    try {
      return await unwrapDataKey(row.recovery_wrapped, await recoveryKek(bytes));
    } catch (e) {
      if (e instanceof CryptoError) throw new WrongSecretError('That recovery key is not right.');
      throw e;
    }
  }

  /**
   * Create new keys for turning encryption on. Nothing is saved until `commit` is called, so the
   * user can write the recovery key down first.
   */
  async prepare(passphrase: string): Promise<{ recoveryKey: string; commit: (remember: boolean) => Promise<void> }> {
    const raw = newDataKeyBytes();
    const recovery = newRecoveryKey();
    const kdf = newKdfParams();
    const row: KeyRow = {
      user_id: this.userId,
      state: 'encrypting',
      key_id: uuid(),
      kdf,
      pass_wrapped: await wrapDataKey(raw, await passphraseKek(passphrase, kdf)),
      recovery_wrapped: await wrapDataKey(raw, await recoveryKek(recovery.bytes)),
    };
    const key = await importDataKey(raw);
    raw.fill(0);
    recovery.bytes.fill(0);
    return {
      recoveryKey: recovery.text,
      commit: async (remember: boolean) => {
        const { error } = await this.sb
          .from('user_keys')
          .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
        if (error) throw new Error(error.message || 'Could not save encryption keys');
        this.row = row;
        this.loadedAt = Date.now();
        this.setKey(key, row.key_id);
        if (remember) await saveKey(this.userId, row.key_id, key);
      },
    };
  }

  async setState(state: EncryptionState) {
    const { error } = await this.sb.from('user_keys').update({ state, updated_at: new Date().toISOString() }).eq('user_id', this.userId);
    if (error) throw new Error(error.message || 'Could not update encryption state');
    if (this.row) this.row.state = state;
  }

  /** Re-wrap the data key under a new passphrase. `proof` is the current passphrase or the recovery key. */
  async changePassphrase(proof: { passphrase: string } | { recoveryKey: string }, next: string) {
    const raw = 'passphrase' in proof ? await this.unwrapWithPassphrase(proof.passphrase) : await this.unwrapWithRecovery(proof.recoveryKey);
    const kdf = newKdfParams();
    const pass_wrapped = await wrapDataKey(raw, await passphraseKek(next, kdf));
    raw.fill(0);
    await this.patch({ kdf, pass_wrapped });
  }

  /** Replace the recovery key (the old one stops working). Returns the new one to show the user. */
  async newRecoveryKey(passphrase: string): Promise<string> {
    const raw = await this.unwrapWithPassphrase(passphrase);
    const recovery = newRecoveryKey();
    const recovery_wrapped = await wrapDataKey(raw, await recoveryKek(recovery.bytes));
    raw.fill(0);
    recovery.bytes.fill(0);
    await this.patch({ recovery_wrapped });
    return recovery.text;
  }

  /** Check a passphrase without changing anything (before turning encryption off). */
  async verifyPassphrase(passphrase: string) {
    (await this.unwrapWithPassphrase(passphrase)).fill(0);
  }

  private async patch(fields: Partial<KeyRow>) {
    const { error } = await this.sb
      .from('user_keys')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId);
    if (error) throw new Error(error.message || 'Could not save encryption keys');
    Object.assign(this.requireRow(), fields);
  }

  /** Forget the key on this device (sign out). The account keeps its keys. */
  async lock() {
    this.dataKey = null;
    this.keyIdOfMemory = null;
    await forgetKey(this.userId);
  }

  /** Remove the keys entirely (after the encrypted notes were deleted, or decryption finished). */
  async removeKeys() {
    const { error } = await this.sb.from('user_keys').delete().eq('user_id', this.userId);
    if (error) throw new Error(error.message || 'Could not remove encryption keys');
    this.row = null;
    await this.lock();
  }
}

// ----------------------------- remembered key (IndexedDB) -----------------------------

const DB_NAME = 'lineboard-keys';
const STORE = 'keys';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T>((resolve, reject) => {
      const r = fn(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    }).finally(() => d.close());
  } catch (e) {
    // Private windows and locked-down browsers may refuse IndexedDB; the key then stays in memory only.
    console.warn('Key storage unavailable', e);
    return undefined;
  }
}

const saveKey = (uid: string, keyId: string, key: CryptoKey) => tx('readwrite', (s) => s.put({ keyId, key }, uid)).then(() => {});
const loadKey = (uid: string) => tx<{ keyId: string; key: CryptoKey }>('readonly', (s) => s.get(uid));
const forgetKey = (uid: string) => tx('readwrite', (s) => s.delete(uid)).then(() => {});

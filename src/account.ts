import { config } from './config';
import { isAuthSessionMissingError, type Factor, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Account security on top of Supabase Auth: signed-in devices, password changes, authenticator-app
 * two-step verification (TOTP) and passkeys. UI lives in securityUi.ts.
 */

export interface DeviceSession {
  id: string;
  created_at: string;
  last_active: string;
  user_agent: string | null;
  ip: string | null;
  aal: string | null;
  is_current: boolean;
}

export interface Passkey {
  id: string;
  friendly_name?: string;
  created_at: string;
  last_used_at?: string;
}

/** A readable error for the UI. */
export class AccountError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

type AnyErr = { message?: string; code?: string | number } | null | undefined;

function fail(error: AnyErr, fallback: string): never {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  throw new AccountError(error?.message || fallback, code);
}

export const passkeysSupported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;

export class AccountSecurity {
  constructor(readonly sb: SupabaseClient) {}

  // ----------------------------- devices -----------------------------

  async listSessions(): Promise<DeviceSession[]> {
    const { data, error } = await this.sb.rpc('list_my_sessions');
    if (error) fail(error, 'Could not load your devices');
    return (data ?? []) as DeviceSession[];
  }

  /** Sign one device out. Its access to notes ends at once; the app there returns to the sign-in page. */
  async revokeSession(id: string) {
    const { error } = await this.sb.rpc('revoke_my_session', { target: id });
    if (error) fail(error, 'Could not sign that device out');
  }

  /** Sign out every device except this one. */
  async signOutOthers() {
    const { error } = await this.sb.auth.signOut({ scope: 'others' });
    if (error) fail(error, 'Could not sign out other devices');
  }

  /**
   * Is this device's session still valid on the server? False once it was signed out from another
   * device (or by a password reset). Null when the server could not be asked (offline).
   */
  async sessionAlive(): Promise<boolean | null> {
    const { error } = await this.sb.auth.getUser();
    if (!error) return true;
    // The server answers "session_not_found" for a revoked session; the client reports it this way.
    if (isAuthSessionMissingError(error)) return false;
    const code = (error as AnyErr)?.code;
    const status = (error as { status?: number }).status;
    if (code === 'session_not_found' || code === 'refresh_token_not_found' || code === 'user_not_found' || status === 401 || status === 403) return false;
    return null;
  }

  // ----------------------------- confirming it's you -----------------------------

  /**
   * When the user last proved who they are (password or authenticator code) on this page. Risky
   * actions (new passkey, two-step changes, encryption) need a recent proof, so someone who picks up
   * an unlocked device can't quietly add their own way into the account.
   */
  private confirmedAt = 0;
  static readonly CONFIRM_WINDOW_MS = 5 * 60_000;

  get recentlyConfirmed() {
    return Date.now() - this.confirmedAt < AccountSecurity.CONFIRM_WINDOW_MS;
  }

  /**
   * Check the account password without touching this device's session: sign in on the side, then
   * end that extra session straight away.
   */
  async verifyPassword(email: string, password: string) {
    const base = config.supabaseUrl.replace(/\/+$/, '') + '/auth/v1';
    const headers = { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}`, 'Content-Type': 'application/json' };
    let res: Response;
    try {
      res = await fetch(`${base}/token?grant_type=password`, { method: 'POST', headers, body: JSON.stringify({ email, password }) });
    } catch {
      throw new AccountError('Could not reach the server. Check your connection and try again.');
    }
    if (res.status === 429) throw new AccountError('Too many attempts. Wait a minute and try again.', 'over_request_rate_limit');
    if (!res.ok) throw new AccountError('That password is not right.', 'invalid_credentials');
    const { access_token } = (await res.json()) as { access_token?: string };
    if (access_token) {
      await fetch(`${base}/logout?scope=local`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${access_token}` } }).catch(() => {});
    }
    this.confirmedAt = Date.now();
  }

  /** Prove it's you with a code from an authenticator app (two-step verification users). */
  async confirmWithCode(factorId: string, code: string) {
    await this.verifyCode(factorId, code);
    this.confirmedAt = Date.now();
  }

  // ----------------------------- password -----------------------------

  /**
   * Set a new password and, by default, sign out every other device. Needs proof: the current
   * password (checked here, and by the server too when "require current password" is on), or the
   * code from `sendPasswordCode()` for accounts that never had a password.
   */
  async changePassword(
    password: string,
    proof: { currentPassword: string; email: string } | { nonce: string },
    opts: { signOutOthers?: boolean } = {},
  ) {
    if ('currentPassword' in proof) await this.verifyPassword(proof.email, proof.currentPassword);
    const { error } = await this.sb.auth.updateUser(
      'currentPassword' in proof ? { password, current_password: proof.currentPassword } : { password, nonce: proof.nonce },
    );
    if (error) {
      const code = (error as AnyErr)?.code;
      if (code === 'reauthentication_needed' || code === 'reauth_nonce_missing') {
        await this.sendPasswordCode();
        throw new AccountError('For your security we emailed you a confirmation code as well. Enter it to change your password.', 'reauthentication_needed');
      }
      if (code === 'reauthentication_not_valid' || code === 'otp_expired') fail(error, 'That code is not right or has expired.');
      if (code === 'same_password') fail(error, 'The new password must be different from the current one.');
      fail(error, 'Could not change the password');
    }
    if (opts.signOutOthers !== false) await this.signOutOthers();
  }

  /** Email a one-time code that authorises a password change (for accounts without a password). */
  async sendPasswordCode() {
    const { error } = await this.sb.auth.reauthenticate();
    if (error) fail(error, 'Could not send a confirmation code');
  }

  // ----------------------------- authenticator apps (TOTP) -----------------------------

  async authenticators(): Promise<Factor[]> {
    const { data, error } = await this.sb.auth.mfa.listFactors();
    if (error) fail(error, 'Could not load two-step verification');
    return data.totp;
  }

  /** Remove half-finished enrollments (they count towards the per-user limit). */
  private async dropUnverified() {
    const { data } = await this.sb.auth.mfa.listFactors();
    for (const f of data?.all ?? []) if (f.factor_type === 'totp' && f.status !== 'verified') await this.sb.auth.mfa.unenroll({ factorId: f.id });
  }

  /** Start adding an authenticator app: returns the QR code and secret to show. */
  async startAuthenticator(name: string) {
    await this.dropUnverified();
    const { data, error } = await this.sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: name, issuer: 'Lineboard' });
    if (error) fail(error, 'Could not start two-step verification');
    return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  }

  /** Confirm a code from the app. For a new authenticator this turns it on (and signs out other devices). */
  async verifyCode(factorId: string, code: string) {
    const { error } = await this.sb.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') });
    if (error) {
      const c = (error as AnyErr)?.code;
      if (c === 'mfa_verification_failed' || c === 'invalid_credentials') throw new AccountError('That code is not right. Codes change every 30 seconds; try the current one.', c);
      fail(error, 'Could not verify the code');
    }
  }

  async cancelAuthenticator(factorId: string) {
    await this.sb.auth.mfa.unenroll({ factorId });
  }

  async removeAuthenticator(factorId: string) {
    const { error } = await this.sb.auth.mfa.unenroll({ factorId });
    if (error) fail(error, 'Could not remove the authenticator');
  }

  /** Signed in with password or passkey only, while the account requires a second step. */
  async needsSecondStep(): Promise<boolean> {
    const { data, error } = await this.sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return false;
    return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
  }

  // ----------------------------- passkeys -----------------------------

  async passkeys(): Promise<Passkey[]> {
    const { data, error } = await this.sb.auth.passkey.list();
    if (error) fail(error, 'Passkeys are not available on this server');
    // The documented shape is an array; accept a wrapped list too, so a server change can't hide passkeys.
    const raw = data as unknown;
    if (Array.isArray(raw)) return raw as Passkey[];
    const wrapped = raw as { passkeys?: unknown; data?: unknown } | null;
    if (Array.isArray(wrapped?.passkeys)) return wrapped.passkeys as Passkey[];
    if (Array.isArray(wrapped?.data)) return wrapped.data as Passkey[];
    return [];
  }

  /**
   * Register a passkey for this account. Throws AccountError with code "cancelled" when the person
   * dismissed the browser prompt; any other failure (including the server refusing it) is reported.
   */
  async addPasskey(name: string) {
    const { data, error } = await this.sb.auth.registerPasskey();
    if (error) throw passkeyError(error, 'add');
    if (name && data?.id) {
      const { error: re } = await this.sb.auth.passkey.update({ passkeyId: data.id, friendlyName: name.slice(0, 120) });
      if (re) console.warn('Passkey added but not renamed', re);
    }
  }

  async renamePasskey(id: string, name: string) {
    const { error } = await this.sb.auth.passkey.update({ passkeyId: id, friendlyName: name.slice(0, 120) });
    if (error) fail(error, 'Could not rename the passkey');
  }

  async removePasskey(id: string) {
    const { error } = await this.sb.auth.passkey.delete({ passkeyId: id });
    if (error) fail(error, 'Could not remove the passkey');
  }
}

/** "Chrome on Android" from a user-agent string. */
export function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPad/.test(ua)
      ? 'iPad'
      : /iPhone|iPod/.test(ua)
        ? 'iPhone'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'Mac'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Turn a passkey failure into something a person can act on. Only a dismissed or timed-out browser
 * prompt counts as "cancelled"; a refusal from the server is always shown.
 */
export function passkeyError(error: unknown, action: 'add' | 'sign-in'): AccountError {
  const e = error as { name?: string; code?: string; message?: string; cause?: { name?: string; message?: string }; status?: number };
  const browserName = e.cause?.name ?? e.name;
  if (e.code === 'ERROR_CEREMONY_ABORTED' || (e.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' && browserName === 'NotAllowedError')) {
    return new AccountError(action === 'add' ? 'Passkey setup was cancelled or timed out.' : 'Passkey sign-in was cancelled or timed out.', 'cancelled');
  }
  if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || browserName === 'InvalidStateError') {
    return new AccountError('This device or password manager already has a passkey for your account.', 'exists');
  }
  if (e.code === 'ERROR_INVALID_DOMAIN' || e.code === 'ERROR_INVALID_RP_ID' || browserName === 'SecurityError') {
    return new AccountError(
      'The server’s passkey settings don’t match this site’s address. The operator needs to set the relying party ID to this domain (and allow this origin) in Supabase → Authentication → Passkeys.',
      'rp_mismatch',
    );
  }
  const site = location.origin;
  if (e.code === 'webauthn_verification_failed') {
    return new AccountError(
      action === 'add'
        ? `Supabase refused the passkey ("${e.message}"). This usually means ${site} is not listed exactly under Allowed origins in Supabase → Authentication → Passkeys, or the Relying Party ID isn't ${location.hostname}. Remove the passkey your browser just created, fix the setting, and try again.`
        : `Supabase refused the passkey ("${e.message}"). Check that ${site} is an allowed origin in Supabase → Authentication → Passkeys.`,
      e.code,
    );
  }
  if (e.code === 'webauthn_credential_exists') return new AccountError('That passkey is already on your account.', e.code);
  if (e.code === 'too_many_passkeys') return new AccountError('You have the maximum number of passkeys. Remove one first.', e.code);
  if (e.code === 'passkey_disabled') return new AccountError('Passkeys are turned off on this server (Supabase → Authentication → Passkeys).', e.code);
  const msg = e.message || (action === 'add' ? 'Could not add the passkey' : 'Passkey sign-in failed');
  return new AccountError(`${action === 'add' ? 'The passkey was not saved to your account' : 'Passkey sign-in failed'}: ${msg}`, e.code);
}

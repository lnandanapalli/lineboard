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

  // ----------------------------- password -----------------------------

  /**
   * Set a new password and, by default, sign out every other device. When the project requires a
   * recent sign-in ("secure password change"), the first call throws code "reauthentication_needed"
   * after emailing a code; call again with that code as `nonce`.
   */
  async changePassword(password: string, opts: { nonce?: string; signOutOthers?: boolean } = {}) {
    const { error } = await this.sb.auth.updateUser({ password, ...(opts.nonce ? { nonce: opts.nonce } : {}) });
    if (error) {
      const code = (error as AnyErr)?.code;
      if (code === 'reauthentication_needed' || code === 'reauth_nonce_missing') {
        const { error: re } = await this.sb.auth.reauthenticate();
        if (re) fail(re, 'Could not send a confirmation code');
        throw new AccountError('We emailed you a confirmation code. Enter it to change your password.', 'reauthentication_needed');
      }
      fail(error, 'Could not change the password');
    }
    if (opts.signOutOthers !== false) await this.signOutOthers();
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
    return data ?? [];
  }

  async addPasskey(name: string) {
    const { data, error } = await this.sb.auth.registerPasskey();
    if (error) fail(error, 'Could not add the passkey');
    if (name && data?.id) await this.sb.auth.passkey.update({ passkeyId: data.id, friendlyName: name.slice(0, 120) });
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

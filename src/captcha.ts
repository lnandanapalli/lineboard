import { config } from './config';
import { h } from './util';

/**
 * Bot check (Cloudflare Turnstile) for the requests bots abuse: sign-up, sign-in (password, email
 * link, passkey), password reset, and the password check behind "Confirm it's you". It runs only
 * when a site key is configured; Supabase Auth then verifies each token (Authentication > Attack
 * Protection > CAPTCHA, with the matching secret key), so a request without one is refused there.
 * Most people never see a puzzle: the widget appears only when Turnstile needs an interaction.
 * Each token works once; `take()` hands one out and starts a fresh check for the next request.
 */

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const captchaEnabled = () => !!config.turnstileSiteKey;

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Bot check did not load')));
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the bot check. Check your connection (or content blocker) and try again.'));
    };
    document.head.append(s);
  });
  return loading;
}

export class Captcha {
  /** Where the widget goes (empty unless Turnstile needs an interaction). */
  readonly el = h('div', { class: 'captcha' });
  private id: string | null = null;
  private token: string | null = null;
  private waiters: ((t: string) => void)[] = [];
  private failed: Error | null = null;

  constructor() {
    if (!captchaEnabled()) return;
    void loadTurnstile()
      .then((t) => {
        this.id = t.render(this.el, {
          sitekey: config.turnstileSiteKey,
          appearance: 'interaction-only',
          action: 'auth',
          callback: (tok: string) => {
            this.token = tok;
            this.failed = null;
            for (const w of this.waiters.splice(0)) w(tok);
          },
          'expired-callback': () => (this.token = null),
          'error-callback': () => {
            this.failed = new Error('The bot check failed. Try again in a moment.');
          },
        });
      })
      .catch((e: Error) => (this.failed = e));
  }

  /**
   * A token for one request (undefined when the bot check is off). Waits for the check to finish,
   * then resets it so the next request gets a fresh one.
   */
  async take(timeoutMs = 30_000): Promise<string | undefined> {
    if (!captchaEnabled()) return undefined;
    const tok =
      this.token ??
      (await new Promise<string>((resolve, reject) => {
        if (this.failed) return reject(this.failed);
        const timer = setTimeout(() => reject(this.failed ?? new Error('The bot check is taking too long. Try again.')), timeoutMs);
        this.waiters.push((t) => {
          clearTimeout(timer);
          resolve(t);
        });
      }));
    this.token = null;
    if (this.id && window.turnstile) window.turnstile.reset(this.id);
    return tok;
  }

  destroy() {
    if (this.id && window.turnstile) window.turnstile.remove(this.id);
    this.id = null;
  }
}

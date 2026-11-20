/** Seconds Supabase Auth makes you wait between two emails to the same address (its default). */
export const EMAIL_COOLDOWN = 60;

/**
 * Supabase Auth's email limits, in words. Two kinds: the wait between two emails to one address
 * ("you can only request this after N seconds", N being what is left), and the project's limit on
 * emails per hour ("email rate limit exceeded"). Returns the wait in seconds when there is one.
 */
export function emailLimit(err: { message?: string; code?: string; status?: number }): { text: string; wait: number } | null {
  const m = err.message ?? '';
  const after = /after (\d+) seconds?/i.exec(m) ?? /once every (\d+) seconds?/i.exec(m);
  if (after) {
    const wait = Math.max(1, Number(after[1]));
    return { text: 'An email was sent to this address moments ago. Check your inbox (and spam folder); a new one can be sent in', wait };
  }
  if (/email rate limit exceeded/i.test(m) || err.code === 'over_email_send_rate_limit') {
    return { text: 'Lineboard has sent a lot of emails in the last hour, so a new one cannot be sent right now. Please try again in a few minutes.', wait: 0 };
  }
  return null;
}

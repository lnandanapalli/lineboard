import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Captcha } from '../captcha';

/** The bot check for a screen: made when it shows, removed when it goes. Null for a moment at first. */
export function useCaptcha(): Captcha | null {
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  useEffect(() => {
    const c = new Captcha();
    setCaptcha(c);
    return () => c.destroy();
  }, []);
  return captcha;
}

/** Where the bot check's widget shows (only when it needs a click). Moving it re-parents the widget. */
export function CaptchaSlot({ captcha }: { captcha: Captcha | null }) {
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (captcha && slot.current) slot.current.append(captcha.el);
  }, [captcha]);
  return <span ref={slot} style={{ display: 'contents' }} />;
}

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type InputHTMLAttributes } from 'react';
import { icons } from '../icons';

/**
 * A password field with a show / hide button (the eye), so a typing mistake can be checked.
 * Pressing it keeps the caret in the field; the field goes back to hidden when its form is sent.
 */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function PasswordInput(props, ref) {
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const hide = () => setShown(false);
    form.addEventListener('submit', hide);
    return () => {
      form.removeEventListener('submit', hide);
    };
  }, []);
  const label = shown ? 'Hide password' : 'Show password';
  return (
    <span className="reveal">
      <input {...props} ref={input} type={shown ? 'text' : 'password'} />
      <button
        className="reveal-btn"
        type="button"
        aria-label={label}
        aria-pressed={shown}
        title={label}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setShown((s) => !s)}
        dangerouslySetInnerHTML={{ __html: shown ? icons.eyeOff : icons.eye }}
      />
    </span>
  );
});

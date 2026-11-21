import { createPortal } from 'react-dom';
import { create } from 'zustand';

const useToast = create<{ msg: string; kind: 'info' | 'error'; shown: boolean; ever: boolean }>(() => ({ msg: '', kind: 'info', shown: false, ever: false }));
let timer: ReturnType<typeof setTimeout> | undefined;

/** Show a short message at the bottom of the screen (errors stay a little longer). */
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  useToast.setState({ msg, kind, shown: true, ever: true });
  clearTimeout(timer);
  timer = setTimeout(() => useToast.setState({ shown: false }), kind === 'error' ? 5000 : 2500);
}

/** The message itself: inside the app element when there is one, so it turns with a manually rotated app. */
export function Toast() {
  const { msg, kind, shown, ever } = useToast();
  if (!ever) return null;
  const host = document.querySelector<HTMLElement>('.app') ?? document.body;
  return createPortal(
    <div id="toast" role="status" className={(shown ? 'show ' : '') + kind}>
      {msg}
    </div>,
    host,
  );
}

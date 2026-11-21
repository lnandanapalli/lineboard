import { useLayoutEffect, useRef } from 'react';

/** An element made outside React (the board, which draws itself), placed here. */
export function Mount({ el }: { el: HTMLElement }) {
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    slot.current?.append(el);
    return () => el.remove();
  }, [el]);
  return <span ref={slot} style={{ display: 'contents' }} />;
}

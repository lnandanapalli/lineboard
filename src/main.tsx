import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './boot';

let booted = false;

/**
 * The React root. Screens not yet converted to React still render themselves into this host
 * element (see boot.ts); it uses `display: contents`, so the page lays out exactly as before.
 */
function Root() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Once per page (StrictMode runs effects twice in development).
    if (booted || !host.current) return;
    booted = true;
    boot(host.current);
  }, []);
  return <div className="screen-host" ref={host} />;
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

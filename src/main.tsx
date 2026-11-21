import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './boot';
import { useScreen, type Screen } from './ui/screen';
import { HomePage, PolicyPage } from './ui/Public';
import { AuthScreen, NewPasswordScreen } from './ui/Auth';
import { BusyScreen, MoveNotesScreen, StorageNotice } from './ui/Startup';

let booted = false;

function ScreenView({ screen }: { screen: Screen }) {
  switch (screen.kind) {
    case 'home':
      return <HomePage cloud={screen.cloud} signedIn={screen.signedIn} onStart={screen.onStart} />;
    case 'policy':
      return <PolicyPage page={screen.page} />;
    case 'auth':
      return <AuthScreen sb={screen.sb} initialMode={screen.initialMode} onTryLocal={screen.onTryLocal} guest={screen.guest} />;
    case 'new-password':
      return <NewPasswordScreen sb={screen.sb} done={screen.done} />;
    case 'move-notes':
      return <MoveNotesScreen count={screen.count} answer={screen.answer} />;
    case 'busy':
      return <BusyScreen text={screen.text} />;
  }
}

/**
 * The React root: the screen boot.ts asks for (ui/screen.ts). Screens not yet converted to React
 * render themselves into the host element instead; it uses `display: contents`, so the page lays
 * out exactly as before.
 */
function Root() {
  const { screen, seq } = useScreen();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Once per page (StrictMode runs effects twice in development).
    if (booted || !host.current) return;
    booted = true;
    boot(host.current);
  }, []);
  return (
    <>
      {screen && <ScreenView key={seq} screen={screen} />}
      <div className="screen-host" ref={host} />
      <StorageNotice />
    </>
  );
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

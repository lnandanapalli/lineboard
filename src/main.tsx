import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './boot';
import { useScreen, type Screen } from './ui/screen';
import { HomePage, PolicyPage } from './ui/Public';
import { AuthScreen, NewPasswordScreen } from './ui/Auth';
import { BusyScreen, MoveNotesScreen, StorageNotice } from './ui/Startup';
import { AppScreen } from './ui/AppScreen';
import { UnlockScreen } from './ui/Encryption';
import { SecondStepScreen } from './ui/Security';
import { Overlays } from './ui/overlays';
import { Toast } from './ui/Toast';

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
    case 'unlock':
      return <UnlockScreen o={screen.o} done={screen.done} />;
    case 'second-step':
      return <SecondStepScreen account={screen.account} factors={screen.factors} signOut={screen.signOut} done={screen.done} />;
    case 'app':
      return <AppScreen app={screen.app} />;
  }
}

/** The React root: the screen boot.ts asks for (ui/screen.ts), and what shows over any screen. */
function Root() {
  const { screen, seq } = useScreen();
  useEffect(() => {
    // Once per page (StrictMode runs effects twice in development).
    if (booted) return;
    booted = true;
    // Just after this first render: boot() changes screens at once (flushSync), which React does
    // not allow from inside its own render.
    queueMicrotask(boot);
  }, []);
  return (
    <>
      {screen && <ScreenView key={seq} screen={screen} />}
      <Overlays />
      <Toast />
      <StorageNotice />
    </>
  );
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

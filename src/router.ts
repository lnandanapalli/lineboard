/** Small history router; nginx serves index.html when these paths are opened directly. */
const pages = new Set(['home', 'app', 'login', 'signup', 'terms', 'privacy']);
export const navigationEvent = 'lineboard:navigate';

export function pageName(): string {
  return location.pathname.replace(/^\/+|\/+$/g, '');
}

export function replaceRoute(path: string) {
  history.replaceState(null, '', path);
}

export function navigate(path: string) {
  if (location.pathname + location.search + location.hash !== path) history.pushState(null, '', path);
  window.dispatchEvent(new Event(navigationEvent));
}

function normalizeLegacyRoute() {
  // Recognize only our old routes. Supabase token/code callback fragments must stay intact.
  const fragment = location.hash.slice(1);
  if (pages.has(fragment)) replaceRoute(`/${fragment}${location.search}`);
  else if (fragment === 'how-it-works' && location.pathname !== '/home') replaceRoute(`/home${location.search}#how-it-works`);
}

export function installRouter() {
  normalizeLegacyRoute();
  window.addEventListener('popstate', () => {
    normalizeLegacyRoute();
    window.dispatchEvent(new Event(navigationEvent));
  });
  window.addEventListener('hashchange', () => {
    normalizeLegacyRoute();
    window.dispatchEvent(new Event(navigationEvent));
  });
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || (url.pathname !== '/' && !pages.has(url.pathname.slice(1)))) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
}

import { h, lsGet, lsSet } from './util';

/**
 * A one-time notice about what Lineboard keeps in the browser. Everything it stores is strictly
 * necessary for the app to work (notes, settings, the sign-in session, offline files), and there
 * are no advertising, analytics or tracking cookies, so EU/UK rules (ePrivacy art. 5(3)) ask for
 * clear information, not consent. The notice says so and links to the full list in the privacy
 * policy. Dismissing it is remembered in the same storage.
 */
const KEY = 'lb-storage-notice';

export function showStorageNotice() {
  if (lsGet<boolean>(KEY, false) || document.querySelector('.storage-notice')) return;
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'OK');
  const el = h(
    'section',
    { class: 'storage-notice', role: 'region', 'aria-label': 'Storage notice' },
    h(
      'p',
      {},
      'Lineboard keeps your notes, settings and sign-in in this browser so the app works. No ads, no analytics, no tracking cookies. ',
      h('a', { href: '/privacy#storage' }, 'What is stored'),
    ),
    ok,
  );
  ok.addEventListener('click', () => {
    lsSet(KEY, true);
    el.remove();
  });
  document.body.append(el);
}

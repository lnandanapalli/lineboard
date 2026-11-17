import { logo } from './brand';
import { h } from './util';

export function publicFooter() {
  return h('footer', { class: 'site-footer' }, h('span', {}, 'Lineboard · A little more room to think.'),
    h('nav', { 'aria-label': 'Legal' }, h('a', { href: '/terms' }, 'Terms of service'), h('a', { href: '/privacy' }, 'Privacy policy'), h('a', { href: 'https://github.com/lnandanapalli/lineboard/issues' }, 'Support on GitHub')));
}

export function renderHome(root: HTMLElement, cloud: boolean, start: () => void, signedIn = false) {
  document.title = 'Lineboard — Space for your next idea';
  const tryButton = h('button', { class: 'btn primary hero-cta', type: 'button' }, signedIn ? 'Back to my notes' : 'Try it without an account');
  tryButton.addEventListener('click', start);
  const feature = (n: string, title: string, text: string) => h('article', {}, h('span', { class: 'feature-number' }, n), h('h3', {}, title), h('p', {}, text));
  root.replaceChildren(h('div', { class: 'public-page' },
    h('header', { class: 'site-header' }, h('a', { class: 'brand', href: '/home', 'aria-label': 'Lineboard home' }, logo(), 'Lineboard'),
      h('nav', { 'aria-label': 'Main navigation' }, h('a', { href: '/home#how-it-works' }, 'How it works'), cloud && !signedIn ? h('a', { href: '/login' }, 'Log in') : null,
        cloud && !signedIn ? h('a', { class: 'btn', href: '/signup' }, 'Create account') : h('a', { class: 'btn', href: '/app' }, 'Open notebook'))),
    h('main', { id: 'home-main' },
      h('section', { class: 'hero' }, h('div', { class: 'hero-copy' },
        h('p', { class: 'eyebrow' }, 'YOUR IDEAS. YOUR HANDWRITING.'),
        h('h1', {}, 'A clear page.', h('br'), h('em', {}, 'A freer mind.')),
        h('p', { class: 'hero-description' }, 'A handwriting notebook made for your tablet. Rest your palm, pick a line, and let your thoughts take shape.'),
        h('div', { class: 'hero-actions' }, tryButton, cloud && !signedIn ? h('a', { href: '/signup' }, 'Create a free account →') : null),
        h('p', { class: 'hero-note' }, signedIn ? 'You’re signed in. Pick up where you left off.' : 'No active pen required. No account needed to begin.')),
        h('div', { class: 'notebook-preview', role: 'img', 'aria-label': 'Notebook illustration with one unlocked writing strip and protected lines above and below' },
          h('div', { class: 'preview-top' }, h('span', {}, 'My everyday notebook'), h('span', {}, '● Saved on this device')),
          h('div', { class: 'preview-paper' }, h('span', { class: 'preview-date' }, 'A little space to think'),
            h('p', { class: 'handwriting' }, 'Good things start', h('br'), 'with a small idea.'),
            h('div', { class: 'active-line' }, h('span', {}, '→'), h('span', { class: 'handwriting' }, 'Make room for yours.')),
            h('div', { class: 'preview-sketch' }, '✧  ~~~~~  ↗')),
          h('div', { class: 'preview-caption' }, h('span', { class: 'ink-dot' }), 'One open strip. The rest is palm-safe.'))),
      h('section', { class: 'how-section', id: 'how-it-works' }, h('p', { class: 'eyebrow' }, 'LESS FRICTION. MORE FLOW.'), h('h2', {}, 'Made for the way you write.'),
        h('div', { class: 'feature-grid' },
          feature('01', 'Rest your hand.', 'Unlock a strip to write. The other strips ignore touches, so your palm can rest while your ideas move.'),
          feature('02', 'Find your flow.', 'Write, highlight, erase, and undo. Switch to a free whiteboard when an idea needs more than a line.'),
          feature('03', 'Keep it together.', cloud ? 'Organize notes into notebooks, export a PNG, or create an account to sync across devices.' : 'Organize notes into notebooks and export a PNG. This installation keeps your work in this browser.'))),
      h('section', { class: 'home-detail' }, h('div', {}, h('p', { class: 'eyebrow' }, 'START SMALL. THINK BIG.'), h('h2', {}, 'For lecture notes, loose thoughts,', h('br'), 'and everything in between.')),
        h('div', {}, h('p', {}, 'Use a capacitive stylus or your finger. With an active pen, Lineboard also supports pressure-aware ink.'),
          h('p', {}, 'Trying it out? Your notes stay in this browser. Export anything important before clearing browser data.')))), publicFooter()));
  if (location.hash === '#how-it-works') root.querySelector('#how-it-works')?.scrollIntoView();
}

const policies = {
  terms: {
    title: 'Terms of service', intro: 'The essentials for using Lineboard responsibly.',
    sections: [
      ['Using Lineboard', 'Lineboard is a handwriting and note-taking application. You may use it only for lawful purposes. Do not use it to harm others, interfere with the service, or access accounts or data that are not yours.'],
      ['Your account', 'When accounts are enabled, provide an email address you control and keep your sign-in credentials private. You are responsible for activity through your account. Local mode does not require an account.'],
      ['Your notes belong to you', 'You retain ownership of the notes and drawings you create. Using cloud sync allows the service to store and process that content to provide the features you request. Do not upload content you do not have permission to use.'],
      ['Saving and backups', 'Browser-only notes depend on this device and browser storage. Clearing that storage can delete them. Cloud sync depends on connectivity and the configured backend. Keep independent copies of important work; PNG export is available in the app.'],
      ['Availability and responsibility', 'Lineboard is provided as available, without a promise of uninterrupted access or error-free storage. Features may change. To the extent permitted by applicable law, the service is provided without warranties and its operators are not responsible for losses caused by service interruptions or lost notes. Nothing here limits rights that cannot legally be excluded.'],
      ['Stopping use and changes', 'You can stop using Lineboard at any time. Delete notes you no longer want before leaving an account. These terms may be updated as the service changes; review this page for the current version.'],
      ['Who runs Lineboard', 'Lineboard is operated by GitHub user lnandanapalli. For support, account questions, or questions about these terms, raise an issue in the Lineboard GitHub repository using the link below. If you use a separately hosted copy, its operator is responsible for that installation.'],
    ],
  },
  privacy: {
    title: 'Privacy policy', intro: 'Understand where your notes live and what changes when you sign in.',
    sections: [
      ['Without an account', 'Notes, strokes, notebooks, and preferences are stored in this browser. The app does not send these notes to a cloud account while you use local or guest mode. Other people with access to this browser profile may be able to read them.'],
      ['With an account', 'When cloud features are configured, Supabase handles authentication and storage. Your email address, authentication information, notes, notebooks, strokes, and settings are processed to sign you in and sync your work. The configured Supabase project and hosting operator control that service.'],
      ['Moving guest notes', 'When you choose to sign in to save guest notes, Lineboard attempts to move those notes to your account. A normal sign-in may ask whether to add existing guest notes or keep them separate. Local copies are removed after a successful migration.'],
      ['Browser storage', 'Lineboard uses browser storage for notes, preferences, and persistent authentication sessions. Its service worker caches application files for offline use. This application does not include advertising trackers or third-party analytics. The hosting and authentication providers may process technical request information such as IP addresses and timestamps.'],
      ['Retention and your choices', 'Local data stays until you delete it or clear browser storage. Cloud notes remain in the configured backend until deleted, subject to the operator’s backup and retention practices. You can delete notes in the app and export drawings as PNG images. Signing out does not delete cloud notes.'],
      ['Account and privacy requests', 'Lineboard is operated by GitHub user lnandanapalli. Raise an issue in the Lineboard GitHub repository for account or privacy questions, including requests about access, correction, or deletion. GitHub issues are public: do not include passwords, tokens, private notes, or other sensitive personal information. Account deletion is not currently available inside the app. For a separately hosted copy, contact its operator; hosting and retention practices depend on that installation.'],
      ['Changes to this policy', 'This page describes the application’s current data flows. Review it when features change. For details of the authentication provider’s own practices, see the Supabase privacy policy.'],
    ],
  },
};

export function renderPolicy(root: HTMLElement, kind: keyof typeof policies) {
  const policy = policies[kind];
  document.title = `${policy.title} — Lineboard`;
  root.replaceChildren(h('div', { class: 'public-page' },
    h('header', { class: 'site-header' }, h('a', { class: 'brand', href: '/home' }, logo(), 'Lineboard'), h('a', { href: '/app' }, 'Back to notebook →')),
    h('main', { class: 'policy-page' }, h('a', { href: '/home' }, '← Home'), h('p', { class: 'eyebrow' }, 'LAST UPDATED NOVEMBER 17, 2026'),
      h('h1', {}, policy.title), h('p', { class: 'policy-intro' }, policy.intro),
      ...policy.sections.map(([title, text]) => h('section', {}, h('h2', {}, title), h('p', {}, text))),
      h('section', {}, h('h2', {}, 'Contact'), h('p', {}, 'Operator: ', h('a', { href: 'https://github.com/lnandanapalli' }, '@lnandanapalli'), '. For support or privacy questions, ', h('a', { href: 'https://github.com/lnandanapalli/lineboard/issues' }, 'raise a GitHub issue'), '. Issues are public; do not post private notes, passwords, tokens, or sensitive personal information.')),
      h('p', {}, h('a', { href: 'https://github.com/lnandanapalli/lineboard' }, 'Lineboard source project'), ' · ', h('a', { href: 'https://supabase.com/privacy' }, 'Supabase privacy policy'))), publicFooter()));
}

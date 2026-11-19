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
        h('p', { class: 'hero-description' }, 'A handwriting notebook for your tablet. Write above the line, rest your hand below it, and let your thoughts take shape.'),
        h('div', { class: 'hero-actions' }, tryButton, cloud && !signedIn ? h('a', { href: '/signup' }, 'Create a free account →') : null),
        h('p', { class: 'hero-note' }, signedIn ? 'You’re signed in. Pick up where you left off.' : 'No active pen required. No account needed to begin.')),
        h('div', { class: 'notebook-preview', role: 'img', 'aria-label': 'Notebook illustration: handwriting above a line across the page, and a locked, palm-safe area below it' },
          h('div', { class: 'preview-top' }, h('span', {}, 'My everyday notebook'), h('span', {}, '● Saved on this device')),
          h('div', { class: 'preview-paper' }, h('span', { class: 'preview-date' }, 'A little space to think'),
            h('p', { class: 'handwriting' }, 'Good things start', h('br'), 'with a small idea.'),
            h('p', { class: 'handwriting preview-writing' }, 'Make room for yours.', h('span', { class: 'preview-caret' })),
            h('div', { class: 'preview-line' }, h('span', { class: 'preview-grip' }, '═')),
            h('div', { class: 'preview-locked' }, h('span', {}, '🔒'), h('span', {}, 'Rest your hand here'))),
          h('div', { class: 'preview-caption' }, h('span', { class: 'ink-dot' }), 'Write above the line. Below it is palm-safe.'))),
      h('section', { class: 'how-section', id: 'how-it-works' }, h('p', { class: 'eyebrow' }, 'LESS FRICTION. MORE FLOW.'), h('h2', {}, 'Made for the way you write.'),
        h('div', { class: 'feature-grid' },
          feature('01', 'Draw the line.', 'One line splits the screen. Write above it; below it the screen is locked, so your palm and stray fingers can rest without leaving marks. Drag the line to wherever your hand sits.'),
          feature('02', 'Find your flow.', 'Write, highlight, add shapes, text and pictures, erase and undo. Lock the page strip by strip, or switch to a free whiteboard when an idea needs the whole page.'),
          feature('03', 'Keep it together.', cloud ? 'Organize notes into notebooks, export a PNG, or create an account to sync across devices.' : 'Organize notes into notebooks and export a PNG. This installation keeps your work in this browser.'))),
      h('section', { class: 'home-detail' }, h('div', {}, h('p', { class: 'eyebrow' }, 'START SMALL. THINK BIG.'), h('h2', {}, 'For lecture notes, loose thoughts,', h('br'), 'and everything in between.')),
        h('div', {}, h('p', {}, 'Use a capacitive stylus or your finger. With an active pen, Lineboard also supports pressure-aware ink.'),
          h('p', {}, 'Trying it out? Your notes stay in this browser. Export anything important before clearing browser data.')))), publicFooter()));
  if (location.hash === '#how-it-works') root.querySelector('#how-it-works')?.scrollIntoView();
}

type PolicySection = [id: string, title: string, ...paragraphs: string[]];

const policies: Record<'terms' | 'privacy', { title: string; intro: string; sections: PolicySection[] }> = {
  terms: {
    title: 'Terms of service', intro: 'The essentials for using Lineboard responsibly.',
    sections: [
      ['using', 'Using Lineboard', 'Lineboard is a handwriting and note-taking application. You may use it only for lawful purposes. You must be at least 13 years old (or the minimum age for online services where you live, if higher) to create an account.'],
      ['acceptable-use', 'Acceptable use', 'Do not use Lineboard to store or share unlawful content, to harm or harass others, or to infringe anyone’s rights. Do not attack, overload, scrape or probe the service, try to get around its limits or security (including the checks that tell people from bots), create accounts in bulk or by automated means, or access accounts or data that are not yours. Report security problems privately as described in the project’s security policy instead of testing them on other people’s accounts.'],
      ['limits', 'Fair-use limits', 'To keep the service available for everyone, accounts have generous limits on the number of notebooks, notes, strokes per note, version history and the size and number of pictures. Normal use never comes near them; if you reach one, the app tells you.'],
      ['account', 'Your account', 'Provide an email address you control and keep your sign-in details private. You are responsible for activity through your account. You can delete your account at any time in Settings > Data controls; deleting it removes your notes and pictures from the service permanently. Local mode does not need an account.'],
      ['content', 'Your notes belong to you', 'You keep ownership of the notes, drawings and pictures you create or upload. You give the service only the permission it needs to store and process them to provide the features you use. Do not upload content you do not have the right to use. You can download all of it at any time (Settings > Data controls > Download my data).'],
      ['backups', 'Saving and backups', 'Browser-only notes depend on this device and browser storage; clearing that storage deletes them. Cloud sync depends on connectivity and the backend. Keep your own copies of important work.'],
      ['suspension', 'Suspension', 'Accounts used in breach of these terms, especially for abuse or attacks on the service, may be limited, suspended or deleted. Where reasonable, you will be told why and given a chance to download your data.'],
      ['warranty', 'Availability and responsibility', 'Lineboard is free and provided as available, without a promise of uninterrupted access or error-free storage, and features may change. To the extent permitted by law, it is provided without warranties and its operator is not liable for losses caused by interruptions or lost notes. Nothing here limits rights you have under consumer law that cannot be excluded.'],
      ['changes', 'Changes', 'These terms may change as the service changes. Material changes are shown on this page with a new date; continuing to use Lineboard after that means you accept them. You can stop using Lineboard at any time.'],
      ['operator', 'Who runs Lineboard', 'Lineboard is operated by GitHub user lnandanapalli. For support or questions about these terms, raise an issue in the Lineboard GitHub repository. If you use a separately hosted copy, its operator is responsible for that installation.'],
    ],
  },
  privacy: {
    title: 'Privacy policy', intro: 'What Lineboard keeps, why, for how long, and how you stay in control of it.',
    sections: [
      ['controller', 'Who is responsible', 'Lineboard (lineboard.site) is operated by GitHub user lnandanapalli, who is the controller of the personal data described here. Contact details are at the end of this page. A separately hosted copy of Lineboard is the responsibility of its own operator.'],
      ['without-account', 'Without an account', 'Notes, notebooks, pictures and preferences stay in this browser on this device. They are not sent to Lineboard’s servers. Anyone with access to this browser profile may be able to read them.'],
      ['data', 'What we keep when you have an account',
        'Account: your email address and a securely hashed password, or your passkeys’ public keys; if you turn on two-step verification, the authenticator secret.',
        'Your content: notebooks, notes, strokes, text boxes, pictures, earlier versions of your notes (version history) and settings. With end-to-end encryption on, these are encrypted in your browser and the server keeps only encrypted copies (the encrypted keys stored with them cannot be opened without your passphrase or recovery key).',
        'Security records: each signed-in device (browser and operating system as reported by the browser, IP address, sign-in time and last activity), so you can review and sign out devices in Settings, and so attacks can be detected.',
        'Technical logs: the hosting provider and Supabase keep short-lived request logs (such as IP address, time and browser) to run and protect the service.'],
      ['purposes', 'Why, and on what legal basis', 'To provide the service you sign up for: storing and syncing your notes and keeping your account secure (performance of a contract, GDPR art. 6(1)(b)). To protect the service and its users from abuse, fraud and attacks, including the bot check at sign-in and sign-up and fair-use limits (legitimate interests, art. 6(1)(f)). To meet legal obligations where they apply (art. 6(1)(c)). Lineboard has no advertising, does not profile you, and does not sell or share your personal information.'],
      ['storage', 'Cookies and browser storage',
        'Lineboard itself sets no cookies. It uses your browser’s storage only for what the app needs to work: your sign-in session; your notes, their version history, pictures and settings (on this device without an account, or as a copy while you work); changes waiting to be saved while offline; your encryption key, only if you choose to keep this device unlocked; the app’s own files so it works offline; and remembering that you have seen the storage notice.',
        'When the bot check is shown at sign-in or sign-up, Cloudflare Turnstile may set strictly necessary security cookies to tell people from automated abuse. There are no analytics, advertising or tracking cookies, so no consent is needed for any of this; clearing your browser’s site data removes it.'],
      ['processors', 'Service providers', 'Supabase (authentication, database and file storage), Microsoft Azure (hosting the website) and, when the bot check is enabled, Cloudflare (Turnstile). They process data only to provide their service to Lineboard, under their data processing terms. Some of them may process data outside your country, including in the United States; such transfers rely on the providers’ safeguards, such as the EU Standard Contractual Clauses or the EU–US Data Privacy Framework.'],
      ['retention', 'How long we keep it', 'Your account and content are kept until you delete them or your account. Earlier versions of a note thin out on their own (all from the last day, then one an hour for a week, then one a day for 90 days); versions you name are kept until you remove the name, and deleting a note deletes its history. Deleting your account (Settings > Data controls > Delete account) removes your account, notes, version history, pictures, settings, keys, passkeys and devices immediately. Copies may remain in the providers’ encrypted backups for a limited time (typically up to a few weeks) until those backups expire. Request logs are kept only briefly. Signing out does not delete anything.'],
      ['rights', 'Your rights and choices',
        'You can see, change, download and delete your data yourself: edit or delete notes in the app; Settings > Data controls > Download my data gives you everything in a machine-readable file (access and portability); Settings > Data controls > Delete account erases it (erasure).',
        'Depending on where you live (for example under the GDPR, the UK GDPR or California law), you also have the right to correct your data, to object to or restrict processing based on legitimate interests, not to be discriminated against for using your rights, and to complain to your data protection authority. For anything the app cannot do for you, contact us as below.'],
      ['security', 'Security', 'Connections are encrypted (HTTPS). Each account can only reach its own data, enforced by the database itself. Optional end-to-end encryption, two-step verification and passkeys add more protection, and you can sign out other devices at any time. No system is perfectly secure; if a breach affects your personal data, you will be told as the law requires.'],
      ['children', 'Children', 'Lineboard is not directed at children under 13, and accounts are for people aged 13 or older (or the minimum age where they live). If you believe a child has created an account, contact us and it will be deleted.'],
      ['guest-move', 'Moving guest notes', 'When you sign in to save notes you made without an account, Lineboard moves them to your account and then removes the local copies. A normal sign-in may ask whether to add existing guest notes or keep them separate.'],
      ['changes', 'Changes to this policy', 'This policy describes how Lineboard works today. If it changes in a way that matters, this page shows the new date, and important changes are announced in the app.'],
    ],
  },
};

export function renderPolicy(root: HTMLElement, kind: keyof typeof policies) {
  const policy = policies[kind];
  document.title = `${policy.title} — Lineboard`;
  root.replaceChildren(h('div', { class: 'public-page' },
    h('header', { class: 'site-header' }, h('a', { class: 'brand', href: '/home' }, logo(), 'Lineboard'), h('a', { href: '/app' }, 'Back to notebook →')),
    h('main', { class: 'policy-page' }, h('a', { href: '/home' }, '← Home'), h('p', { class: 'eyebrow' }, 'LAST UPDATED NOVEMBER 19, 2026'),
      h('h1', {}, policy.title), h('p', { class: 'policy-intro' }, policy.intro),
      ...policy.sections.map(([id, title, ...paras]) => h('section', { id }, h('h2', {}, title), ...paras.map((t) => h('p', {}, t)))),
      h('section', { id: 'contact' }, h('h2', {}, 'Contact'), h('p', {}, 'Operator: ', h('a', { href: 'https://github.com/lnandanapalli' }, '@lnandanapalli'), '. For support, ', h('a', { href: 'https://github.com/lnandanapalli/lineboard/issues' }, 'raise a GitHub issue'), '. Issues are public, so for privacy requests the app cannot handle, open an issue asking to be contacted privately, without any personal details in it. Never post private notes, passwords or tokens.')),
      h('p', {}, h('a', { href: 'https://github.com/lnandanapalli/lineboard' }, 'Lineboard source project'), ' · ', h('a', { href: 'https://supabase.com/privacy' }, 'Supabase privacy policy'))), publicFooter()));
  // A link to one section (e.g. /privacy#storage) opens at it.
  if (location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

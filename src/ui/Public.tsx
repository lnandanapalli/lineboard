import { useEffect } from 'react';
import { Logo } from './Logo';
import { policies } from '../policies';

export function PublicFooter() {
  return (
    <footer className="site-footer">
      <span>Lineboard · A little more room to think.</span>
      <nav aria-label="Legal">
        <a href="/terms">Terms of service</a>
        <a href="/privacy">Privacy policy</a>
        <a href="https://github.com/lnandanapalli/lineboard/issues">Support on GitHub</a>
      </nav>
    </footer>
  );
}

function Feature({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <article>
      <span className="feature-number">{n}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

/** The homepage. `cloud`: accounts are available; `signedIn`: someone is signed in on this device. */
export function HomePage({ cloud, signedIn, onStart }: { cloud: boolean; signedIn: boolean; onStart: () => void }) {
  useEffect(() => {
    document.title = 'Lineboard — Space for your next idea';
    if (location.hash === '#how-it-works') document.getElementById('how-it-works')?.scrollIntoView();
  }, []);
  const accounts = cloud && !signedIn;
  return (
    <div className="public-page">
      <header className="site-header">
        <a className="brand" href="/home" aria-label="Lineboard home">
          <Logo />
          Lineboard
        </a>
        <nav aria-label="Main navigation">
          <a href="/home#how-it-works">How it works</a>
          {accounts && <a href="/login">Log in</a>}
          {accounts ? (
            <a className="btn" href="/signup">
              Create account
            </a>
          ) : (
            <a className="btn" href="/app">
              Open notebook
            </a>
          )}
        </nav>
      </header>
      <main id="home-main">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">YOUR IDEAS. YOUR HANDWRITING.</p>
            <h1>
              A clear page.
              <br />
              <em>A freer mind.</em>
            </h1>
            <p className="hero-description">A handwriting notebook for your tablet. Write above the line, rest your hand below it, and let your thoughts take shape.</p>
            <div className="hero-actions">
              <button className="btn primary hero-cta" type="button" onClick={onStart}>
                {signedIn ? 'Back to my notes' : 'Try it without an account'}
              </button>
              {accounts && <a href="/signup">Create a free account →</a>}
            </div>
            <p className="hero-note">{signedIn ? 'You’re signed in. Pick up where you left off.' : 'No active pen required. No account needed to begin.'}</p>
          </div>
          <div className="notebook-preview" role="img" aria-label="Notebook illustration: handwriting above a line across the page, and a locked, palm-safe area below it">
            <div className="preview-top">
              <span>My everyday notebook</span>
              <span>● Saved on this device</span>
            </div>
            <div className="preview-paper">
              <span className="preview-date">A little space to think</span>
              <p className="handwriting">
                Good things start
                <br />
                with a small idea.
              </p>
              <p className="handwriting preview-writing">
                Make room for yours.<span className="preview-caret"></span>
              </p>
              <div className="preview-line">
                <span className="preview-grip">═</span>
              </div>
              <div className="preview-locked">
                <span>🔒</span>
                <span>Rest your hand here</span>
              </div>
            </div>
            <div className="preview-caption">
              <span className="ink-dot"></span>Write above the line. Below it is palm-safe.
            </div>
          </div>
        </section>
        <section className="how-section" id="how-it-works">
          <p className="eyebrow">LESS FRICTION. MORE FLOW.</p>
          <h2>Made for the way you write.</h2>
          <div className="feature-grid">
            <Feature n="01" title="Draw the line." text="One line splits the screen. Write above it; below it the screen is locked, so your palm and stray fingers can rest without leaving marks. Drag the line to wherever your hand sits." />
            <Feature n="02" title="Find your flow." text="Write, highlight, add shapes, text and pictures, erase and undo. Lock the page strip by strip, or switch to a free whiteboard when an idea needs the whole page." />
            <Feature
              n="03"
              title="Keep it together."
              text={cloud ? 'Organize notes into notebooks, export a PNG, or create an account to sync across devices.' : 'Organize notes into notebooks and export a PNG. This installation keeps your work in this browser.'}
            />
          </div>
        </section>
        <section className="home-detail">
          <div>
            <p className="eyebrow">START SMALL. THINK BIG.</p>
            <h2>
              For lecture notes, loose thoughts,
              <br />
              and everything in between.
            </h2>
          </div>
          <div>
            <p>Use a capacitive stylus or your finger. With an active pen, Lineboard also supports pressure-aware ink.</p>
            <p>Trying it out? Your notes stay in this browser. Export anything important before clearing browser data.</p>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}

/** The terms of service or the privacy policy. */
export function PolicyPage({ page }: { page: keyof typeof policies }) {
  const policy = policies[page];
  useEffect(() => {
    document.title = `${policy.title} — Lineboard`;
    // A link to one section (e.g. /privacy#storage) opens at it.
    if (location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [policy]);
  return (
    <div className="public-page">
      <header className="site-header">
        <a className="brand" href="/home">
          <Logo />
          Lineboard
        </a>
        <a href="/app">Back to notebook →</a>
      </header>
      <main className="policy-page">
        <a href="/home">← Home</a>
        <p className="eyebrow">LAST UPDATED NOVEMBER 19, 2026</p>
        <h1>{policy.title}</h1>
        <p className="policy-intro">{policy.intro}</p>
        {policy.sections.map(([id, title, ...paras]) => (
          <section id={id} key={id}>
            <h2>{title}</h2>
            {paras.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </section>
        ))}
        <section id="contact">
          <h2>Contact</h2>
          <p>
            Operator: <a href="https://github.com/lnandanapalli">@lnandanapalli</a>. For support, <a href="https://github.com/lnandanapalli/lineboard/issues">raise a GitHub issue</a>. Issues are public, so for
            privacy requests the app cannot handle, open an issue asking to be contacted privately, without any personal details in it. Never post private notes, passwords or tokens.
          </p>
        </section>
        <p>
          <a href="https://github.com/lnandanapalli/lineboard">Lineboard source project</a> · <a href="https://supabase.com/privacy">Supabase privacy policy</a>
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}

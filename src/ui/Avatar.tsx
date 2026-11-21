import { useState, type CSSProperties } from 'react';
import { initials, nameHue, PERSON_ICON, type Profile } from '../profile';

/** The round avatar: the picture, else the initials, else a person icon. */
export function Avatar({ profile, url, size = 32 }: { profile: Profile; url: string | null; size?: number }) {
  // A picture that cannot be shown (encrypted and locked, offline) falls back to the initials.
  const [failed, setFailed] = useState<string | null>(null);
  const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (url && failed !== url)
    return (
      <span className="avatar-circle" aria-hidden="true" style={style}>
        <img src={url} alt="" onError={() => setFailed(url)} />
      </span>
    );
  const text = initials(profile.name);
  if (text) {
    const hue = nameHue(profile.name);
    return (
      <span className="avatar-circle" aria-hidden="true" style={{ ...style, background: `hsl(${hue} 55% 88%)`, color: `hsl(${hue} 45% 28%)` }}>
        {text}
      </span>
    );
  }
  return <span className="avatar-circle blank" aria-hidden="true" style={style} dangerouslySetInnerHTML={{ __html: PERSON_ICON }} />;
}

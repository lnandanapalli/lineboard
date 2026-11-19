import { h } from './util';

/**
 * The user's profile: a display name (one field, as many names do not split into first and last)
 * and an optional picture. Without either, a neutral person icon stands in.
 */
export interface Profile {
  name: string;
  /** Changes each time a new picture is saved (null: no picture). */
  picture: string | null;
  /** The picture's file type. */
  pictureType?: string | null;
}

export const EMPTY_PROFILE: Profile = { name: '', picture: null };
export const MAX_NAME = 60;
/** Profile pictures are stored small: a 256 × 256 square. */
const PICTURE_SIDE = 256;
/** Largest picture file accepted before it is made small. */
export const MAX_PICTURE_UPLOAD = 15 * 1024 * 1024;

/** A name as stored: no control characters, single spaces, at most 60 characters (not cutting a character in half). */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Tabs and line breaks become spaces; other control and invisible formatting characters go.
  const s = raw.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return Array.from(s).slice(0, MAX_NAME).join('').trim();
}

/** "Lokeshwar Reddy" → "LR"; one word gives one letter; no name gives none. */
export function initials(name: string): string {
  const words = cleanName(name).split(' ').filter(Boolean);
  if (!words.length) return '';
  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
  return (first + last).toLocaleUpperCase();
}

/** A calm background colour picked from the name, so each person's initials keep their colour. */
function hue(name: string) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.codePointAt(0)!) % 360;
  return n;
}

const PERSON =
  '<svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>';

/** The round avatar: the picture, else the initials, else a person icon. */
export function avatar(profile: Profile, pictureUrl: string | null, size = 32): HTMLElement {
  const el = h('span', { class: 'avatar-circle', 'aria-hidden': 'true' });
  el.style.width = el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.4)}px`;
  const text = initials(profile.name);
  if (pictureUrl) {
    const img = h('img', { src: pictureUrl, alt: '' }) as HTMLImageElement;
    // A picture that cannot be shown (encrypted and locked, offline) falls back to the initials.
    img.addEventListener('error', () => {
      img.remove();
      fill();
    });
    el.append(img);
  } else fill();
  function fill() {
    if (text) {
      el.textContent = text;
      el.style.background = `hsl(${hue(profile.name)} 55% 88%)`;
      el.style.color = `hsl(${hue(profile.name)} 45% 28%)`;
    } else {
      el.innerHTML = PERSON;
      el.classList.add('blank');
    }
  }
  return el;
}

/** A picture made into a small square (centre crop), ready to store. */
export async function squarePicture(file: Blob): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a picture.');
  if (file.size > MAX_PICTURE_UPLOAD) throw new Error('That picture is too large (15 MB at most).');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This picture could not be read. Try a PNG or JPEG.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const c = document.createElement('canvas');
  c.width = c.height = PICTURE_SIDE;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PICTURE_SIDE, PICTURE_SIDE);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PICTURE_SIDE, PICTURE_SIDE);
  bitmap.close();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not prepare the picture'))), 'image/jpeg', 0.88));
}

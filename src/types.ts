export type Tool = 'pen' | 'highlighter' | 'eraser';

/** A single ink stroke. Coordinates are in page units: the page is always 1000 units wide. */
export interface Stroke {
  id: string;
  note_id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  /** Flat list: x0, y0, p0, x1, y1, p1, ... (p = pressure 0..1) */
  points: number[];
  created_at?: string;
}

export interface NoteMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  /** Strip height in page units (page width = 1000). */
  stripHeight: number;
  /** Touches with a contact size (CSS px) above this are treated as palm. */
  touchThreshold: number;
  /** If an active pen (pointerType "pen") is ever seen, ignore finger touches entirely. */
  penOnlyWhenPenSeen: boolean;
  showLines: boolean;
  marginSide: 'left' | 'right';
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
}

export const DEFAULT_SETTINGS: Settings = {
  stripHeight: 90,
  touchThreshold: 45,
  penOnlyWhenPenSeen: true,
  showLines: true,
  marginSide: 'left',
  penColor: '#111827',
  penWidth: 3.5,
  highlighterColor: '#fde047',
  highlighterWidth: 22,
};

export interface AppUser {
  id: string;
  email: string | null;
}

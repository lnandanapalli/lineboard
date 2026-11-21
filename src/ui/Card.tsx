import type { ReactNode } from 'react';
import { InfoButton } from './overlays';

/** A card; with `info`, its heading has an ⓘ with what the card is about. */
export function Card({ title, info, children }: { title?: string; info?: string; children?: ReactNode }) {
  return (
    <div className="set-card">
      {title &&
        (info ? (
          <h4 className="with-info">
            <span>{title}</span>
            <InfoButton topic={title} text={info} />
          </h4>
        ) : (
          <h4>{title}</h4>
        ))}
      {children}
    </div>
  );
}

import type { HTMLAttributes } from 'react';

/** One of the app's icons (icons.ts holds them as SVG markup), drawn inside a span. */
export function Icon({ svg, ...rest }: { svg: string } & HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} dangerouslySetInnerHTML={{ __html: svg }} />;
}

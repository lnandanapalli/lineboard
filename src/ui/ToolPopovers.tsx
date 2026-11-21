import { useLayoutEffect, useRef, useState } from 'react';
import type { App } from '../app';
import { PAGE_W, TEXT_FONT } from '../board';
import { LINE_STYLE_NAMES, LINE_STYLES, LINE_WIDTHS, SHAPE_ICONS, SHAPE_NAMES, SHAPES, type LineStyle } from '../shapes';
import { LBD_EXT } from '../lbd';
import { Svg } from './Icon';

/** The size picker for the tool in use: a preview, a slider and quick presets. */
export function SizePicker({ app }: { app: App }) {
  const { tool, cfg, color, name } = app.sizeConfig();
  const [w, setW] = useState(app.toolState().size);
  const preview = useRef<HTMLCanvasElement>(null);
  const set = (v: number) => {
    setW(v);
    app.setSize(v);
  };
  useLayoutEffect(() => {
    const ctx = preview.current?.getContext('2d');
    if (!ctx || !preview.current) return;
    ctx.clearRect(0, 0, preview.current.width, preview.current.height);
    // Same scale as the board, so the preview matches what you will get on this screen.
    const k = (document.querySelector('.canvas-area')?.clientWidth ?? PAGE_W) / PAGE_W;
    ctx.save();
    ctx.scale(2, 2); // drawn at 2x for sharpness
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    if (tool === 'text') {
      ctx.fillStyle = color;
      ctx.font = `${Math.min(40, w * k)}px ${TEXT_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('Aa', 18, 23);
      ctx.restore();
      return;
    }
    ctx.lineWidth = Math.max(0.5, w * k);
    if (tool === 'highlighter') ctx.globalAlpha = 0.38;
    ctx.beginPath();
    ctx.moveTo(18, 30);
    ctx.bezierCurveTo(70, 5, 110, 45, 160, 22);
    ctx.bezierCurveTo(185, 12, 200, 20, 205, 24);
    ctx.stroke();
    ctx.restore();
  }, [w, tool, color]);
  const names = tool === 'shape' ? LINE_WIDTHS.map((x) => x.name) : ['Thin', 'Medium', 'Thick'];
  return (
    <div className="size-picker">
      <canvas ref={preview} className="size-preview" width={440} height={90} aria-hidden="true" />
      <div className="range">
        <input type="range" min={cfg.min} max={cfg.max} step={cfg.step} aria-label={`${name} size`} value={w} onChange={(e) => set(Number(e.target.value))} />
        <output className="size-value">{w}</output>
      </div>
      <div className="size-presets">
        {cfg.presets.map((p, i) => (
          <button key={p} className={'btn' + (p === w ? ' active' : '')} type="button" data-w={p} onClick={() => set(p)}>
            {names[i]}
          </button>
        ))}
      </div>
    </div>
  );
}

const line = (attrs: string) => `<svg viewBox="0 0 32 16" width="32" height="16" aria-hidden="true"><path d="M3 8h26" fill="none" stroke="currentColor" stroke-linecap="round" ${attrs}/></svg>`;
const DASH: Record<LineStyle, string> = { solid: '', dashed: 'stroke-dasharray="6 5"', dotted: 'stroke-dasharray="0 5"' };

function Choices<T>({ label, items, value, pick }: { label: string; items: { value: T; name: string; icon: string }[]; value: T; pick: (v: T) => void }) {
  return (
    <div className="line-choices" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <button key={it.name} className="line-choice" type="button" role="radio" aria-label={it.name} title={it.name} aria-checked={it.value === value} onClick={() => pick(it.value)}>
          <Svg icon={it.icon} />
        </button>
      ))}
    </div>
  );
}

/** The shape palette: a grid of shapes, line style and thickness, and a switch for perfect squares / circles. */
export function ShapePalette({ app, close }: { app: App; close: () => void }) {
  const s = app.shapeSettings();
  const [dash, setDash] = useState(s.dash);
  const [width, setWidth] = useState(s.width);
  const [lock, setLock] = useState(s.lock);
  return (
    <div className="shape-palette">
      <div className="shape-grid" role="radiogroup" aria-label="Shape">
        {SHAPES.map((k) => (
          <button
            key={k}
            className="shape-cell"
            type="button"
            role="radio"
            aria-checked={k === s.shape}
            aria-label={SHAPE_NAMES[k]}
            title={SHAPE_NAMES[k]}
            onClick={() => {
              app.setShape(k);
              close();
            }}
          >
            <Svg icon={SHAPE_ICONS[k]} />
          </button>
        ))}
      </div>
      <div className="line-options">
        <Choices
          label="Line style"
          items={LINE_STYLES.map((v) => ({ value: v, name: LINE_STYLE_NAMES[v], icon: line(`stroke-width="2.4" ${DASH[v]}`) }))}
          value={dash}
          pick={(v) => {
            setDash(v);
            app.setShapeDash(v);
          }}
        />
        <Choices
          label="Thickness"
          items={LINE_WIDTHS.map((x) => ({ value: x.width as number, name: x.name, icon: line(`stroke-width="${Math.min(7, 1 + x.width * 0.6).toFixed(1)}"`) }))}
          value={width}
          pick={(v) => {
            setWidth(v);
            app.setShapeWidth(v);
          }}
        />
      </div>
      <div className="shape-foot">
        <b>Keep proportions</b>
        <button
          className={'switch' + (lock ? ' on' : '')}
          type="button"
          role="switch"
          aria-label="Keep proportions"
          aria-checked={lock}
          onClick={() => {
            setLock(!lock);
            app.setShapeLock(!lock);
          }}
        >
          <i className="knob" />
        </button>
      </div>
    </div>
  );
}

/** The toolbar's export menu: this note shared, as a picture, or as a Lineboard file. */
export function ExportMenu({ app, close }: { app: App; close: () => void }) {
  const item = (label: string, sub: string, fn: () => void) => (
    <button
      className="export-item"
      type="button"
      onClick={() => {
        close();
        fn();
      }}
    >
      <b>{label}</b>
      <small>{sub}</small>
    </button>
  );
  return (
    <div className="export-menu">
      {item('Share…', 'As a PDF, picture or Lineboard file, from your device', () => app.shareCurrent())}
      {item('Picture (.png)', 'This page as an image', () => void app.exportPNG())}
      {item(`Lineboard file (${LBD_EXT})`, 'This note, to keep or import elsewhere', () => app.exportCurrent())}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { t } from '../i18n';
import { BANDS, PRESETS, RANGE, presetOf, setEq, useEq } from '../lib/eq';
import { Item } from './Menu';
import { Sheet, Switch } from './ui';

const hz = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);
const db = (g: number) => `${g > 0 ? '+' : ''}${g} dB`;

// The graph: frequency across (log, 30 Hz to 18 kHz), level up and down (±RANGE dB).
const W = 340;
const H = 150;
const PAD_X = 22;
const PAD_Y = 18;
const LOW = 30;
const HIGH = 18000;
const x = (f: number) => PAD_X + (Math.log(f / LOW) / Math.log(HIGH / LOW)) * (W - 2 * PAD_X);
const y = (g: number) => H / 2 - (g / RANGE) * (H / 2 - PAD_Y);

/** A smooth line through the points (Catmull-Rom as curves), level at both ends. */
function curve(gains: number[]) {
  const pts: [number, number][] = [[PAD_X - 6, y(gains[0])], ...BANDS.map((f, i) => [x(f), y(gains[i])] as [number, number]), [W - PAD_X + 6, y(gains[gains.length - 1])]];
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1] ?? pts[i], pts[i], pts[i + 1], pts[i + 2] ?? pts[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** The six bands as points on a curve: drag one up or down, or use the arrow keys on it. */
function EqGraph({ gains, on }: { gains: number[]; on: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number>();
  /** The band being dragged, at once (the moves come before the next render). */
  const dragging = useRef<number>(undefined);
  const set = (i: number, g: number) => {
    const next = Math.max(-RANGE, Math.min(RANGE, Math.round(g * 2) / 2));
    if (next !== gains[i]) setEq({ gains: gains.map((v, j) => (j === i ? next : v)) });
  };
  const fromPointer = (i: number, clientY: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const at = ((clientY - r.top) / r.height) * H;
    set(i, ((H / 2 - at) / (H / 2 - PAD_Y)) * RANGE);
  };
  const line = curve(on ? gains : gains.map(() => 0));
  return (
    <svg ref={svg} className="eq__graph" viewBox={`0 0 ${W} ${H + 20}`} role="group" aria-label={t('Equalizer')}>
      <defs>
        <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9b7bff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#7c4dff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="eq-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#dccbff" />
          <stop offset="1" stopColor="#7c4dff" />
        </linearGradient>
      </defs>
      {[RANGE, RANGE / 2, -RANGE / 2, -RANGE].map((g) => (
        <line key={g} className="eq__grid" x1={PAD_X} x2={W - PAD_X} y1={y(g)} y2={y(g)} />
      ))}
      <line className="eq__zero" x1={PAD_X} x2={W - PAD_X} y1={y(0)} y2={y(0)} />
      <path className="eq__fill" d={`${line} L${W - PAD_X + 6},${H} L${PAD_X - 6},${H} Z`} />
      <path className="eq__line" d={line} />
      {BANDS.map((f, i) => (
        <g key={f} className={`eq__point ${active === i ? 'is-active' : ''}`}>
          <text className="eq__hz" x={x(f)} y={H + 14}>
            {hz(f)}
          </text>
          {on && (
            <>
              {active === i && (
                <text className="eq__db" x={x(f)} y={Math.max(12, y(gains[i]) - 14)}>
                  {db(gains[i])}
                </text>
              )}
              <circle className="eq__dot" cx={x(f)} cy={y(gains[i])} r={active === i ? 8 : 6.5} />
              <circle
                className="eq__hit"
                cx={x(f)}
                cy={y(gains[i])}
                r={18}
                tabIndex={0}
                role="slider"
                aria-label={`${hz(f)}Hz`}
                aria-valuemin={-RANGE}
                aria-valuemax={RANGE}
                aria-valuenow={gains[i]}
                aria-valuetext={db(gains[i])}
                onPointerDown={(e) => {
                  e.preventDefault();
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    /* the pointer's already gone */
                  }
                  dragging.current = i;
                  setActive(i);
                }}
                onPointerMove={(e) => dragging.current === i && fromPointer(i, e.clientY)}
                onPointerUp={() => ((dragging.current = undefined), setActive(undefined))}
                onPointerCancel={() => ((dragging.current = undefined), setActive(undefined))}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(undefined)}
                onKeyDown={(e) => {
                  const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
                  if (step !== undefined) set(i, gains[i] + step);
                  else if (e.key === 'Home') set(i, 0);
                  else return;
                  e.preventDefault();
                }}
              />
            </>
          )}
        </g>
      ))}
    </svg>
  );
}

/** The equalizer on this device: on or off, a preset, and the six bands as a curve. */
export function EqualizerControls({ inSheet }: { inSheet?: boolean }) {
  const eq = useEq();
  const preset = presetOf(eq.gains);
  return (
    <div className={`eq ${eq.on ? '' : 'eq--off'}`}>
      <div className="eq__head">
        <span>{inSheet ? t('On') : t('Equalizer')}</span>
        <Switch on={eq.on} onChange={(on) => setEq({ on })} label={t('Equalizer')} />
      </div>
      <EqGraph gains={eq.gains} on={eq.on} />
      <select className="input" value={preset?.id ?? 'custom'} disabled={!eq.on} onChange={(e) => setEq({ gains: PRESETS.find((p) => p.id === e.target.value)?.gains ?? eq.gains })}>
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label()}
          </option>
        ))}
        {!preset && <option value="custom">{t('Custom')}</option>}
      </select>
    </div>
  );
}

let openSheet: ((open: boolean) => void) | undefined;

/** In the player's menu. */
export const EqualizerItem = () => (
  <Item icon={<SlidersHorizontal size={18} />} onClick={() => openSheet?.(true)}>
    {t('Equalizer')}
  </Item>
);

export function EqualizerSheetHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openSheet = setOpen;
    return () => void (openSheet = undefined);
  }, []);
  if (!open) return null;
  return (
    <Sheet title={t('Equalizer')} onClose={() => setOpen(false)}>
      <EqualizerControls inSheet />
    </Sheet>
  );
}

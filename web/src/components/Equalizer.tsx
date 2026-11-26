import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { t } from '../i18n';
import { BANDS, PRESETS, RANGE, presetOf, setEq, useEq } from '../lib/eq';
import { Item } from './Menu';
import { Sheet, Switch } from './ui';

const hz = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
const db = (g: number) => `${g > 0 ? '+' : ''}${g} dB`;

/** The equalizer on this device: on or off, a preset, and the six bands. */
export function EqualizerControls({ inSheet }: { inSheet?: boolean }) {
  const eq = useEq();
  const preset = presetOf(eq.gains);
  return (
    <div className={`eq ${eq.on ? '' : 'eq--off'}`}>
      <div className="eq__head">
        <span>{inSheet ? t('On') : t('Equalizer')}</span>
        <Switch on={eq.on} onChange={(on) => setEq({ on })} label={t('Equalizer')} />
      </div>
      <select className="input" value={preset?.id ?? 'custom'} disabled={!eq.on} onChange={(e) => setEq({ gains: PRESETS.find((p) => p.id === e.target.value)?.gains ?? eq.gains })}>
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label()}
          </option>
        ))}
        {!preset && <option value="custom">{t('Custom')}</option>}
      </select>
      <div className="eq__bands">
        {BANDS.map((f, i) => (
          <label className="eq__band" key={f}>
            <span>{hz(f)}</span>
            <input
              type="range"
              min={-RANGE}
              max={RANGE}
              step={0.5}
              value={eq.gains[i]}
              disabled={!eq.on}
              aria-label={hz(f)}
              onChange={(e) => setEq({ gains: eq.gains.map((g, j) => (j === i ? Number(e.target.value) : g)) })}
            />
            <b>{db(eq.gains[i])}</b>
          </label>
        ))}
      </div>
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

import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { t, tn } from '../i18n';
import { setSleep, usePlayer } from '../lib/player';
import { Item } from './Menu';
import { Sheet, toast } from './ui';

let openSheet: ((open: boolean) => void) | undefined;

/** In the player's menu. */
export function SleepItem() {
  const on = usePlayer((s) => Boolean(s.sleep));
  return (
    <Item icon={<Moon size={18} />} onClick={() => openSheet?.(true)}>
      {on ? t('Sleep timer is on') : t('Sleep timer')}
    </Item>
  );
}

const minutesLeft = (at: number) => Math.max(1, Math.ceil((at - Date.now()) / 60_000));

/** While it's on: how long is left. Opens the choices. */
export function SleepChip() {
  const sleep = usePlayer((s) => s.sleep);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sleep?.at) return;
    const timer = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(timer);
  }, [sleep?.at]);
  if (!sleep) return null;
  return (
    <button className="together-chip" onClick={(e) => (e.stopPropagation(), openSheet?.(true))}>
      <Moon size={14} /> {sleep.at ? t('{n} min', { n: minutesLeft(sleep.at) }) : t('End of song')}
    </button>
  );
}

const CHOICES = [15, 30, 45, 60];

export function SleepSheetHost() {
  const [open, setOpen] = useState(false);
  const sleep = usePlayer((s) => s.sleep);
  useEffect(() => {
    openSheet = setOpen;
    return () => void (openSheet = undefined);
  }, []);
  if (!open) return null;
  const close = () => setOpen(false);
  const choose = (pick: { minutes?: number; endOfSong?: boolean } | undefined) => {
    setSleep(pick);
    toast(pick?.minutes ? t('Music stops in {n} min', { n: pick.minutes }) : pick?.endOfSong ? t('Music stops after this song') : t('Sleep timer off'));
    close();
  };
  return (
    <Sheet title={t('Sleep timer')} onClose={close}>
      <div className="choices">
        {CHOICES.map((m) => (
          <button key={m} className="choice" onClick={() => choose({ minutes: m })}>
            {m === 60 ? t('1 hour') : tn(m, '{n} minute', '{n} minutes')}
          </button>
        ))}
        <button className={`choice ${sleep?.endOfSong ? 'on' : ''}`} onClick={() => choose({ endOfSong: true })}>
          {t('End of this song')}
        </button>
        {sleep && (
          <button className="choice choice--off" onClick={() => choose(undefined)}>
            {t('Turn off')}
          </button>
        )}
      </div>
    </Sheet>
  );
}

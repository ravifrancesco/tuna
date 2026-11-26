import { Globe, Laptop, Pause, Smartphone, Tablet, Tv } from 'lucide-react';
import type { Device } from '@tuna/shared';
import { t } from '../i18n';
import { control, deviceId, others, playOn, useDevices } from '../lib/devices';
import { usePlayer } from '../lib/player';

const ICONS: Record<Device['kind'], typeof Laptop> = { phone: Smartphone, tablet: Tablet, computer: Laptop, tv: Tv, browser: Globe };
export const DeviceIcon = ({ kind, size = 18 }: { kind: Device['kind']; size?: number }) => {
  const Icon = ICONS[kind] ?? Globe;
  return <Icon size={size} />;
};

/** Music playing on another of your devices, while this one isn't: what, where, pause, and Play here. */
export function DevicesBar() {
  const list = useDevices();
  const playingHere = usePlayer((s) => s.playing);
  const there = others(list).find((d) => d.playing);
  if (!there || playingHere) return null;
  return (
    <div className="devices-bar" role="status">
      <DeviceIcon kind={there.kind} size={16} />
      <span className="devices-bar__text">
        <b>{t('Playing on {name}', { name: there.name })}</b>
        {there.track && <span>{` · ${there.track.title} · ${there.track.artist}`}</span>}
      </span>
      <button className="icon-btn" aria-label={t('Pause')} onClick={() => void control(there.id, { type: 'pause' })}>
        <Pause size={16} fill="currentColor" />
      </button>
      <button className="btn btn--small" onClick={() => void playOn(deviceId)}>
        {t('Play here')}
      </button>
    </div>
  );
}

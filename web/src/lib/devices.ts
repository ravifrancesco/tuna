import { useSyncExternalStore } from 'react';
import type { Device, DeviceCommand, DevicesEvent, Track } from '@tuna/shared';
import { api } from '../api';
import { t } from '../i18n';
import { hello } from './native';
import { follow, getPlayer, next, onPlayer, pause, play, previous, seek, type Source } from './player';
import { getMe } from './session';

/**
 * This tab (or app) as one of the account's devices, as Spotify Connect (server/src/services/
 * devices.ts): it says what it's playing, shows what the others are playing, does what they ask,
 * and can take the music over or hand it on.
 */

/** Kept for the tab: two tabs are two devices, a reload is the same one. */
export const deviceId = (() => {
  const key = 'tuna.device';
  try {
    const kept = sessionStorage.getItem(key);
    if (kept) return kept;
    const made = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(key, made);
    return made;
  } catch {
    return Math.random().toString(36).slice(2);
  }
})();

function describe(): { name: string; kind: Device['kind'] } {
  const ua = navigator.userAgent;
  switch (hello?.platform) {
    case 'ios':
      return /iPad/.test(ua) ? { name: 'iPad', kind: 'tablet' } : { name: 'iPhone', kind: 'phone' };
    case 'mac':
      return { name: 'Mac', kind: 'computer' };
    case 'windows':
      return { name: 'Windows', kind: 'computer' };
    case 'android':
      return { name: 'Android', kind: 'phone' };
    case 'androidtv':
    case 'tizen':
      return { name: t('TV'), kind: 'tv' };
  }
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : t('Browser');
  return { name, kind: 'browser' };
}

let devices: Device[] = [];
const listeners = new Set<() => void>();
export const useDevices = () =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => devices,
  );
/** The other devices on this account. */
export const others = (list: Device[]) => list.filter((d) => d.id !== deviceId);

function obey(c: DeviceCommand) {
  if (c.type === 'play') play();
  else if (c.type === 'pause') pause();
  else if (c.type === 'next') next();
  else if (c.type === 'previous') previous();
  else if (c.type === 'seek') seek(c.position);
  else if (c.type === 'take') follow(c.queue, c.index, c.position, c.playing, c.source as Source | undefined);
}

let line: EventSource | undefined;
function connect() {
  const key = getMe()?.mediaKey;
  const { name, kind } = describe();
  line = new EventSource(`/api/devices/events?device=${deviceId}&name=${encodeURIComponent(name)}&kind=${kind}${key ? `&k=${key}` : ''}`);
  line.onmessage = (m) => {
    const e = JSON.parse(m.data) as DevicesEvent;
    if (e.devices) {
      devices = e.devices;
      listeners.forEach((fn) => fn());
    }
    if (e.command) obey(e.command);
  };
  line.onopen = () => report(true);
  // EventSource comes back by itself; one that gave up is started again.
  line.onerror = () => window.setTimeout(() => line?.readyState === EventSource.CLOSED && connect(), 3000);
}

// What this one plays, as it changes; where it is in the song now and then while it plays.
let sentQueue = '';
let sentKey = '';
let timer: number | undefined;
function report(all = false) {
  if (!line) return;
  const s = getPlayer();
  const ids = s.queue.map((x) => x.id).join(',');
  const queue: Track[] | undefined = all || ids !== sentQueue ? s.queue : undefined;
  sentQueue = ids;
  sentKey = `${s.playing}|${s.index}|${ids}`;
  void api.devices.state({ device: deviceId, playing: s.playing, index: s.index, position: s.time, queue, source: s.source }).catch(() => undefined);
}

/** Starts once someone's signed in. */
export function startDevices() {
  if (line) return;
  connect();
  onPlayer(() => {
    const s = getPlayer();
    const key = `${s.playing}|${s.index}|${s.queue.map((x) => x.id).join(',')}`;
    if (key === sentKey) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => report(), 300);
  });
  window.setInterval(() => getPlayer().playing && report(), 15_000);
}

/** The music moves to a device (this one, or another). */
export const playOn = (id: string) => api.devices.transfer(id);
/** Play, pause or skip on the device that's playing. */
export const control = (id: string, command: DeviceCommand) => api.devices.command(id, command);

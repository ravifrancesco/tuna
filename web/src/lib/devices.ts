import { useSyncExternalStore } from 'react';
import type { Device, DeviceCommand, DevicesEvent, Track } from '@tuna/shared';
import { api } from '../api';
import { t } from '../i18n';
import { hello } from './native';
import { follow, getPlayer, next, onPlayer, pause, play, previous, seek, toggle, type PlayerState, type Source } from './player';
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
/** The server's clock less this one's, to tell where another device's song is now. */
let skew = 0;
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

function changed(list: Device[]) {
  devices = list;
  listeners.forEach((fn) => fn());
  refresh();
}

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
    skew = e.now - Date.now();
    if (e.devices) changed(e.devices);
    if (e.command) obey(e.command);
  };
  line.onopen = () => report(true);
  // EventSource comes back by itself; one that gave up is started again.
  line.onerror = () => window.setTimeout(() => line?.readyState === EventSource.CLOSED && connect(), 3000);
}

// What this one plays, as it changes; where it is in the song now and then while it plays, and
// whenever it jumps (a seek), so the others keep up.
let sentQueue = '';
let sentKey = '';
let sent = { time: 0, at: 0, playing: false };
let timer: number | undefined;
function report(all = false) {
  if (!line) return;
  const s = getPlayer();
  const ids = s.queue.map((x) => x.id).join(',');
  const queue: Track[] | undefined = all || ids !== sentQueue ? s.queue : undefined;
  sentQueue = ids;
  sentKey = `${s.playing}|${s.index}|${ids}`;
  sent = { time: s.time, at: Date.now(), playing: s.playing };
  void api.devices.state({ device: deviceId, playing: s.playing, index: s.index, position: s.time, queue, source: s.source }).catch(() => undefined);
}

/** Starts once someone's signed in. */
export function startDevices() {
  if (line) return;
  connect();
  onPlayer(() => {
    const s = getPlayer();
    const key = `${s.playing}|${s.index}|${s.queue.map((x) => x.id).join(',')}`;
    const expected = sent.time + (sent.playing ? (Date.now() - sent.at) / 1000 : 0);
    if (key === sentKey && Math.abs(s.time - expected) < 3) return;
    // Once, a moment after the first change, with everything that changed meanwhile (the song's
    // time moves every quarter second: waiting for it to settle would wait forever).
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      report();
    }, 300);
  });
  window.setInterval(() => getPlayer().playing && report(), 15_000);
}

/** The music moves to a device (this one, or another). */
export const playOn = (id: string) => api.devices.transfer(id);
/** Play, pause or skip on the device that's playing. */
export const control = (id: string, command: DeviceCommand) => api.devices.command(id, command);

// ---- What the player shows ---------------------------------------------------------------------------

/**
 * The player shows this device's music, or, while nothing plays here, the music on another of your
 * devices (the one playing, else the one that played last), as Spotify does: its song as a queue,
 * where it is now, and its controls acting on that device.
 */
interface View {
  state: PlayerState;
  remote?: Device;
}
let view: View = { state: getPlayer() };
const viewers = new Set<() => void>();
let ticker: number | undefined;

function shownDevice(): Device | undefined {
  if (getPlayer().playing) return undefined;
  const last = devices.filter((d) => d.track && (d.playing || d.played)).sort((a, b) => Number(b.playing) - Number(a.playing) || (b.played ?? 0) - (a.played ?? 0))[0];
  return last && last.id !== deviceId ? last : undefined;
}

/** Where the other device's song is now: where it said, and on from there while it plays. */
const timeOf = (d: Device) => {
  const end = d.track?.duration || Infinity;
  return Math.max(0, Math.min(end, d.position + (d.playing ? (Date.now() + skew - d.at) / 1000 : 0)));
};

function refresh() {
  const local = getPlayer();
  const remote = shownDevice();
  const before = view;
  if (!remote?.track) {
    if (view.remote || view.state !== local) view = { state: local };
  } else {
    const queue = view.remote === remote ? view.state.queue : [remote.track, ...(remote.next ?? [])];
    const source = remote.from ? { kind: 'queue' as const, title: remote.from } : undefined;
    view = {
      remote,
      state: { ...local, queue, index: 0, playing: remote.playing, buffering: false, time: timeOf(remote), duration: remote.track.duration || 0, shuffle: false, repeat: 'off', source, error: undefined, output: undefined, sleep: undefined },
    };
  }
  // Its song moves on by itself, a second at a time.
  if (view.remote?.playing && !ticker) ticker = window.setInterval(refresh, 1000);
  if (!view.remote?.playing && ticker) (window.clearInterval(ticker), (ticker = undefined));
  if (view !== before) viewers.forEach((fn) => fn());
}
onPlayer(refresh);

const watchView = (fn: () => void) => {
  viewers.add(fn);
  return () => void viewers.delete(fn);
};
/** The player as shown: like usePlayer, but another device's music while that's what's shown. */
export const useShown = <T>(select: (s: PlayerState) => T): T => useSyncExternalStore(watchView, () => select(view.state));
/** The device shown instead of this one, if any. */
export const useRemote = () => useSyncExternalStore(watchView, () => view.remote);
export const getShown = () => view.state;

/** The other device as it will be once it has done what it was asked (it says so a moment later). */
function expect(d: Device, patch: Partial<Device>) {
  changed(devices.map((x) => (x.id === d.id ? { ...x, position: timeOf(x), at: Date.now() + skew, ...patch } : x)));
}

/** The controls: on the device shown. */
export function toggleShown() {
  const d = view.remote;
  if (!d) return toggle();
  void control(d.id, { type: d.playing ? 'pause' : 'play' });
  expect(d, { playing: !d.playing, played: Date.now() + skew });
}
export const nextShown = () => (view.remote ? void control(view.remote.id, { type: 'next' }) : next());
export const previousShown = () => (view.remote ? void control(view.remote.id, { type: 'previous' }) : previous());
export function seekShown(position: number) {
  const d = view.remote;
  if (!d) return seek(position);
  void control(d.id, { type: 'seek', position });
  expect(d, { position });
}

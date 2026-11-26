import type { NativeAudioState, NativeDownload, NativeTrack } from '@tuna/shared';

/**
 * What the Tuna apps add to the interface (Mac, Windows, iPhone/iPad, Android and Android TV).
 * Absent in a browser and on Samsung TVs, where the page plays the music itself.
 *
 * One way of talking for every app (docs/native-bridge.md):
 *   - before the page's scripts run, the app sets `window.tunaHello` = { platform, version, formats, features }
 *     (Android: `TunaAndroid.hello()` returns it as JSON);
 *   - the page sends { cmd, args, id? } with `TunaAndroid.post(json)`, `webkit.messageHandlers.tuna.postMessage(obj)`
 *     or `chrome.webview.postMessage(obj)`;
 *   - the app answers and reports by calling `window.__tuna(message)`: { type: 'reply', id, value },
 *     { type: 'audio', state } or { type: 'event', name, value }.
 */

export interface Hello {
  platform: 'mac' | 'windows' | 'ios' | 'android' | 'androidtv' | string;
  version: string;
  /** File formats the app's player plays as they are ("mp3", "aac", "m4a", "flac", "alac", "wav", "opus", "ogg"). */
  formats: string[];
  /** What else the app can do: audio, outputs, tunnel, update, keepAwake, mobileData, changeServer, downloads, sleep, haptics, cast. */
  features: string[];
}

export interface TunnelStatus {
  configured?: boolean;
  active?: boolean;
  problem?: string;
}

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  canInstall: boolean;
  page?: string;
}

type Message = { type: 'reply'; id: number; value: unknown } | { type: 'audio'; state: NativeAudioState } | { type: 'event'; name: string; value: unknown };

interface Window2 {
  tunaHello?: Hello;
  TunaAndroid?: { hello(): string; post(json: string): void };
  webkit?: { messageHandlers?: { tuna?: { postMessage(msg: unknown): void } } };
  chrome?: { webview?: { postMessage(msg: unknown): void; addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void } };
  __tuna?: (msg: Message | string) => void;
}
const w = window as unknown as Window2;

function readHello(): Hello | undefined {
  if (w.tunaHello) return w.tunaHello;
  try {
    const raw = w.TunaAndroid?.hello();
    return raw ? (JSON.parse(raw) as Hello) : undefined;
  } catch {
    return undefined;
  }
}

export const hello: Hello | undefined = readHello();
export const isApp = Boolean(hello);
export const isTV = /^(androidtv|tizen)$/.test(hello?.platform ?? '') || /Tizen|SMART-TV|Web0S|AFT[A-Z]|Android TV|BRAVIA/i.test(navigator.userAgent);
export const has = (feature: string) => Boolean(hello?.features.includes(feature));

function post(msg: { cmd: string; args?: unknown; id?: number }) {
  if (w.TunaAndroid) w.TunaAndroid.post(JSON.stringify(msg));
  else if (w.webkit?.messageHandlers?.tuna) w.webkit.messageHandlers.tuna.postMessage(msg);
  else if (w.chrome?.webview) w.chrome.webview.postMessage(msg);
}

let nextId = 1;
const waiting = new Map<number, (value: unknown) => void>();
const audioListeners = new Set<(s: NativeAudioState) => void>();
const eventListeners = new Set<(name: string, value: unknown) => void>();
let lastAudio: NativeAudioState | undefined;

function receive(raw: Message | string) {
  const msg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Message;
  if (msg.type === 'reply') {
    waiting.get(msg.id)?.(msg.value);
    waiting.delete(msg.id);
  } else if (msg.type === 'audio') {
    lastAudio = msg.state;
    audioListeners.forEach((fn) => fn(msg.state));
  } else if (msg.type === 'event') {
    eventListeners.forEach((fn) => fn(msg.name, msg.value));
  }
}

if (isApp) {
  w.__tuna = receive;
  w.chrome?.webview?.addEventListener('message', (e) => {
    const data = e.data as Message | string;
    if (data && (typeof data === 'string' || 'type' in data)) receive(data);
  });
}

/**
 * The system's Back (Android's button, a TV remote): close what's open on top, else go back a
 * page. False on Home with nothing open, so the app can leave.
 */
(window as unknown as { tunaBack?: () => boolean }).tunaBack = () => {
  const close = document.querySelector<HTMLElement>('[data-layer="top"] [data-close]');
  if (close) {
    close.click();
    return true;
  }
  if (location.pathname !== '/') {
    history.back();
    return true;
  }
  return false;
};

export function send(cmd: string, args?: unknown) {
  post({ cmd, args });
}

export function ask<T>(cmd: string, args?: unknown, timeoutMs = 15000): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${cmd}: no answer`));
    }, timeoutMs);
    waiting.set(id, (value) => {
      clearTimeout(timer);
      resolve(value as T);
    });
    post({ cmd, args, id });
  });
}

export const onEvent = (fn: (name: string, value: unknown) => void) => {
  eventListeners.add(fn);
  return () => void eventListeners.delete(fn);
};

/** The app's own player: the queue lives in the app, so music keeps playing with the screen off. */
export const nativeAudio = has('audio')
  ? {
      formats: hello!.formats,
      load: (tracks: NativeTrack[], index: number, start: number, play: boolean) => send('audio.load', { tracks, index, start, play }),
      /** A new queue around the song that's playing, which carries on without a gap. */
      update: (tracks: NativeTrack[], index: number) => send('audio.update', { tracks, index }),
      command: (name: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek' | 'jump' | 'stop' | 'repeat' | 'volume', value?: number | string) =>
        send('audio.command', { name, value }),
      onState: (fn: (s: NativeAudioState) => void) => {
        audioListeners.add(fn);
        return () => void audioListeners.delete(fn);
      },
      last: () => lastAudio,
      /** A song liked or unliked here, so the app's own heart (Android's lock screen) agrees. */
      liked: (id: string, liked: boolean) => send('audio.liked', { id, liked }),
      /** The system's list of speakers and headphones (AirPlay, Bluetooth), from the page's button (`at`). */
      outputs: has('outputs')
        ? (at?: DOMRect) => send('audio.outputs', at && { x: at.x, y: at.y, width: at.width, height: at.height })
        : undefined,
      /** The app keeps the sleep timer (so it stops with the screen off): minutes, end of the song, or off. */
      sleep: has('sleep') ? (t: { minutes?: number; endOfSong?: boolean }) => send('audio.sleep', t) : undefined,
      /** What the app is playing (after the page reloads while music plays on). */
      current: () => ask<{ tracks: NativeTrack[]; index: number; state: NativeAudioState } | null>('audio.current', undefined, 3000).catch(() => null),
    }
  : undefined;

export const app = {
  changeServer: () => send('changeServer'),
  /** A short vibration (phones). */
  haptic: has('haptics') ? (style: 'light' | 'success') => send('app.haptic', { style }) : undefined,
  keepAwake: (on: boolean) => has('keepAwake') && send('keepAwake', { on }),
  mobileData: (): Promise<boolean> => (has('mobileData') ? ask<boolean>('mobileData', undefined, 2000).catch(() => false) : Promise.resolve(false)),
  tunnel: has('tunnel')
    ? {
        status: () => ask<TunnelStatus>('tunnel.status'),
        save: (config: string) => ask<string>('tunnel.save', { config }, 30000),
        remove: () => ask<void>('tunnel.remove'),
      }
    : undefined,
  downloads: has('downloads')
    ? {
        add: (d: Pick<NativeDownload, 'id' | 'kind' | 'title' | 'subtitle' | 'cover' | 'tracks'>) => send('downloads.add', d),
        remove: (id: string) => send('downloads.remove', { id }),
        clear: () => send('downloads.clear'),
        list: () => ask<NativeDownload[]>('downloads.list', undefined, 5000).catch(() => [] as NativeDownload[]),
        /** The server can't be reached: the app's own page with what's downloaded. */
        offline: () => send('downloads.offline'),
      }
    : undefined,
  update: has('update')
    ? {
        check: () => ask<UpdateStatus>('update.check', undefined, 30000),
        install: () => send('update.install'),
      }
    : undefined,
};

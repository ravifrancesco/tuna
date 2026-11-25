import { useSyncExternalStore } from 'react';
import type { NativeDownload, Track } from '@tuna/shared';
import { api } from '../api';
import { app, nativeAudio, onEvent } from './native';
import { getPlayer, nativeTrack } from './player';
import { coverUrl, getMe } from './session';

/**
 * Downloads (the apps): albums, playlists, Liked songs and songs kept on the device, as in Netfish.
 * The app keeps the files and plays them instead of the server's whenever it can, so they play
 * with no connection at all. This is the page's side: what's downloaded, and asking for more.
 */

let list: NativeDownload[] = [];
let ready = new Set<string>();
const listeners = new Set<() => void>();
function set(next: NativeDownload[]) {
  list = next ?? [];
  ready = new Set(list.flatMap((d) => d.ready));
  listeners.forEach((fn) => fn());
}
if (app.downloads) {
  void app.downloads.list().then((found) => {
    set(found);
    // What hasn't finished carries on with this session's key (the one it was asked with may be gone).
    for (const d of found) if (d.state !== 'done') app.downloads?.add({ ...d, cover: rekey(d.cover), tracks: d.tracks.map((x) => ({ ...x, url: rekey(x.url)!, artwork: rekey(x.artwork) })) });
  });
  onEvent((name, value) => name === 'downloads' && set(value as NativeDownload[]));
}

// No connection at all (airplane mode): straight to the app's page with what's downloaded.
if (app.downloads) window.addEventListener('offline', () => list.length && app.downloads?.offline());

/** An address kept with a download, with this session's key (the one it was made with may be gone). */
export const rekey = (url: string | undefined) => {
  const key = getMe()?.mediaKey;
  return url && key ? url.replace(/([?&]k=)[^&]*/, `$1${key}`) : url;
};

// Songs played from the device never reach the server: once half of one has played, say so.
let playing: { id: string; furthest: number; duration: number } | undefined;
const counted = () => {
  if (playing && ready.has(playing.id) && playing.duration > 0 && playing.furthest >= playing.duration / 2) void api.played(playing.id).catch(() => {});
  playing = undefined;
};
nativeAudio?.onState((s) => {
  const t = getPlayer().queue[s.index];
  if (!t) return;
  if (playing?.id !== t.id) {
    counted();
    playing = { id: t.id, furthest: 0, duration: s.duration || t.duration };
  }
  playing.furthest = Math.max(playing.furthest, s.time);
  if (s.ended) counted();
});

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const canDownload = Boolean(app.downloads);
export const useDownloads = () => useSyncExternalStore(subscribe, () => list);
export const useDownload = (id: string) => useSyncExternalStore(subscribe, () => list.find((d) => d.id === id));
export const useOnDevice = (trackId: string) => useSyncExternalStore(subscribe, () => ready.has(trackId));

/** Downloads are High (or Original for who chose Original), whatever's playing now. */
const level = () => (getMe()?.prefs.quality === 'original' ? 'original' : 'high');

export function download(d: { id: string; kind: NativeDownload['kind']; title: string; subtitle?: string; cover?: string; tracks: Track[] }) {
  // dl=1: fetching a song to keep isn't playing it.
  const tracks = d.tracks.map((t) => nativeTrack(t, level())).map((x) => ({ ...x, url: `${x.url}&dl=1` }));
  app.downloads?.add({ id: d.id, kind: d.kind, title: d.title, subtitle: d.subtitle, cover: coverUrl(d.cover, 600), tracks });
}
export const removeDownload = (id: string) => app.downloads?.remove(id);
export const clearDownloads = () => app.downloads?.clear();

/** Bytes on the device, each song once though downloads share songs (an album and Liked songs). */
export function usage(list: NativeDownload[]): number {
  const seen = new Set<string>();
  let bytes = 0;
  for (const d of list) {
    const each = d.ready.length ? d.bytes / d.ready.length : 0;
    for (const id of d.ready) if (!seen.has(id)) seen.add(id), (bytes += each);
  }
  return Math.round(bytes);
}

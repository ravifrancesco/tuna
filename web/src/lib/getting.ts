import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { GetState } from '@tuna/shared';
import { api } from '../api';

/**
 * Where everything asked for is at, for every Get button on screen at once: one look every few
 * seconds, only while one of them is waiting on something. (Each looking for itself was hundreds
 * of requests a minute on a long playlist.) A state stays the same object until it changes, so only
 * the buttons whose song moved draw again.
 */
const states = new Map<string, GetState>();
/** Which look last saw each (a button trusts only looks after it started watching). */
const seen = new Map<string, number>();
let round = 0;
const listeners = new Set<() => void>();
let watching = 0;
let timer: number | undefined;

/** A song by its names, or anything (an album, or a song on On its way) by its id. */
export const songKey = (title: string, artist: string) => `song|${title}|${artist}`;
export const idKey = (mbid: string) => `id|${mbid}`;

async function look() {
  const now = await api.moving().catch(() => undefined);
  if (!now) return;
  round++;
  const put = (key: string, get: GetState) => {
    seen.set(key, round);
    if (JSON.stringify(states.get(key)) !== JSON.stringify(get)) states.set(key, get);
  };
  for (const s of now.songs) {
    put(idKey(s.id), s.get);
    put(songKey(s.title, s.artist), s.get);
  }
  for (const a of now.albums) put(idKey(a.mbid), a.get);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const nothing = () => () => undefined;

/** Looking every few seconds while anyone on screen is watching. */
function useWatching(on: boolean) {
  useEffect(() => {
    if (!on) return;
    if (watching++ === 0) {
      void look();
      timer = window.setInterval(() => void look(), 5000);
    }
    return () => {
      if (--watching === 0) window.clearInterval(timer);
    };
  }, [on]);
}

/** Where one thing asked for is at, while `key` is given (it's on its way); looked at with everything else on screen. */
export function useGetState(key: string | undefined): GetState | undefined {
  useWatching(Boolean(key));
  const since = useMemo(() => round, [key]);
  return useSyncExternalStore(key ? subscribe : nothing, () => (key && (seen.get(key) ?? 0) > since ? states.get(key) : undefined));
}

/** Where several things are at (a playlist's songs, say), while `on`: each as last seen since then. */
export function useGetStates(keys: string[], on: boolean): (key: string) => GetState | undefined {
  useWatching(on);
  const since = useMemo(() => round, [on]);
  useSyncExternalStore(on ? subscribe : nothing, () => round);
  return (key) => (on && (seen.get(key) ?? 0) > since ? states.get(key) : undefined);
}

let soon: number | undefined;
/** Something arrived: the page shows it, once for everything that arrived together. */
export function arrivedSoon(refresh: () => void) {
  if (soon) return;
  soon = window.setTimeout(() => {
    soon = undefined;
    refresh();
  }, 800);
}

import { useSyncExternalStore } from 'react';
import type { Me } from '@tuna/shared';

/** Who's signed in on this device: set once at start and after signing in. */

let me: Me | undefined;
const listeners = new Set<() => void>();

export function setMe(next: Me | undefined) {
  me = next;
  listeners.forEach((fn) => fn());
}

export const getMe = () => me;

export function useMe(): Me | undefined {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => me,
  );
}

const withKey = (path: string, extra: Record<string, string | number> = {}) => {
  const params = new URLSearchParams(Object.entries(extra).map(([k, v]) => [k, String(v)]));
  if (me?.mediaKey) params.set('k', me.mediaKey);
  return `${location.origin}${path}?${params.toString()}`;
};

/** A cover from the library. */
export const coverUrl = (cover: string | undefined, size = 300) => (cover ? withKey(`/api/cover/${encodeURIComponent(cover)}`, { s: size }) : undefined);

/** A cover of music that isn't in the library yet (Cover Art Archive, through Tuna). */
export const artUrl = (url: string | undefined) => (url ? withKey('/api/art', { u: url }) : undefined);

export const streamUrl = (id: string, format: string, bitRate?: number) =>
  withKey(`/api/stream/${encodeURIComponent(id)}`, { f: format, ...(bitRate ? { br: bitRate } : {}) });

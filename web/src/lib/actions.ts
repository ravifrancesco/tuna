import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Track } from '@tuna/shared';
import { api } from '../api';
import { onEvent, nativeAudio } from './native';
import { patchTrack } from './player';

/** Liking songs, albums and artists, everywhere at once. */

const likedNow = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function useLiked(kind: 'track' | 'album' | 'artist', id: string | undefined, initial?: boolean): [boolean, () => void] {
  const qc = useQueryClient();
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
  const key = `${kind}:${id}`;
  const on = likedNow.get(key) ?? Boolean(initial);
  const toggle = () => {
    if (!id) return;
    const next = !on;
    likedNow.set(key, next);
    listeners.forEach((fn) => fn());
    if (kind === 'track') {
      patchTrack(id, { liked: next });
      nativeAudio?.liked(id, next);
    }
    void api
      .like(kind, id, next)
      .then(() => qc.invalidateQueries({ queryKey: ['liked'] }))
      .catch(() => {
        likedNow.set(key, on);
        listeners.forEach((fn) => fn());
        if (kind === 'track') {
          patchTrack(id, { liked: on });
          nativeAudio?.liked(id, on);
        }
      });
  };
  return [on, toggle];
}

export const sum = (tracks: Track[]) => tracks.reduce((n, t) => n + (t.duration || 0), 0);

/** A song liked or unliked from the app's lock screen (the app has told the server already). */
onEvent((name, value) => {
  const v = value as { id?: string; liked?: boolean } | null;
  if (name !== 'liked' || !v?.id) return;
  likedNow.set(`track:${v.id}`, Boolean(v.liked));
  listeners.forEach((fn) => fn());
  patchTrack(v.id, { liked: Boolean(v.liked) });
});

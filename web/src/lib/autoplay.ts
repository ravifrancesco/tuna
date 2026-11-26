import { useSyncExternalStore } from 'react';
import { api } from '../api';
import { addToQueue, getPlayer, onPlayer } from './player';

/**
 * Autoplay, as on Spotify: when what's playing is about to run out (an album, a playlist, a radio),
 * songs like its last few join the queue, so the music carries on. Each device can turn it off.
 */
const KEY = 'tuna.autoplay';
let on = (() => {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
})();
const listeners = new Set<() => void>();
export const useAutoplay = () =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => on,
  );
export function setAutoplay(next: boolean) {
  on = next;
  try {
    localStorage.setItem(KEY, next ? 'on' : 'off');
  } catch {
    /* not kept */
  }
  listeners.forEach((fn) => fn());
}

/** The end of the queue asked about already (its length and last song). */
let asked: string | undefined;

onPlayer(() => {
  const { queue, index, repeat } = getPlayer();
  if (!on || repeat !== 'off' || index < 0 || index < queue.length - 3) return;
  const end = `${queue.length}:${queue[queue.length - 1]?.id}`;
  if (asked === end) return;
  asked = end;
  void api
    .autoplay(
      queue.slice(-5).map((t) => t.id),
      queue.map((t) => t.id),
    )
    .then((more) => more.length && addToQueue(more))
    .catch(() => (asked = undefined));
});

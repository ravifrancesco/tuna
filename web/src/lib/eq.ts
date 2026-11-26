import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import { nativeAudio } from './native';

/**
 * The equalizer: six bands, kept on this device (it's about its headphones and speakers). The apps
 * apply it in their own player (`audio.eq`, docs/native-bridge.md); in a browser the page does,
 * with Web Audio.
 */

export const BANDS = [60, 150, 400, 1000, 2400, 15000];
export const RANGE = 12;

export interface Eq {
  on: boolean;
  gains: number[];
}

export const PRESETS: { id: string; label: () => string; gains: number[] }[] = [
  { id: 'flat', label: () => t('Flat'), gains: [0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: () => t('Bass boost'), gains: [6, 4, 1, 0, 0, 0] },
  { id: 'lessbass', label: () => t('Less bass'), gains: [-6, -4, -1, 0, 0, 0] },
  { id: 'treble', label: () => t('Treble boost'), gains: [0, 0, 0, 1, 4, 6] },
  { id: 'lesstreble', label: () => t('Less treble'), gains: [0, 0, 0, -1, -4, -6] },
  { id: 'vocal', label: () => t('Vocals'), gains: [-2, -1, 2, 4, 3, 0] },
  { id: 'loud', label: () => t('Loudness'), gains: [5, 3, 0, -1, 2, 5] },
  { id: 'rock', label: () => t('Rock'), gains: [4, 2, -1, 0, 2, 4] },
  { id: 'pop', label: () => t('Pop'), gains: [-1, 1, 3, 3, 1, -1] },
  { id: 'electronic', label: () => t('Electronic'), gains: [5, 3, 0, -1, 2, 4] },
  { id: 'hiphop', label: () => t('Hip-hop'), gains: [5, 4, 0, -1, 1, 2] },
  { id: 'jazz', label: () => t('Jazz'), gains: [3, 1, 0, 1, 2, 3] },
  { id: 'classical', label: () => t('Classical'), gains: [3, 2, 0, 0, 2, 3] },
  { id: 'acoustic', label: () => t('Acoustic'), gains: [3, 2, 1, 1, 2, 2] },
  { id: 'small', label: () => t('Small speakers'), gains: [4, 3, 1, 0, -1, -3] },
  { id: 'spoken', label: () => t('Spoken word'), gains: [-3, -1, 3, 4, 2, -2] },
];

export const presetOf = (gains: number[]) => PRESETS.find((p) => p.gains.every((g, i) => g === gains[i]));

const KEY = 'tuna.eq';
let eq: Eq = (() => {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Eq | null;
    if (kept && Array.isArray(kept.gains) && kept.gains.length === BANDS.length) return kept;
  } catch {
    /* private browsing */
  }
  return { on: false, gains: [0, 0, 0, 0, 0, 0] };
})();
const listeners = new Set<() => void>();

export const getEq = () => eq;
export const useEq = () =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => eq,
  );

/** The browser's player listens for it (lib/player.ts). */
let browserEq: ((e: Eq) => void) | undefined;
export const onBrowserEq = (fn: (e: Eq) => void) => {
  browserEq = fn;
  if (eq.on) fn(eq);
};

function apply() {
  if (nativeAudio?.eq) nativeAudio.eq(eq);
  else browserEq?.(eq);
}

export function setEq(next: Partial<Eq>) {
  eq = { ...eq, ...next, gains: (next.gains ?? eq.gains).map((g) => Math.max(-RANGE, Math.min(RANGE, Math.round(g * 2) / 2))) };
  try {
    localStorage.setItem(KEY, JSON.stringify(eq));
  } catch {
    /* not kept */
  }
  listeners.forEach((fn) => fn());
  apply();
}

/** Whether there's an equalizer here at all: the app's, or the browser's Web Audio. */
export const hasEq = Boolean(nativeAudio?.eq) || (!nativeAudio && typeof AudioContext !== 'undefined');

// The app keeps its own copy, but the page is where it's chosen: send it as the page starts.
if (nativeAudio?.eq) nativeAudio.eq(eq);

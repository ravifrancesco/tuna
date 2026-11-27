import { useEffect, useRef, useState } from 'react';
import { coverUrl } from './session';

const DARK = '#3b2d63';
const BRIGHT = 'hsl(262 42% 44%)';

/** A colour from the cover, for the background behind it. */
export const useTint = (cover?: string): string => useTints(cover).tint;

type Tints = { tint: string; bright: string };
const PLAIN: Tints = { tint: DARK, bright: BRIGHT };
const known = new Map<string, Tints>();
const working = new Map<string, Promise<void>>();

/** Works out a cover's colours, once (the next song's ahead, so they change with it). */
export function prepareTint(cover?: string): Promise<void> {
  const url = coverUrl(cover, 64);
  if (!cover || !url || known.has(cover)) return Promise.resolve();
  const already = working.get(cover);
  if (already) return already;
  const done = new Promise<void>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 4;
        [r, g, b] = [r / n, g / n, b / n];
        known.set(cover, { tint: `rgb(${Math.round(r * 0.75)}, ${Math.round(g * 0.75)}, ${Math.round(b * 0.75)})`, bright: bright(r, g, b) });
      } catch {
        /* the colour is a nicety */
      }
      resolve();
    };
    img.src = url;
  }).finally(() => working.delete(cover));
  working.set(cover, done);
  return done;
}

/** The same colour dark (behind the cover) and bright (the lyrics card on phones); the last one stays until the next is ready. */
export function useTints(cover?: string): Tints {
  const [, redraw] = useState(0);
  const last = useRef(PLAIN);
  useEffect(() => {
    if (cover && !known.has(cover)) void prepareTint(cover).then(() => redraw((n) => n + 1));
  }, [cover]);
  const now = cover ? known.get(cover) : undefined;
  if (now) last.current = now;
  return now ?? (cover ? last.current : PLAIN);
}

/** The cover's hue, saturated and mid-light so white text reads on it; grey covers get Tuna's purple. */
function bright(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 16) return BRIGHT;
  const l = (max + min) / 510;
  const s = d / 255 / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${Math.round(h * 60)} ${Math.round(Math.min(80, Math.max(45, s * 100)))}% 40%)`;
}

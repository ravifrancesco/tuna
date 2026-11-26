import { useRef, useState } from 'react';
import { app } from './native';

/** How far a song has to be swiped, and held, before it counts. */
export const SWIPE = 72;
const HOLD_MS = 450;

/** A short vibration as something happens: the apps' own, else the browser's where there is one. */
export function buzz(style: 'light' | 'success' = 'light') {
  if (app.haptic) app.haptic(style);
  else navigator.vibrate?.(style === 'success' ? 15 : 8);
}

/**
 * Touch gestures on a row, as on Spotify: swipe right or left past `SWIPE` to act, press and hold
 * for the menu. Mouse and pen keep their clicks and right-clicks; scrolling is left alone.
 */
export function useRowGestures({ onRight, onLeft, onHold }: { onRight?: () => void; onLeft?: () => void; onHold?: (at: { clientX: number; clientY: number }) => void }) {
  const [dx, setDx] = useState(0);
  const g = useRef<{ x: number; y: number; id: number; mode?: 'swipe' | 'scroll'; held?: boolean; timer?: number }>(undefined);
  // The click (or Android's context menu) a finger causes after a swipe or a hold isn't a tap.
  const swallow = useRef(false);
  const end = () => {
    clearTimeout(g.current?.timer);
    g.current = undefined;
    setDx(0);
  };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      swallow.current = false;
      if (e.pointerType !== 'touch') return;
      const s: NonNullable<typeof g.current> = { x: e.clientX, y: e.clientY, id: e.pointerId };
      if (onHold)
        s.timer = window.setTimeout(() => {
          if (g.current !== s || s.mode) return;
          s.held = swallow.current = true;
          buzz();
          onHold({ clientX: s.x, clientY: s.y });
        }, HOLD_MS);
      g.current = s;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = g.current;
      if (!s || e.pointerId !== s.id || s.held) return;
      const mx = e.clientX - s.x;
      const my = e.clientY - s.y;
      if (!s.mode) {
        if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.5 && (onRight || onLeft)) {
          s.mode = 'swipe';
          clearTimeout(s.timer);
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* the pointer's already gone */
          }
        } else if (Math.abs(mx) > 10 || Math.abs(my) > 10) {
          s.mode = 'scroll';
          clearTimeout(s.timer);
        }
      }
      if (s.mode === 'swipe') setDx(Math.max(-120, Math.min(120, (mx > 0 && onRight) || (mx < 0 && onLeft) ? mx : 0)));
    },
    onPointerUp: (e: React.PointerEvent) => {
      const s = g.current;
      if (!s || e.pointerId !== s.id) return;
      if (s.mode === 'swipe') {
        swallow.current = true;
        const mx = e.clientX - s.x;
        if (mx >= SWIPE && onRight) (buzz('success'), onRight());
        else if (mx <= -SWIPE && onLeft) (buzz('success'), onLeft());
      }
      end();
    },
    onPointerCancel: end,
    onClickCapture: (e: React.MouseEvent) => {
      if (!swallow.current) return;
      swallow.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
  /** For the row's own onContextMenu: true (and nothing else to do) when a finger's hold caused it. */
  const fromTouch = (e: React.MouseEvent) => {
    if (!g.current?.held && !swallow.current) return false;
    e.preventDefault();
    return true;
  };
  return { dx, handlers, fromTouch, past: dx >= SWIPE ? ('right' as const) : dx <= -SWIPE ? ('left' as const) : undefined };
}

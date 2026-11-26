import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { locale } from '../i18n';
import { isTV } from '../lib/native';

/** "Mar 2023": the month a song went in. Spotify's dates are days (no time), read as such. */
function month(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: iso.length <= 10 ? 'UTC' : undefined }).format(d);
}

/** The month the song at height `y` on screen went in: the row there, or the next one down. */
function monthAt(main: HTMLElement, y: number) {
  const rows = main.querySelectorAll<HTMLElement>('.tracks > [role="listitem"]');
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid].getBoundingClientRect();
    if (r.bottom < y) lo = mid + 1;
    else if (r.top > y) hi = mid - 1;
    else return rows[mid].dataset.added && month(rows[mid].dataset.added);
  }
  // Above the list (its header): nothing; below it: the last song.
  const row = lo === 0 ? undefined : rows[Math.min(lo, rows.length - 1)];
  return row?.dataset.added && month(row.dataset.added);
}

type Bubble = { y: number; right: number; text: string };

/**
 * While someone drags the scrollbar of a long list of songs, the month each one went in, beside it
 * (rows carry it as `data-added`, TrackList). Phones have no scrollbar to drag: a handle shows at
 * the edge while the list scrolls, and dragging it does the same.
 */
export function DateScroller() {
  const [bubble, setBubble] = useState<Bubble>();
  const [handle, setHandle] = useState<{ y: number; dragging: boolean }>();
  /** The handle's drag (phones): held or let go, and the finger's height. */
  const drag = useRef<{ hold: (on: boolean) => void; to: (clientY: number) => void }>(undefined);

  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.main');
    if (!main || isTV) return;
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    const HANDLE = 48;
    let dragging = false;
    let idle: number | undefined;

    // The part of the list that's on screen (on phones, above the tabs and the player).
    const track = () => {
      const r = main.getBoundingClientRect();
      const cs = getComputedStyle(main);
      return { r, top: r.top + parseFloat(cs.paddingTop) + 8, bottom: r.bottom - (touch ? parseFloat(cs.paddingBottom) : 0) - 8 };
    };
    const ratio = () => main.scrollTop / Math.max(1, main.scrollHeight - main.clientHeight);
    const long = () => main.scrollHeight > main.clientHeight * 2.5;
    const show = (y: number, right: number) => {
      const text = monthAt(main, y);
      setBubble(text ? { y, right, text } : undefined);
    };

    // Phones: the handle follows the scroll, and goes a moment after it stops.
    const handleY = () => {
      const { top, bottom } = track();
      return top + ratio() * (bottom - top - HANDLE) + HANDLE / 2;
    };
    const onScroll = () => {
      clearTimeout(idle);
      if (touch) {
        if (!long()) return setHandle(undefined);
        const y = handleY();
        setHandle({ y, dragging });
        if (dragging) show(y, 40);
        else idle = window.setTimeout(() => setHandle(undefined), 1500);
        return;
      }
      // Mouse: the bubble beside the scrollbar's thumb, while it's held.
      if (!dragging) return;
      const { r } = track();
      const view = main.clientHeight;
      const thumb = Math.max((view * view) / main.scrollHeight, 24);
      show(r.top + ratio() * (view - thumb) + thumb / 2, window.innerWidth - r.right + 22);
      idle = window.setTimeout(() => setBubble(undefined), 1200);
    };
    const onDown = (e: PointerEvent) => {
      if (touch || e.pointerType === 'touch') return;
      const r = main.getBoundingClientRect();
      // On the scrollbar: beside the content, or (scrollbars that show over it) its last few pixels.
      const overlay = main.offsetWidth === main.clientWidth;
      dragging = overlay ? e.clientX >= r.right - 14 : e.clientX >= r.left + main.clientWidth;
    };
    const onUp = () => {
      if (touch) return;
      dragging = false;
      setBubble(undefined);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    main.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('blur', onUp);
    drag.current = {
      hold: (on) => {
        dragging = on;
        if (!on) {
          setBubble(undefined);
          setHandle((h) => h && { ...h, dragging: false });
          idle = window.setTimeout(() => setHandle(undefined), 1500);
        }
      },
      to: (clientY) => {
        const { top, bottom } = track();
        const at = Math.max(0, Math.min(1, (clientY - top - HANDLE / 2) / (bottom - top - HANDLE)));
        main.scrollTop = at * (main.scrollHeight - main.clientHeight);
      },
    };
    return () => {
      clearTimeout(idle);
      main.removeEventListener('scroll', onScroll);
      main.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, []);

  return createPortal(
    <>
      {handle && (
        <div
          className={`date-handle ${handle.dragging ? 'is-dragging' : ''}`}
          style={{ top: handle.y }}
          aria-hidden
          onPointerDown={(e) => {
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* the pointer's already gone */
            }
            drag.current?.hold(true);
            drag.current?.to(e.clientY);
          }}
          onPointerMove={(e) => e.buttons && drag.current?.to(e.clientY)}
          onPointerUp={() => drag.current?.hold(false)}
          onPointerCancel={() => drag.current?.hold(false)}
        />
      )}
      {bubble && (
        <div className="date-bubble" style={{ top: bubble.y, right: bubble.right }}>
          {bubble.text}
        </div>
      )}
    </>,
    document.body,
  );
}

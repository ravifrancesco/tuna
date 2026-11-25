import { useState } from 'react';
import { t } from '../i18n';
import { isTV } from '../lib/native';

/**
 * The border between the sidebar and the rest: drag it (or use the arrow keys on it) to make the
 * sidebar wider or narrower; double-click puts it back. Remembered on this device.
 */

const MIN = 200;
const MAX = 440;
const DEFAULT = 248;
const KEY = 'tuna.side';

const clamp = (w: number) => Math.round(Math.max(MIN, Math.min(MAX, w)));
const apply = (w: number) => document.documentElement.style.setProperty('--side', `${w}px`);

function saved(): number {
  try {
    return clamp(Number(localStorage.getItem(KEY)) || DEFAULT);
  } catch {
    return DEFAULT;
  }
}

function save(w: number) {
  try {
    localStorage.setItem(KEY, String(w));
  } catch {
    /* storage blocked */
  }
}

/** At start: the width chosen last time (TVs keep theirs). */
export function restoreSide() {
  if (!isTV) apply(saved());
}

export function Resizer() {
  const [width, setWidth] = useState(saved);
  const [dragging, setDragging] = useState(false);
  const set = (w: number) => {
    const next = clamp(w);
    apply(next);
    setWidth(next);
    return next;
  };
  return (
    <div
      className={`resizer ${dragging ? 'resizer--on' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Sidebar width')}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => dragging && set(e.clientX - 8)}
      onPointerUp={() => {
        setDragging(false);
        document.body.classList.remove('resizing');
        save(width);
      }}
      onDoubleClick={() => save(set(DEFAULT))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          save(set(width + (e.key === 'ArrowRight' ? 16 : -16)));
        }
      }}
    />
  );
}

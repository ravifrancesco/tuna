import { isTV } from './native';

/**
 * TVs (Android TV, Samsung): the remote's arrows move between whatever can be pressed, OK presses
 * it, Back goes back. The interface is the same as on a computer, larger, with a clear highlight.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function candidates(): HTMLElement[] {
  const layer = document.querySelector<HTMLElement>('[data-layer="top"]') ?? document.body;
  return [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

function move(dir: 'left' | 'right' | 'up' | 'down') {
  const from = document.activeElement as HTMLElement | null;
  const all = candidates();
  if (!from || from === document.body || !all.includes(from)) {
    all[0]?.focus();
    return;
  }
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | undefined;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const ahead = dir === 'right' ? b.left >= a.right - 4 : dir === 'left' ? b.right <= a.left + 4 : dir === 'down' ? b.top >= a.bottom - 4 : b.bottom <= a.top + 4;
    if (!ahead) continue;
    const main = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
    const side = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = main + side * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

export function startTV() {
  if (!isTV) return;
  document.documentElement.classList.add('tv');
  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement)?.matches?.('input, textarea');
    const keys: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (keys[e.key] && !(typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
      e.preventDefault();
      move(keys[e.key]);
      return;
    }
    // Back: Escape, Backspace (Android TV), 10009 (Samsung).
    if ((e.key === 'Escape' || e.keyCode === 10009 || (e.key === 'Backspace' && !typing)) && history.length > 1) {
      e.preventDefault();
      const close = document.querySelector<HTMLElement>('[data-layer="top"] [data-close]');
      if (close) close.click();
      else history.back();
    }
  });
  // Samsung's media keys.
  window.addEventListener('keydown', (e) => {
    const map: Record<number, string> = { 10252: 'toggle', 415: 'play', 19: 'pause', 417: 'next', 412: 'previous' };
    if (map[e.keyCode]) window.dispatchEvent(new CustomEvent('tuna:media', { detail: map[e.keyCode] }));
  });
}

import { useEffect, useId, useRef } from 'react';
import { t } from '../i18n';

/** The same sky every time: stars at fixed places, each twinkling in its own time. */
const STARS = (() => {
  let h = 2166136261;
  const r = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  return Array.from({ length: 42 }, () => ({ x: r() * 200, y: r() * 170, size: 0.35 + r() * 1.05, delay: r() * 4, length: 2.4 + r() * 3 }));
})();

/** Where the fish swim to: the nebula's bright middle. */
const NEBULA = { x: 138, y: 60 };

/** The school: where each starts, how big it is, how long it takes; facing where it's going. */
const SCHOOL = [
  { x: -24, y: 150, size: 1.6, time: 9, delay: 0 },
  { x: -30, y: 108, size: 1.15, time: 11, delay: 3.5 },
  { x: 6, y: 182, size: 1.9, time: 10, delay: 6.5 },
  { x: -26, y: 70, size: 0.85, time: 12, delay: 1.8 },
  { x: 34, y: 196, size: 1.35, time: 9.5, delay: 8.2 },
].map((f) => ({ ...f, angle: (Math.atan2(NEBULA.y - f.y, NEBULA.x - f.x) * 180) / Math.PI }));

/** How long the sky moves once it's on screen (or pointed at), before it rests as a still. */
const LIVE_MS = 12_000;

/**
 * Fresh catch's cover: a school of fish swimming through deep space towards a glowing nebula,
 * growing smaller as they go and fading into it, among twinkling stars and the odd shooting star.
 * It moves for a while when it comes on screen (and again when pointed at), then rests: always
 * moving, a big one kept the graphics busy the whole time.
 */
export function FreshCatchArt({ title = true }: { title?: boolean }) {
  const id = useId().replace(/:/g, '');
  const u = (name: string) => `url(#${name}${id})`;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let rest: number | undefined;
    const live = () => {
      el.classList.add('is-live');
      clearTimeout(rest);
      rest = window.setTimeout(() => el.classList.remove('is-live'), LIVE_MS);
    };
    let seen = false;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !seen) live();
      if (!e.isIntersecting) el.classList.remove('is-live');
      seen = e.isIntersecting;
    }, { threshold: 0.25 });
    io.observe(el);
    el.addEventListener('pointerenter', live);
    return () => {
      io.disconnect();
      clearTimeout(rest);
      el.removeEventListener('pointerenter', live);
    };
  }, []);
  return (
    <div className="cover space-art" ref={box}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <radialGradient id={`sky${id}`} cx="68%" cy="30%" r="85%">
            <stop offset="0" stopColor="#2e1470" />
            <stop offset="0.5" stopColor="#140a36" />
            <stop offset="1" stopColor="#06030f" />
          </radialGradient>
          <linearGradient id={`fish${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#c9b3ff" />
          </linearGradient>
          <linearGradient id={`comet${id}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#fff" />
          </linearGradient>
          <filter id={`blur${id}`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
          <filter id={`soft${id}`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
          <filter id={`glow${id}`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width="200" height="200" fill={u('sky')} />
        {/* The nebula: clouds of colour round a bright middle. */}
        <g className="space-art__nebula">
          <g filter={u('blur')}>
            <ellipse cx="128" cy="62" rx="52" ry="30" fill="#7c4dff" opacity="0.55" transform="rotate(-24 128 62)" />
            <ellipse cx="156" cy="48" rx="34" ry="20" fill="#c05cff" opacity="0.45" />
            <ellipse cx="118" cy="78" rx="30" ry="16" fill="#ff7bd5" opacity="0.28" />
            <ellipse cx="150" cy="72" rx="22" ry="14" fill="#6ad3ff" opacity="0.25" />
          </g>
          <circle className="space-art__core" cx={NEBULA.x} cy={NEBULA.y} r="9" fill="#f4ecff" filter={u('soft')} />
        </g>
        {STARS.map((s, i) => (
          <circle key={i} className="space-art__star" cx={s.x} cy={s.y} r={s.size} fill="#fff" style={{ animationDelay: `${s.delay}s`, animationDuration: `${s.length}s` }} />
        ))}
        <line className="space-art__comet" x1="0" y1="0" x2="34" y2="0" stroke={u('comet')} strokeWidth="1.2" strokeLinecap="round" />
        {SCHOOL.map((f, i) => (
          <g
            key={i}
            className="space-art__fish"
            style={
              {
                '--x0': `${f.x}px`,
                '--y0': `${f.y}px`,
                '--x1': `${NEBULA.x}px`,
                '--y1': `${NEBULA.y}px`,
                '--a': `${f.angle}deg`,
                '--s': f.size,
                animationDuration: `${f.time}s`,
                animationDelay: `-${f.delay}s`,
              } as React.CSSProperties
            }
          >
            <g filter={u('glow')}>
              <path className="space-art__tail" d="M-13 -5.5 L-13 5.5 L-5 0 Z" fill={u('fish')} stroke={u('fish')} strokeWidth="1.6" strokeLinejoin="round" />
              <ellipse cx="2.5" cy="0" rx="9" ry="6.2" fill={u('fish')} />
              <circle cx="6.4" cy="-1.5" r="1.45" fill="#1a0b45" />
            </g>
          </g>
        ))}
        {title && (
          <text x="14" y="184" className="space-art__title">
            {t('Fresh catch')}
          </text>
        )}
      </svg>
    </div>
  );
}

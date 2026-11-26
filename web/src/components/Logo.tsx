import { useId } from 'react';

/**
 * Tuna's mark: a music note that is a fish (the head is the note, the tail is Netfish's).
 * Geometry shared with the app icons (apps/common/mark.svg) and the loading animation.
 */
export function Mark({ className, size }: { className?: string; size?: number }) {
  const id = useId().replace(/:/g, '');
  const paint = `url(#m${id})`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={`m${id}`} gradientUnits="userSpaceOnUse" x1="2.44" y1="12" x2="50.81" y2="53.99">
          <stop offset="0" stopColor="#dccbff" />
          <stop offset="1" stopColor="#7c4dff" />
        </linearGradient>
      </defs>
      <g transform="translate(32 32) scale(1.0957) translate(-26.625 -32.995)" fill={paint}>
        <g>
          <path d="M10.94 45.31 L2.44 37.81 L2.44 52.81 Z" stroke={paint} strokeWidth="3" strokeLinejoin="round" />
          <rect x="36.76" y="12" width="4.6" height="30.69" />
          <path
            d="M37.36 12.6 L41.36 12.6 C42.71 17.55 50.81 20.25 50.81 28.35 C50.81 31.5 49.91 33.75 48.56 36 C49.1 29.7 45.86 25.65 41.36 23.85 L37.36 23.85 Z"
            stroke={paint}
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <g transform="rotate(-12 28 44)">
            <ellipse cx="28" cy="44" rx="13.5" ry="9.8" />
            <circle cx="32.05" cy="41.06" r="2.7" fill="#140a2e" />
          </g>
        </g>
      </g>
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <Mark />
      <span>tuna</span>
    </div>
  );
}

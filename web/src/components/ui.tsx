import { useEffect, useState, type ReactNode } from 'react';
import { Heart, Music } from 'lucide-react';
import { t } from '../i18n';
import { coverUrl } from '../lib/session';
import { Mark } from './Logo';
import { FreshCatchArt } from './FreshCatchArt';
import { HookFish } from './Splash';

/**
 * A cover that fades in as it arrives (one already here shows at once). `steady` (the player's): the
 * last picture stays until the next one is ready, so a new song changes all at once.
 */
export function Cover({ cover, src, size = 300, round, className = '', alt = '', steady }: { cover?: string; src?: string; size?: number; round?: boolean; className?: string; alt?: string; steady?: boolean }) {
  const [failed, setFailed] = useState(false);
  const url = src ?? coverUrl(cover, size);
  const [held, setHeld] = useState(url);
  const [arrived, setArrived] = useState<string>();
  useEffect(() => {
    setFailed(false);
    if (!steady || url === held) return;
    if (!url) return setHeld(undefined);
    let gone = false;
    const next = new Image();
    const swap = () => !gone && setHeld(url);
    next.onload = swap;
    next.onerror = swap;
    next.src = url;
    if (next.complete) swap();
    return () => {
      gone = true;
    };
  }, [url, steady, held]);
  const shown = steady ? held : url;
  return (
    <div className={`cover ${round ? 'cover--round' : ''} ${className}`}>
      {shown && !failed ? (
        <img
          src={shown}
          alt={alt}
          loading={steady ? undefined : 'lazy'}
          decoding="async"
          className={arrived === shown ? 'is-in' : ''}
          ref={(el) => {
            if (el?.complete && el.naturalWidth && arrived !== shown) setArrived(shown);
          }}
          onLoad={() => setArrived(shown)}
          onError={() => setFailed(true)}
        />
      ) : (
        <Music size={Math.max(18, size / 8)} />
      )}
    </div>
  );
}

/** Up to four covers in one square (mixes). */
/** A mix's cover: Fresh catch's own, the others from their songs' covers. */
export function MixArt({ mix, size = 300 }: { mix: { id: string; covers: string[] }; size?: number }) {
  return mix.id === 'fresh' ? <FreshCatchArt /> : <Covers covers={mix.covers} size={size} />;
}

export function Covers({ covers, size = 300 }: { covers: string[]; size?: number }) {
  if (covers.length < 4) return <Cover cover={covers[0]} size={size} />;
  return (
    <div className="cover cover--grid">
      {covers.slice(0, 4).map((c) => (
        <img key={c} src={coverUrl(c, Math.round(size / 2))} alt="" loading="lazy" />
      ))}
    </div>
  );
}

export function LikedCover() {
  return (
    <div className="cover cover--liked">
      <Heart size={36} fill="currentColor" />
    </div>
  );
}

/** Loading: the fish nibbling at the hook, fading in after a moment so quick loads never show it. */
export const Spinner = () => (
  <div className="spinner" role="status" aria-label={t('Loading')}>
    <HookFish size={56} />
  </div>
);

/** Nothing to show: the fish, quiet and drifting, and a line of text. */
export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="empty">
    <Mark className="empty__fish" size={40} />
    {children}
  </div>
);

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="sheet-layer" data-layer="top" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ---- Toasts: one line, a few seconds ----------------------------------------------------------------

let showToast: ((text: string) => void) | undefined;
export const toast = (text: string) => showToast?.(text);

export function Toasts() {
  const [text, setText] = useState<string>();
  useEffect(() => {
    let timer: number | undefined;
    showToast = (next) => {
      setText(next);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setText(undefined), 2600);
    };
    return () => {
      showToast = undefined;
    };
  }, []);
  return text ? (
    <div className="toast" role="status">
      {text}
    </div>
  ) : null;
}

/** On or off, as in Netfish's settings. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' is-on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch__knob" />
    </button>
  );
}

import { Heart, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { t } from '../i18n';
import { useLiked } from '../lib/actions';
import { nextShown, previousShown, seekShown, toggleShown, useRemote, useShown } from '../lib/devices';
import { clock } from '../lib/format';
import { cycleRepeat, setShuffle } from '../lib/player';
import { useTint } from '../lib/tint';
import { useTogether } from '../lib/together';
import { TogetherIcon } from './Together';
import { Cover } from './ui';

export function Progress() {
  const time = useShown((s) => s.time);
  const duration = useShown((s) => s.duration || s.queue[s.index]?.duration || 0);
  const pct = duration ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <div className="progress">
      <span>{clock(time)}</span>
      <input
        className="slider"
        type="range"
        min={0}
        max={duration || 1}
        step={1}
        value={Math.min(time, duration || 1)}
        style={{ '--p': `${pct}%` } as React.CSSProperties}
        aria-label={t('Position')}
        onChange={(e) => seekShown(Number(e.target.value))}
      />
      <span>{clock(duration)}</span>
    </div>
  );
}

export function Controls({ big }: { big?: boolean }) {
  const playing = useShown((s) => s.playing);
  const shuffle = useShown((s) => s.shuffle);
  const repeat = useShown((s) => s.repeat);
  // Shuffle and repeat are the device's own: here only for this one.
  const remote = Boolean(useRemote());
  const size = big ? 28 : 20;
  return (
    <div className="controls">
      <button className={`icon-btn ${shuffle ? 'on' : ''}`} aria-label={t('Shuffle')} aria-pressed={shuffle} disabled={remote} onClick={() => setShuffle(!shuffle)}>
        <Shuffle size={big ? 24 : 18} />
      </button>
      <button className="icon-btn" aria-label={t('Previous')} onClick={previousShown}>
        <SkipBack size={size} fill="currentColor" />
      </button>
      <button className="main-btn" aria-label={playing ? t('Pause') : t('Play')} onClick={toggleShown}>
        {playing ? <Pause size={big ? 30 : 20} fill="currentColor" /> : <Play size={big ? 30 : 20} fill="currentColor" style={{ marginLeft: 2 }} />}
      </button>
      <button className="icon-btn" aria-label={t('Next')} onClick={nextShown}>
        <SkipForward size={size} fill="currentColor" />
      </button>
      <button
        className={`icon-btn ${repeat !== 'off' ? 'on' : ''}`}
        aria-label={repeat === 'one' ? t('Repeat this song') : repeat === 'all' ? t('Repeat') : t('Repeat off')}
        disabled={remote}
        onClick={cycleRepeat}
      >
        {repeat === 'one' ? <Repeat1 size={big ? 24 : 18} /> : <Repeat size={big ? 24 : 18} />}
      </button>
    </div>
  );
}

export function LikeNow({ size = 18 }: { size?: number }) {
  const track = useShown((s) => s.queue[s.index]);
  const [liked, toggleLike] = useLiked('track', track?.id, track?.liked);
  if (!track) return null;
  return (
    <button className={`icon-btn ${liked ? 'on' : ''}`} aria-label={liked ? t('Remove from liked songs') : t('Add to liked songs')} onClick={toggleLike}>
      <Heart size={size} fill={liked ? 'currentColor' : 'none'} />
    </button>
  );
}

/** Phones: the small player above the tabs. Music on another of your devices: the same, glowing. */
export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const track = useShown((s) => s.queue[s.index]);
  const playing = useShown((s) => s.playing);
  const pct = useShown((s) => (s.duration ? Math.min(100, (s.time / s.duration) * 100) : 0));
  const remote = useRemote();
  const tint = useTint(track?.cover);
  const together = useTogether();
  if (!track) return null;
  return (
    <div className={`mini ${remote ? 'mini--remote' : ''}`} style={{ '--tint': tint } as React.CSSProperties} onClick={onOpen} role="button" aria-label={t('Now playing')}>
      <Cover cover={track.cover} size={100} />
      <div className="mini__text">
        <span className="bar__title">
          {together && !remote && <TogetherIcon size={14} />}
          {track.title}
        </span>
        <span className="bar__artist">{track.artist}</span>
      </div>
      <span onClick={(e) => e.stopPropagation()}>
        <LikeNow size={22} />
      </span>
      <button
        className="icon-btn"
        style={{ color: 'var(--text)' }}
        aria-label={playing ? t('Pause') : t('Play')}
        onClick={(e) => {
          e.stopPropagation();
          toggleShown();
        }}
      >
        {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
      </button>
      <div className="mini__line">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

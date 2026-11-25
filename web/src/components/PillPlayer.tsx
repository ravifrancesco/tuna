import { ListMusic, Mic, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { t } from '../i18n';
import { clock } from '../lib/format';
import { next, previous, seek, setVolume, toggle, usePlayer } from '../lib/player';
import { useTint } from '../lib/tint';
import { useTogether } from '../lib/together';
import { TogetherIcon } from './Together';
import { LikeNow } from './PlayerBar';
import { Cover } from './ui';

/** The thin line along the player's edge: where the song is, and a place to seek. */
function Line() {
  const time = usePlayer((s) => s.time);
  const duration = usePlayer((s) => s.duration || s.queue[s.index]?.duration || 0);
  const pct = duration ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <input
      className="float__line"
      type="range"
      min={0}
      max={duration || 1}
      step={1}
      value={Math.min(time, duration || 1)}
      style={{ '--p': `${pct}%` } as React.CSSProperties}
      aria-label={t('Position')}
      aria-valuetext={`${clock(time)} / ${clock(duration)}`}
      onChange={(e) => seek(Number(e.target.value))}
    />
  );
}

function PlayPause({ size = 20 }: { size?: number }) {
  const playing = usePlayer((s) => s.playing);
  return (
    <button className="float__play" aria-label={playing ? t('Pause') : t('Play')} onClick={toggle}>
      {playing ? <Pause size={size} fill="currentColor" /> : <Play size={size} fill="currentColor" style={{ marginLeft: 2 }} />}
    </button>
  );
}

/** The player: a pill floating over the music side of the window, in the colour of the cover. */
export function PillPlayer({ onOpen }: { onOpen: (tab?: 'lyrics' | 'queue') => void }) {
  const track = usePlayer((s) => s.queue[s.index]);
  const volume = usePlayer((s) => s.volume);
  const tint = useTint(track?.cover);
  const together = useTogether();
  if (!track) return null;
  return (
    <div
      className="capsule"
      style={{ '--tint': tint } as React.CSSProperties}
      aria-label={t('Player')}
      // Anywhere on the pill but its buttons opens the song: lyrics, queue, the big cover.
      onClick={(e) => !(e.target as HTMLElement).closest('button, a, input') && onOpen()}
    >
      <div className="capsule__left">
        <button className="capsule__cover" onClick={() => onOpen()} aria-label={t('Now playing')}>
          <Cover cover={track.cover} size={150} round />
        </button>
        <div className="capsule__text">
          <span className="bar__title">
            {together && <TogetherIcon size={14} />}
            {track.title}
          </span>
          <span className="bar__artist">{track.artist}</span>
        </div>
        <LikeNow />
      </div>
      <div className="capsule__controls">
        <button className="icon-btn" aria-label={t('Previous')} onClick={previous}>
          <SkipBack size={19} fill="currentColor" />
        </button>
        <PlayPause />
        <button className="icon-btn" aria-label={t('Next')} onClick={next}>
          <SkipForward size={19} fill="currentColor" />
        </button>
      </div>
      <div className="capsule__extra">
        <button className="icon-btn" aria-label={t('Lyrics')} onClick={() => onOpen('lyrics')}>
          <Mic size={18} />
        </button>
        <button className="icon-btn" aria-label={t('Queue')} onClick={() => onOpen('queue')}>
          <ListMusic size={18} />
        </button>
        <button className="icon-btn" aria-label={volume ? t('Mute') : t('Unmute')} onClick={() => setVolume(volume ? 0 : 1)}>
          {volume ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>
      <Line />
    </div>
  );
}

import { Link } from 'react-router';
import { CircleArrowDown, Heart, ListEnd, MoreHorizontal, Pause, Play } from 'lucide-react';
import type { Track, WaitingSong } from '@tuna/shared';
import { t } from '../i18n';
import { useLiked } from '../lib/actions';
import { useOnDevice } from '../lib/downloads';
import { clock } from '../lib/format';
import { useRowGestures } from '../lib/gestures';
import { addToQueue, current, playTracks, toggle, usePlayer, type Source } from '../lib/player';
import { showMenu, TrackMenu } from './Menu';
import { Cover, toast } from './ui';

/**
 * Songs in a list: the number (play on hover), title and artist, album, like, length, menu.
 * `numbers`: album order (track numbers) instead of covers. `waiting`: songs not in the library
 * yet (imported from Spotify), greyed out where they belong. `added`: when each song went in, for
 * the date shown while dragging the scrollbar (DateScroller).
 */
export function TrackList({
  tracks,
  source,
  numbers,
  compact,
  onRemove,
  waiting = [],
  added,
}: {
  tracks: Track[];
  source: Source;
  numbers?: boolean;
  compact?: boolean;
  onRemove?: (index: number) => void;
  waiting?: WaitingSong[];
  added?: (string | null)[];
}) {
  const after = new Map<number, WaitingSong[]>();
  for (const w of waiting) after.set(w.after, [...(after.get(w.after) ?? []), w]);
  const rows: React.ReactNode[] = [];
  let n = 0;
  const later = (i: number) => after.get(i)?.forEach((w, j) => rows.push(<WaitingRow key={`w${i}-${j}`} song={w} n={++n} showAlbum={!compact} />));
  later(-1);
  tracks.forEach((tr, i) => {
    n++;
    rows.push(<TrackRow key={`${tr.id}-${i}`} track={tr} added={added?.[i]} n={numbers ? (tr.track ?? i + 1) : n} showCover={!numbers} showAlbum={!compact} onPlay={() => playTracks(tracks, i, source, { shuffle: false })} onRemove={onRemove && (() => onRemove(i))} />);
    later(i);
  });
  return (
    <div className={`tracks ${compact ? 'tracks--compact' : ''}`} role="list">
      {rows}
    </div>
  );
}

/** A song that isn't in the library yet: where it belongs, not playable. */
function WaitingRow({ song, n, showAlbum }: { song: WaitingSong; n: number; showAlbum: boolean }) {
  return (
    <div className="track track--waiting" role="listitem" aria-disabled data-added={song.added}>
      <div className="track__n">
        <span>{n}</span>
      </div>
      <div className="track__main">
        <div className="cover" />
        <div className="track__text">
          <span className="track__title">{song.title}</span>
          <span className="track__artist">{song.artist}</span>
        </div>
      </div>
      {showAlbum && <div className="track__album">{song.album}</div>}
    </div>
  );
}

function TrackRow({
  track,
  added,
  n,
  showCover,
  showAlbum,
  onPlay,
  onRemove,
}: {
  track: Track;
  added?: string | null;
  n: number;
  showCover: boolean;
  showAlbum: boolean;
  onPlay: () => void;
  onRemove?: () => void;
}) {
  const isCurrent = usePlayer((s) => s.queue[s.index]?.id === track.id);
  const playing = usePlayer((s) => s.playing);
  const [liked, toggleLike] = useLiked('track', track.id, track.liked);
  const onDevice = useOnDevice(track.id);
  const menu = (e: React.MouseEvent) => showMenu(e, <TrackMenu track={track} onRemove={onRemove} />);
  // Phones: swipe right to queue it, left to like it, hold for the menu.
  const swipe = useRowGestures({
    onRight: () => (addToQueue([track]), toast(t('Added to the queue'))),
    onLeft: () => (toggleLike(), toast(liked ? t('Removed from liked songs') : t('Added to liked songs'))),
    onHold: (at) => showMenu(at, <TrackMenu track={track} onRemove={onRemove} />),
  });
  return (
    <div className={`swipe ${swipe.past ? `swipe--${swipe.past}` : ''}`} role="listitem" data-added={added ?? undefined}>
      {swipe.dx !== 0 && (
        <div className="swipe__back" aria-hidden>
          <ListEnd size={20} />
          <Heart size={20} fill={liked ? 'none' : 'currentColor'} />
        </div>
      )}
      <div
        className={`track ${isCurrent ? 'playing' : ''} ${swipe.dx ? 'moving' : ''}`}
        style={swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined}
        {...swipe.handlers}
        onDoubleClick={onPlay}
        onContextMenu={(e) => swipe.fromTouch(e) || menu(e)}
      >
        <div className="track__n">
          <span>{n}</span>
          <button className="icon-btn" aria-label={t('Play {title}', { title: track.title })} onClick={() => (isCurrent && current() ? toggle() : onPlay())}>
            {isCurrent && playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
        </div>
        <div className="track__main">
          {showCover && <Cover cover={track.cover} size={100} />}
          <div className="track__text">
            <button className="track__title" style={{ textAlign: 'left', maxWidth: '100%' }} onClick={onPlay}>
              {track.title}
            </button>
            <span className="track__artist">
              {onDevice && <CircleArrowDown size={13} className="on-device" aria-label={t('Downloaded')} />}
              {track.artistId ? <Link to={`/artist/${track.artistId}`}>{track.artist}</Link> : track.artist}
            </span>
          </div>
        </div>
        {showAlbum && <div className="track__album">{track.albumId ? <Link to={`/album/${track.albumId}`}>{track.album}</Link> : track.album}</div>}
        <button className={`icon-btn like ${liked ? 'on' : ''}`} aria-label={liked ? t('Remove from liked songs') : t('Add to liked songs')} onClick={toggleLike}>
          <Heart size={17} fill={liked ? 'currentColor' : 'none'} />
        </button>
        <div className="track__time">{clock(track.duration)}</div>
        <button className="icon-btn" aria-label={t('More')} onClick={menu}>
          <MoreHorizontal size={18} />
        </button>
      </div>
    </div>
  );
}

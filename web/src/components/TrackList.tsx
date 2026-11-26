import { Link } from 'react-router';
import { CircleArrowDown, Heart, MoreHorizontal, Pause, Play } from 'lucide-react';
import type { Track, WaitingSong } from '@tuna/shared';
import { t } from '../i18n';
import { useLiked } from '../lib/actions';
import { useOnDevice } from '../lib/downloads';
import { clock } from '../lib/format';
import { current, playTracks, toggle, usePlayer, type Source } from '../lib/player';
import { showMenu, TrackMenu } from './Menu';
import { Cover } from './ui';

/**
 * Songs in a list: the number (play on hover), title and artist, album, like, length, menu.
 * `numbers`: album order (track numbers) instead of covers. `waiting`: songs not in the library
 * yet (imported from Spotify), greyed out where they belong.
 */
export function TrackList({
  tracks,
  source,
  numbers,
  compact,
  onRemove,
  waiting = [],
}: {
  tracks: Track[];
  source: Source;
  numbers?: boolean;
  compact?: boolean;
  onRemove?: (index: number) => void;
  waiting?: WaitingSong[];
}) {
  const after = new Map<number, WaitingSong[]>();
  for (const w of waiting) after.set(w.after, [...(after.get(w.after) ?? []), w]);
  const rows: React.ReactNode[] = [];
  let n = 0;
  const later = (i: number) => after.get(i)?.forEach((w, j) => rows.push(<WaitingRow key={`w${i}-${j}`} song={w} n={++n} showAlbum={!compact} />));
  later(-1);
  tracks.forEach((tr, i) => {
    n++;
    rows.push(<TrackRow key={`${tr.id}-${i}`} track={tr} n={numbers ? (tr.track ?? i + 1) : n} showCover={!numbers} showAlbum={!compact} onPlay={() => playTracks(tracks, i, source, { shuffle: false })} onRemove={onRemove && (() => onRemove(i))} />);
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
    <div className="track track--waiting" role="listitem" aria-disabled>
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

function TrackRow({ track, n, showCover, showAlbum, onPlay, onRemove }: { track: Track; n: number; showCover: boolean; showAlbum: boolean; onPlay: () => void; onRemove?: () => void }) {
  const isCurrent = usePlayer((s) => s.queue[s.index]?.id === track.id);
  const playing = usePlayer((s) => s.playing);
  const [liked, toggleLike] = useLiked('track', track.id, track.liked);
  const onDevice = useOnDevice(track.id);
  const menu = (e: React.MouseEvent) => showMenu(e, <TrackMenu track={track} onRemove={onRemove} />);
  return (
    <div className={`track ${isCurrent ? 'playing' : ''}`} role="listitem" onDoubleClick={onPlay} onContextMenu={menu}>
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
  );
}

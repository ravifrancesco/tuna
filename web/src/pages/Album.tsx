import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Heart, ListEnd, ListPlus, ListStart, MoreHorizontal, Radio, Shuffle } from 'lucide-react';
import { api } from '../api';
import { AlbumCard, Row } from '../components/Cards';
import { Item, pickPlaylist, showMenu } from '../components/Menu';
import { PlayButton } from '../components/PlayButton';
import { TrackList } from '../components/TrackList';
import { Cover, Empty, Spinner, toast } from '../components/ui';
import { t } from '../i18n';
import { useLiked } from '../lib/actions';
import { DownloadButton } from '../components/DownloadButton';
import { length, songs } from '../lib/format';
import { addToQueue, playNext, playTracks } from '../lib/player';
import { useTint } from '../lib/tint';

export function Album() {
  const { id = '' } = useParams();
  const album = useQuery({ queryKey: ['album', id], queryFn: () => api.album(id) });
  const [liked, toggleLike] = useLiked('album', id, album.data?.liked);
  const tint = useTint(album.data?.cover);
  if (album.isLoading) return <Spinner />;
  const a = album.data;
  if (!a) return <Empty>{t("Couldn't find this album")}</Empty>;
  const source = { kind: 'album' as const, id: a.id, title: a.name };
  return (
    <div className="page--flush">
      <header className="hero" style={{ '--hero': tint } as React.CSSProperties}>
        <Cover cover={a.cover} size={600} />
        <div>
          <div className="hero__kind">{a.songCount <= 3 ? t('Single') : t('Album')}</div>
          <h1>{a.name}</h1>
          <div className="hero__meta">
            {a.artistId ? <Link to={`/artist/${a.artistId}`}>{a.artist}</Link> : a.artist}
            {a.year ? ` · ${a.year}` : ''} · {songs(a.songCount)}, {length(a.duration)}
          </div>
        </div>
      </header>
      <div className="actions">
        <PlayButton source={source} onPlay={() => playTracks(a.tracks, 0, source, { shuffle: false })} />
        <button className="icon-btn" aria-label={t('Shuffle')} onClick={() => playTracks(a.tracks, 0, source, { shuffle: true })}>
          <Shuffle size={24} />
        </button>
        <DownloadButton want={{ id: `album:${a.id}`, kind: 'album', title: a.name, subtitle: a.artist, cover: a.cover, tracks: a.tracks }} />
        <button className={`icon-btn ${liked ? 'on' : ''}`} aria-label={liked ? t('Remove from your library') : t('Save to your library')} onClick={toggleLike}>
          <Heart size={26} fill={liked ? 'currentColor' : 'none'} />
        </button>
        <button
          className="icon-btn"
          aria-label={t('More')}
          onClick={(e) =>
            showMenu(
              e,
              <>
                <Item icon={<ListStart size={18} />} onClick={() => (playNext(a.tracks), toast(t('Plays next')))}>
                  {t('Play next')}
                </Item>
                <Item icon={<ListEnd size={18} />} onClick={() => (addToQueue(a.tracks), toast(t('Added to the queue')))}>
                  {t('Add to queue')}
                </Item>
                <Item icon={<Radio size={18} />} onClick={() => void api.mix(`album:${a.id}`).then((tr) => playTracks(tr, 0, { kind: 'mix', id: `album:${a.id}`, title: t('{title} radio', { title: a.name }) }, { shuffle: false }))}>
                  {t('Start radio')}
                </Item>
                <Item icon={<ListPlus size={18} />} onClick={() => pickPlaylist(a.tracks)}>
                  {t('Add to playlist')}
                </Item>
              </>,
            )
          }
        >
          <MoreHorizontal size={24} />
        </button>
      </div>
      <div className="section">
        <TrackList tracks={a.tracks} source={source} numbers compact />
      </div>
      {a.moreBy.length > 0 && (
        <div className="section">
          <Row title={t('More by {name}', { name: a.artist })}>
            {a.moreBy.map((x) => (
              <AlbumCard key={x.id} album={x} sub={String(x.year ?? '')} />
            ))}
          </Row>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Play, Shuffle } from 'lucide-react';
import { api } from '../api';
import { AlbumCard, ArtistCard, Row, WorldAlbumCard, WorldArtistCard, playMix } from '../components/Cards';
import { TrackList } from '../components/TrackList';
import { Cover, Empty, Spinner } from '../components/ui';
import { t } from '../i18n';
import { useLiked } from '../lib/actions';
import { playTracks } from '../lib/player';
import { coverUrl } from '../lib/session';

export function Artist() {
  const { id = '' } = useParams();
  const artist = useQuery({ queryKey: ['artist', id], queryFn: () => api.artist(id) });
  const [following, toggleFollow] = useLiked('artist', id, artist.data?.liked);
  const [allTop, setAllTop] = useState(false);
  if (artist.isLoading) return <Spinner />;
  const a = artist.data;
  if (!a) return <Empty>{t("Couldn't find this artist")}</Empty>;
  const bg = coverUrl(a.cover, 600);
  return (
    <div className="page--flush">
      <header className="hero hero--artist">
        {bg && <div className="hero__bg" style={{ backgroundImage: `url("${bg}")` }} />}
        <Cover cover={a.cover} size={600} round />
        <div>
          <div className="hero__kind">{t('Artist')}</div>
          <h1>{a.name}</h1>
        </div>
      </header>
      <div className="actions">
        <button className="play-btn play-btn--big" aria-label={t('Play')} onClick={() => void playMix({ id: `artist:${a.id}`, title: a.name })}>
          <Play size={24} fill="currentColor" />
        </button>
        <button className="icon-btn" aria-label={t('Shuffle')} onClick={() => playTracks(a.top, 0, { kind: 'artist', id: a.id, title: a.name }, { shuffle: true })}>
          <Shuffle size={24} />
        </button>
        <button className="btn btn--ghost btn--small" onClick={toggleFollow}>
          {following ? t('Following') : t('Follow')}
        </button>
      </div>
      {a.top.length > 0 && (
        <div className="section">
          <h2>{t('Popular')}</h2>
          <TrackList tracks={allTop ? a.top : a.top.slice(0, 5)} source={{ kind: 'artist', id: a.id, title: a.name }} compact />
          {a.top.length > 5 && (
            <button className="btn btn--ghost btn--small" style={{ marginTop: 8 }} onClick={() => setAllTop(!allTop)}>
              {allTop ? t('Show less') : t('Show more')}
            </button>
          )}
        </div>
      )}
      {a.albums.length > 0 && (
        <div className="section">
          <Row title={t('Albums')}>
            {a.albums.map((x) => (
              <AlbumCard key={x.id} album={x} sub={String(x.year ?? '')} />
            ))}
          </Row>
        </div>
      )}
      {a.elsewhere.length > 0 && (
        <div className="section">
          <Row title={t('Not in your library')}>
            {a.elsewhere.map((x) => (
              <WorldAlbumCard key={x.mbid} album={x} />
            ))}
          </Row>
        </div>
      )}
      {a.similar.length > 0 && (
        <div className="section">
          <Row title={t('Fans also like')}>
            {a.similar.map((x) => (
              <ArtistCard key={x.id} artist={x} />
            ))}
          </Row>
        </div>
      )}
      {a.similarElsewhere.length > 0 && (
        <div className="section">
          <Row title={t('Similar artists to discover')}>
            {a.similarElsewhere.map((x) => (
              <WorldArtistCard key={x.mbid} artist={x} />
            ))}
          </Row>
        </div>
      )}
      {a.bio && (
        <div className="section">
          <h2>{t('About')}</h2>
          <p className="bio">{a.bio}</p>
        </div>
      )}
    </div>
  );
}

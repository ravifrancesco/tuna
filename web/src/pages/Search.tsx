import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Play, Search as SearchIcon, X } from 'lucide-react';
import { api } from '../api';
import { AlbumCard, ArtistCard, PlaylistCard, Row, WorldAlbumCard, WorldArtistCard, playAlbum, playMix } from '../components/Cards';
import { TrackList } from '../components/TrackList';
import { Cover, Spinner } from '../components/ui';
import { t } from '../i18n';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return v;
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim(), 250);
  const qWorld = useDebounced(text.trim(), 700);
  useEffect(() => {
    setParams(q ? { q } : {}, { replace: true });
  }, [q, setParams]);

  const lib = useQuery({ queryKey: ['search', q], queryFn: () => api.search(q), enabled: q.length > 0, staleTime: 30_000 });
  const world = useQuery({ queryKey: ['searchWorld', qWorld], queryFn: () => api.searchWorld(qWorld), enabled: qWorld.length > 1, staleTime: 5 * 60_000, retry: 1 });
  const r = lib.data;
  const top = r?.artists[0] ?? r?.albums[0];

  return (
    <div className="page--flush">
      <div className="searchbox">
        <div>
          <SearchIcon size={20} />
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t('What do you want to listen to?')} aria-label={t('Search')} />
          {text && (
            <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={t('Clear')} onClick={() => setText('')}>
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="page" style={{ paddingTop: 8 }}>
                {q && lib.isLoading && <Spinner />}
        {r && (
          <>
            {(top || r.tracks.length > 0) && (
              <div className="split">
                {top && (
                  <section>
                    <div className="row__head">
                      <h2>{t('Top result')}</h2>
                    </div>
                    {'albumCount' in top || !('songCount' in top) ? (
                      <Link className="top-result" to={`/artist/${top.id}`}>
                        <Cover cover={top.cover} round />
                        <h3>{top.name}</h3>
                        <span className="muted">{t('Artist')}</span>
                        <button
                          className="play-btn"
                          style={{ position: 'absolute', right: 20, bottom: 20 }}
                          aria-label={t('Play {title}', { title: top.name })}
                          onClick={(e) => {
                            e.preventDefault();
                            void playMix({ id: `artist:${top.id}`, title: top.name });
                          }}
                        >
                          <Play size={22} fill="currentColor" />
                        </button>
                      </Link>
                    ) : (
                      <Link className="top-result" to={`/album/${top.id}`}>
                        <Cover cover={top.cover} />
                        <h3>{top.name}</h3>
                        <span className="muted">
                          {t('Album')} · {top.artist}
                        </span>
                        <button
                          className="play-btn"
                          style={{ position: 'absolute', right: 20, bottom: 20 }}
                          aria-label={t('Play {title}', { title: top.name })}
                          onClick={(e) => {
                            e.preventDefault();
                            void playAlbum(top);
                          }}
                        >
                          <Play size={22} fill="currentColor" />
                        </button>
                      </Link>
                    )}
                  </section>
                )}
                {r.tracks.length > 0 && (
                  <section>
                    <div className="row__head">
                      <h2>{t('Songs')}</h2>
                    </div>
                    <TrackList tracks={r.tracks.slice(0, 5)} source={{ kind: 'search', title: text }} compact />
                  </section>
                )}
              </div>
            )}
            {r.artists.length > 0 && <Row title={t('Artists')}>{r.artists.map((a) => <ArtistCard key={a.id} artist={a} />)}</Row>}
            {r.albums.length > 0 && <Row title={t('Albums')}>{r.albums.map((a) => <AlbumCard key={a.id} album={a} />)}</Row>}
            {r.playlists.length > 0 && <Row title={t('Playlists')}>{r.playlists.map((p) => <PlaylistCard key={p.id} playlist={p} />)}</Row>}
            {!top && !r.tracks.length && !r.playlists.length && <p className="muted">{t('Nothing in your library for "{q}".', { q })}</p>}
          </>
        )}
        {q.length > 1 && (
          <>
            {world.isLoading && qWorld === q && <Spinner />}
            {world.isError && qWorld === q && <p className="muted">{t("Couldn't search all music right now.")}</p>}
            {world.data && (world.data.albums.some((a) => !a.albumId) || world.data.artists.some((a) => !a.artistId)) && (
              <>
                <div className="row__head" style={{ marginTop: 10 }}>
                  <h2>{t('Not in your library')}</h2>
                </div>
                {world.data.artists.some((a) => !a.artistId) && (
                  <Row title={t('Artists')}>
                    {world.data.artists
                      .filter((a) => !a.artistId)
                      .map((a) => (
                        <WorldArtistCard key={a.mbid} artist={a} />
                      ))}
                  </Row>
                )}
                {world.data.albums.some((a) => !a.albumId) && (
                  <Row title={t('Albums')}>
                    {world.data.albums
                      .filter((a) => !a.albumId)
                      .map((a) => (
                        <WorldAlbumCard key={a.mbid} album={a} />
                      ))}
                  </Row>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

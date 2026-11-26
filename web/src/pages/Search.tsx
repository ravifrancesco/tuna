import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { History, Play, Search as SearchIcon, X } from 'lucide-react';
import { api } from '../api';
import { AlbumCard, ArtistCard, PlaylistCard, Row, WorldAlbumCard, WorldArtistCard, playAlbum, playMix } from '../components/Cards';
import { TrackList } from '../components/TrackList';
import { Cover, Spinner } from '../components/ui';
import { t } from '../i18n';
import { clearSearches, forgetSearch, recentSearches, rememberSearch } from '../lib/recent';

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
  // Everything else that exists (through Lidarr), in the same rows after what's in the library.
  const w = qWorld === q ? world.data : undefined;
  const moreArtists = w?.artists.filter((a) => !a.artistId) ?? [];
  const moreAlbums = w?.albums.filter((a) => !a.albumId) ?? [];
  const lookingFurther = q.length > 1 && (qWorld !== q || world.isLoading);
  const libEmpty = r && !top && !r.tracks.length && !r.playlists.length;
  // Only songs, artists, albums or playlists; and what was searched lately (when the box is empty).
  const [filter, setFilter] = useState<'all' | 'songs' | 'artists' | 'albums' | 'playlists'>('all');
  const [recent, setRecent] = useState(recentSearches);
  useEffect(() => {
    if (q.length < 2) return;
    const timer = setTimeout(() => setRecent(rememberSearch(q)), 1500);
    return () => clearTimeout(timer);
  }, [q]);
  const FILTERS = [
    ['all', t('All')],
    ['songs', t('Songs')],
    ['artists', t('Artists')],
    ['albums', t('Albums')],
    ['playlists', t('Playlists')],
  ] as const;
  const only =
    r && filter !== 'all'
      ? filter === 'songs'
        ? r.tracks.length > 0 && <TrackList tracks={r.tracks} source={{ kind: 'search', title: text }} />
        : (filter === 'artists' ? r.artists.length + moreArtists.length : filter === 'albums' ? r.albums.length + moreAlbums.length : r.playlists.length) > 0 && (
            <div className="grid">
              {filter === 'artists' && [...r.artists.map((a) => <ArtistCard key={a.id} artist={a} />), ...moreArtists.map((a) => <WorldArtistCard key={a.mbid} artist={a} />)]}
              {filter === 'albums' && [...r.albums.map((a) => <AlbumCard key={a.id} album={a} />), ...moreAlbums.map((a) => <WorldAlbumCard key={a.mbid} album={a} />)]}
              {filter === 'playlists' && r.playlists.map((p) => <PlaylistCard key={p.id} playlist={p} />)}
            </div>
          )
      : undefined;

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
        {!q && recent.length > 0 && (
          <section className="recent">
            <div className="row__head">
              <h2>{t('Recent searches')}</h2>
              <button className="btn btn--small" onClick={() => setRecent(clearSearches())}>
                {t('Clear')}
              </button>
            </div>
            {recent.map((x) => (
              <div className="recent__item" key={x}>
                <button onClick={() => setText(x)}>
                  <History size={18} /> {x}
                </button>
                <button className="icon-btn" aria-label={t('Remove')} onClick={() => setRecent(forgetSearch(x))}>
                  <X size={16} />
                </button>
              </div>
            ))}
          </section>
        )}
        {q && (
          <div className="chips search__filters" role="tablist">
            {FILTERS.map(([key, label]) => (
              <button key={key} className={`chip ${filter === key ? 'on' : ''}`} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {q && lib.isLoading && <Spinner />}
        {filter !== 'all' && r && (only || (!lookingFurther && <p className="muted">{t('Nothing found for "{q}".', { q })}</p>))}
        {filter === 'all' && r && (
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
            {(r.artists.length > 0 || moreArtists.length > 0) && (
              <Row title={t('Artists')}>
                {r.artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} />
                ))}
                {moreArtists.map((a) => (
                  <WorldArtistCard key={a.mbid} artist={a} />
                ))}
              </Row>
            )}
            {(r.albums.length > 0 || moreAlbums.length > 0) && (
              <Row title={t('Albums')}>
                {r.albums.map((a) => (
                  <AlbumCard key={a.id} album={a} />
                ))}
                {moreAlbums.map((a) => (
                  <WorldAlbumCard key={a.mbid} album={a} />
                ))}
              </Row>
            )}
            {r.playlists.length > 0 && <Row title={t('Playlists')}>{r.playlists.map((p) => <PlaylistCard key={p.id} playlist={p} />)}</Row>}
            {libEmpty && world.isError && <p className="muted">{t('Nothing in your library for "{q}".', { q })}</p>}
            {libEmpty && !lookingFurther && !world.isError && !moreArtists.length && !moreAlbums.length && (
              <p className="muted">{t('Nothing found for "{q}".', { q })}</p>
            )}
          </>
        )}
        {lookingFurther && r && <Spinner />}
        {world.isError && qWorld === q && <p className="muted">{t("Couldn't search all music right now.")}</p>}
      </div>
    </div>
  );
}

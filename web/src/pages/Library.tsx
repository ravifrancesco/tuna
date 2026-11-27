import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, Check, CircleArrowDown, FileUp, Plus } from 'lucide-react';
import { api } from '../api';
import { AlbumCard, ArtistCard, PlaylistCard } from '../components/Cards';
import { ImportFiles } from '../components/ImportFiles';
import { Item, pickPlaylist, showMenu } from '../components/Menu';
import { Empty, LikedCover, Spinner } from '../components/ui';
import { locale, t, tn } from '../i18n';
import { canDownload } from '../lib/downloads';

type Show = 'playlists' | 'albums' | 'artists';
/** Each view's orders, the first being where it starts. Albums are sorted by the server. */
const SORTS: Record<Show, { value: string; label: () => string }[]> = {
  playlists: [
    { value: 'newest', label: () => t('Recently added') },
    { value: 'name', label: () => t('A–Z') },
    { value: 'owner', label: () => t('Creator') },
  ],
  albums: [
    { value: 'newest', label: () => t('Recently added') },
    { value: 'alphabeticalByName', label: () => t('A–Z') },
    { value: 'alphabeticalByArtist', label: () => t('Artist') },
    { value: 'frequent', label: () => t('Most played') },
  ],
  artists: [
    { value: 'name', label: () => t('A–Z') },
    { value: 'albums', label: () => t('Most albums') },
  ],
};
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' });

// The order picked for each view is remembered on this device.
const remembered = (show: Show) => {
  try {
    const v = localStorage.getItem(`tuna.sort.${show}`);
    return SORTS[show].some((s) => s.value === v) ? v! : SORTS[show][0].value;
  } catch {
    return SORTS[show][0].value;
  }
};

export function Library() {
  const [params, setParams] = useSearchParams();
  const show = (params.get('show') as Show) ?? 'playlists';
  const server = useQuery({ queryKey: ['server'], queryFn: api.server, staleTime: 60_000 });
  const [importing, setImporting] = useState(false);
  const [sorts, setSorts] = useState(() => ({ playlists: remembered('playlists'), albums: remembered('albums'), artists: remembered('artists') }));
  const sort = sorts[show];
  const setSort = (value: string) => {
    setSorts({ ...sorts, [show]: value });
    try {
      localStorage.setItem(`tuna.sort.${show}`, value);
    } catch {
      /* storage blocked */
    }
  };
  const lists = useQuery({ queryKey: ['playlists'], queryFn: api.playlists, enabled: show === 'playlists' });
  const liked = useQuery({ queryKey: ['liked'], queryFn: api.liked, enabled: show === 'playlists' });
  const albums = useQuery({ queryKey: ['albums', sorts.albums], queryFn: () => api.albums(sorts.albums, 0, 500), enabled: show === 'albums' });
  const artists = useQuery({ queryKey: ['artists'], queryFn: api.artists, enabled: show === 'artists' });

  const view = (value: Show, label: string) => (
    <button role="tab" aria-selected={show === value} className={show === value ? 'on' : ''} onClick={() => setParams({ show: value }, { replace: true })}>
      {label}
    </button>
  );
  const sortMenu = (e: React.MouseEvent) =>
    showMenu(
      e,
      <>
        {SORTS[show].map((s) => (
          <Item key={s.value} icon={sort === s.value ? <Check size={18} /> : <span style={{ width: 18 }} />} onClick={() => setSort(s.value)}>
            {s.label()}
          </Item>
        ))}
      </>,
    );

  return (
    <div className="page">
      <div className="row__head">
        <h1 className="hello" style={{ margin: 0 }}>
          {t('Your library')}
        </h1>
        <span className="row-gap">
          {canDownload && (
            <Link className="btn btn--small library__downloads" to="/downloads" aria-label={t('Downloads')}>
              <CircleArrowDown size={16} /> <span>{t('Downloads')}</span>
            </Link>
          )}
          {server.data?.services.music && (
            <button className="btn btn--small library__import" onClick={() => setImporting(true)} aria-label={t('Import files')}>
              <FileUp size={16} /> <span>{t('Import files')}</span>
            </button>
          )}
          <button className="btn btn--small" onClick={() => pickPlaylist([])}>
            <Plus size={16} /> {t('New playlist')}
          </button>
        </span>
      </div>
      {importing && <ImportFiles target={{ kind: 'any' }} onClose={() => setImporting(false)} />}
      <div className="library__bar">
        <div className="segments" role="tablist">
          {view('playlists', t('Playlists'))}
          {view('albums', t('Albums'))}
          {view('artists', t('Artists'))}
        </div>
        <button className="library__sort" aria-label={t('Sort')} onClick={sortMenu}>
          <ArrowUpDown size={18} />
          <span>{SORTS[show].find((s) => s.value === sort)?.label()}</span>
        </button>
      </div>

      {show === 'playlists' &&
        (lists.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid">
            <Link className="card" to="/liked">
              <div className="card__art">
                <LikedCover />
              </div>
              <div className="card__title">{t('Liked songs')}</div>
              <div className="card__sub">{tn(liked.data?.tracks.length ?? 0, '{n} song', '{n} songs')}</div>
            </Link>
            {[...(lists.data ?? [])]
              .sort((a, b) =>
                sorts.playlists === 'name'
                  ? byName(a, b)
                  : sorts.playlists === 'owner'
                    ? Number(b.mine) - Number(a.mine) || (a.owner ?? '').localeCompare(b.owner ?? '', locale) || byName(a, b)
                    : (b.created ?? '').localeCompare(a.created ?? ''),
              )
              .map((p) => (
                <PlaylistCard key={p.id} playlist={p} />
              ))}
          </div>
        ))}

      {show === 'albums' && (
        <>
          {albums.isLoading ? (
            <Spinner />
          ) : albums.data?.length ? (
            <div className="grid">
              {albums.data.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </div>
          ) : (
            <Empty>{t('No albums yet')}</Empty>
          )}
        </>
      )}

      {show === 'artists' &&
        (artists.isLoading ? (
          <Spinner />
        ) : artists.data?.length ? (
          <div className="grid">
            {[...artists.data]
              .sort((a, b) => (sorts.artists === 'albums' && (b.albumCount ?? 0) - (a.albumCount ?? 0)) || byName(a, b))
              .map((a) => (
                <ArtistCard key={a.id} artist={a} />
              ))}
          </div>
        ) : (
          <Empty>{t('No artists yet')}</Empty>
        ))}
    </div>
  );
}

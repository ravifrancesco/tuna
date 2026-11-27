import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleArrowDown, CirclePlus, FileUp, Plus, RotateCw, Search as SearchIcon } from 'lucide-react';
import type { GetState, Track, WorldAlbum } from '@tuna/shared';
import { api, ApiError } from '../api';
import { t } from '../i18n';
import { canDownload, download, removeDownload, useDownload } from '../lib/downloads';
import { arrivedSoon, idKey, songKey, useGetState } from '../lib/getting';
import { ImportFiles, type ImportTarget } from './ImportFiles';
import { Item, showMenu } from './Menu';
import { toast } from './ui';

/**
 * Get, for an album that isn't in the library: then where it's at ("Looking", "On its way · 40%",
 * "In your library"). It checks again by itself while something is on its way.
 */
export function GetButton({ album, onAsk, importAs }: { album: WorldAlbum; onAsk?: () => Promise<GetState>; importAs?: ImportTarget }) {
  const qc = useQueryClient();
  const [get, setGet] = useState<GetState>(album.get);
  const [busy, setBusy] = useState(false);
  const server = useQuery({ queryKey: ['server'], queryFn: api.server, staleTime: 60_000 });
  const [importing, setImporting] = useState(false);
  useEffect(() => setGet(album.get), [album.get]);

  const pending = get.state === 'looking' || get.state === 'downloading';
  const live = useGetState(pending ? idKey(album.mbid) : undefined);
  useEffect(() => {
    if (!live) return;
    setGet(live);
    if (live.state === 'ready') arrivedSoon(() => void qc.invalidateQueries());
  }, [live, qc]);

  const ask = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setBusy(true);
    try {
      setGet(await (onAsk ? onAsk() : api.get(album)));
      toast(t('Asked for "{title}"', { title: album.title }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("Couldn't ask for it"));
    } finally {
      setBusy(false);
    }
  };

  if (album.albumId || get.state === 'ready') {
    const id = album.albumId ?? (get.state === 'ready' ? get.albumId : undefined);
    const inner = (
      <>
        <Check size={14} /> {t('In your library')}
      </>
    );
    return id ? (
      <Link className="get get--ready" to={`/album/${id}`} onClick={(e) => e.stopPropagation()}>
        {inner}
      </Link>
    ) : (
      <span className="get get--ready">{inner}</span>
    );
  }
  if (get.state === 'looking')
    return (
      <span className="get get--busy">
        <SearchIcon size={13} /> {t('Looking')}
      </span>
    );
  if (get.state === 'downloading')
    return (
      <span className="get get--busy" title={get.left ? t('{left} left', { left: get.left }) : undefined}>
        <span className="get__bar">
          <i style={{ width: `${Math.round(get.progress * 100)}%` }} />
        </span>
        {t('On its way')} · {Math.round(get.progress * 100)}%
      </span>
    );
  // Not found: look again, or (where Tuna has the music folder) files of their own.
  if (get.state === 'notFound')
    return (
      <>
        <button
          className="get get--missing"
          disabled={busy}
          onClick={(e) =>
            server.data?.services.music
              ? showMenu(
                  e,
                  <>
                    <Item icon={<RotateCw size={18} />} onClick={() => void ask()}>
                      {t('Look again')}
                    </Item>
                    <Item icon={<FileUp size={18} />} onClick={() => setImporting(true)}>
                      {t('Import files')}
                    </Item>
                  </>,
                )
              : void ask(e)
          }
        >
          {server.data?.services.music ? t('Not found yet') : t('Not found yet · Try again')}
        </button>
        {importing && (
          <ImportFiles
            target={importAs ?? { kind: 'album', artist: album.artist, album: album.title, mbid: album.mbid }}
            onClose={() => setImporting(false)}
            onSent={() => (setGet({ state: 'looking' }), void qc.invalidateQueries())}
          />
        )}
      </>
    );
  return (
    <button className="get" onClick={ask} disabled={busy}>
      <Plus size={14} /> {t('Get')}
    </button>
  );
}

/**
 * Get for one song, small, at the end of its row: then a spinner, a ring as it downloads, and once
 * it's in the library, the round arrow that keeps it on this device (in the apps).
 */
export function SongGet({ song, get: given, album }: { song: { title: string; artist: string }; get?: GetState; album?: string }) {
  const qc = useQueryClient();
  const [get, setGet] = useState<GetState>(given ?? { state: 'none' });
  useEffect(() => setGet(given ?? { state: 'none' }), [given]);
  const pending = get.state === 'looking' || get.state === 'downloading';
  const live = useGetState(pending ? songKey(song.title, song.artist) : undefined);
  useEffect(() => {
    if (!live) return;
    setGet(live);
    if (live.state === 'ready') arrivedSoon(() => void qc.invalidateQueries());
  }, [live, qc]);
  const [importing, setImporting] = useState(false);

  const ask = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setGet({ state: 'looking' });
    try {
      await api.getSongs([{ artist: song.artist, title: song.title, album }]);
    } catch (err) {
      setGet({ state: 'none' });
      toast(err instanceof ApiError ? err.message : t("Couldn't ask for it"));
    }
  };

  if (get.state === 'ready') return get.track && canDownload ? <KeepOnDevice track={get.track} /> : <Check size={18} className="song-get song-get--done" aria-label={t('In your library')} />;
  // A dot: still while it waits its turn, glowing while it's looked for, filling up as it comes.
  if (get.state === 'looking')
    return (
      <span className="song-get" role="status" aria-label={get.queued ? t('Waiting') : t('Looking')} title={get.queued ? t('Waiting') : t('Looking')}>
        <i className={`song-dot ${get.queued ? 'song-dot--queued' : 'song-dot--looking'}`} />
      </span>
    );
  if (get.state === 'downloading')
    return (
      <span className="song-get" role="status" aria-label={`${t('On its way')} · ${Math.round(get.progress * 100)}%`} title={`${t('On its way')} · ${Math.round(get.progress * 100)}%`}>
        <i className="song-dot song-dot--coming">
          <i style={{ transform: `scaleY(${Math.max(0.08, Math.min(1, get.progress))})` }} />
        </i>
      </span>
    );
  // Not found: look again, or (where Tuna has the music folder) files of their own.
  const missing = async (e: React.MouseEvent) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
    e.preventDefault();
    e.stopPropagation();
    const server = await qc.fetchQuery({ queryKey: ['server'], queryFn: api.server, staleTime: 60_000 }).catch(() => undefined);
    if (!server?.services.music) return void ask();
    showMenu(
      at,
      <>
        <Item icon={<RotateCw size={18} />} onClick={() => void ask()}>
          {t('Look again')}
        </Item>
        <Item icon={<FileUp size={18} />} onClick={() => setImporting(true)}>
          {t('Import files')}
        </Item>
      </>,
    );
  };
  const label = get.state === 'notFound' ? t('Not found yet') : t('Get');
  return (
    <>
      <button className={`song-get ${get.state === 'notFound' ? 'song-get--missing' : ''}`} onClick={(e) => (get.state === 'notFound' ? void missing(e) : void ask(e))} aria-label={label} title={label}>
        <CirclePlus size={20} />
      </button>
      {importing && <ImportFiles target={{ kind: 'song', title: song.title, artist: song.artist, album }} onClose={() => setImporting(false)} onSent={setGet} />}
    </>
  );
}

/** The round arrow: keeps a song on this device, or (filled) takes it off again. */
function KeepOnDevice({ track }: { track: Track }) {
  const kept = useDownload(track.id);
  return (
    <button
      className={`song-get ${kept ? 'song-get--kept' : ''}`}
      aria-label={kept ? t('Remove download') : t('Download')}
      title={kept ? t('Remove download') : t('Download')}
      onClick={(e) => {
        e.stopPropagation();
        if (kept) removeDownload(track.id);
        else download({ id: track.id, kind: 'song', title: track.title, subtitle: track.artist, cover: track.cover, tracks: [track] });
      }}
    >
      <CircleArrowDown size={20} />
    </button>
  );
}

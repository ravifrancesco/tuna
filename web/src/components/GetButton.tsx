import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleArrowDown, CirclePlus, Plus, RotateCw, Search as SearchIcon } from 'lucide-react';
import type { GetState, Track, WorldAlbum } from '@tuna/shared';
import { api, ApiError } from '../api';
import { t } from '../i18n';
import { canDownload, download, removeDownload, useDownload } from '../lib/downloads';
import { toast } from './ui';

/**
 * Get, for an album that isn't in the library: then where it's at ("Looking", "On its way · 40%",
 * "In your library"). It checks again by itself while something is on its way.
 */
export function GetButton({ album, onAsk }: { album: WorldAlbum; onAsk?: () => Promise<GetState> }) {
  const qc = useQueryClient();
  const [get, setGet] = useState<GetState>(album.get);
  const [busy, setBusy] = useState(false);
  useEffect(() => setGet(album.get), [album.get]);

  const pending = get.state === 'looking' || get.state === 'downloading';
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(async () => {
      const list = await api.getting().catch(() => undefined);
      const mine = list?.find((x) => x.mbid === album.mbid) ?? list?.find((x) => x.kind === 'song' && x.title === album.title && x.artist === album.artist);
      if (mine) setGet(mine.get);
      if (mine?.get.state === 'ready') void qc.invalidateQueries();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, album.mbid, qc]);

  const ask = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
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
  if (get.state === 'notFound')
    return (
      <button className="get get--missing" onClick={ask} disabled={busy}>
        {t('Not found yet · Try again')}
      </button>
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
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(async () => {
      const list = await api.getting().catch(() => undefined);
      const mine = list?.find((x) => x.kind === 'song' && x.title === song.title && x.artist === song.artist);
      if (mine) setGet(mine.get);
      if (mine?.get.state === 'ready') void qc.invalidateQueries();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, song.title, song.artist, qc]);

  const ask = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setGet({ state: 'looking' });
    try {
      await api.getSongs([{ artist: song.artist, title: song.title, album }]);
    } catch (err) {
      setGet({ state: 'none' });
      toast(err instanceof ApiError ? err.message : t("Couldn't ask for it"));
    }
  };

  if (get.state === 'ready') return get.track && canDownload ? <KeepOnDevice track={get.track} /> : <Check size={18} className="song-get song-get--done" aria-label={t('In your library')} />;
  if (get.state === 'looking')
    return (
      <span className="song-get song-get--busy" role="status" aria-label={t('Looking')}>
        <i className="song-get__spin" />
      </span>
    );
  if (get.state === 'downloading')
    return (
      <span className="song-get song-get--busy" role="status" aria-label={`${t('On its way')} · ${Math.round(get.progress * 100)}%`}>
        <svg viewBox="0 0 24 24" className="song-get__ring">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="9" pathLength={100} strokeDasharray={`${Math.max(4, get.progress * 100)} 100`} />
        </svg>
      </span>
    );
  return (
    <button className="song-get" onClick={(e) => void ask(e)} aria-label={get.state === 'notFound' ? t('Not found yet · Try again') : t('Get')} title={get.state === 'notFound' ? t('Not found yet · Try again') : t('Get')}>
      {get.state === 'notFound' ? <RotateCw size={18} /> : <CirclePlus size={20} />}
    </button>
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

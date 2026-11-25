import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Search as SearchIcon } from 'lucide-react';
import type { GetState, WorldAlbum } from '@tuna/shared';
import { api, ApiError } from '../api';
import { t } from '../i18n';
import { toast } from './ui';

/**
 * Get, for an album that isn't in the library: then where it's at ("Looking", "On its way · 40%",
 * "In your library"). It checks again by itself while something is on its way.
 */
export function GetButton({ album }: { album: WorldAlbum }) {
  const qc = useQueryClient();
  const [get, setGet] = useState<GetState>(album.get);
  const [busy, setBusy] = useState(false);
  useEffect(() => setGet(album.get), [album.get]);

  const pending = get.state === 'looking' || get.state === 'downloading';
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(async () => {
      const list = await api.getting().catch(() => undefined);
      const mine = list?.find((x) => x.mbid === album.mbid);
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
      setGet(await api.get(album));
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

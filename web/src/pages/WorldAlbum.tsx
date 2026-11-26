import { Link, Navigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { GetButton } from '../components/GetButton';
import { Cover, Empty, Spinner } from '../components/ui';
import { t } from '../i18n';
import { clock, length, songs } from '../lib/format';
import { artUrl } from '../lib/session';

/** An album that isn't in the library: its cover and songs, with Get. */
export function WorldAlbum() {
  const { mbid = '' } = useParams();
  const album = useQuery({ queryKey: ['worldAlbum', mbid], queryFn: () => api.worldAlbum(mbid) });
  if (album.isLoading) return <Spinner />;
  const a = album.data;
  if (!a) return <Empty>{t("Couldn't find this album")}</Empty>;
  if (a.albumId) return <Navigate to={`/album/${a.albumId}`} replace />;
  const total = a.tracks.reduce((sum, x) => sum + (x.duration ?? 0), 0);
  const type = a.type === 'EP' ? t('EP') : a.type === 'Single' ? t('Single') : t('Album');
  return (
    <div className="page--flush">
      <header className="hero">
        <Cover src={artUrl(a.cover)} size={600} />
        <div>
          <div className="hero__kind">
            {type} · {t('Not in your library')}
          </div>
          <h1>{a.title}</h1>
          <div className="hero__meta">
            {a.artistMbid ? <Link to={`/world/artist/${a.artistMbid}`}>{a.artist}</Link> : a.artist}
            {a.year ? ` · ${a.year}` : ''}
            {a.tracks.length ? ` · ${songs(a.tracks.length)}${total ? `, ${length(total)}` : ''}` : ''}
          </div>
        </div>
      </header>
      <div className="actions">
        <GetButton album={a} />
      </div>
      <div className="section">
        <div className="tracks" role="list">
          {a.tracks.map((x, i) => (
            <div className="track track--waiting" role="listitem" key={i}>
              <div className="track__n">
                <span>{i + 1}</span>
              </div>
              <div className="track__main">
                <div className="track__text">
                  <span className="track__title">{x.title}</span>
                  <span className="track__artist">{a.artist}</span>
                </div>
              </div>
              <div />
              <div />
              <div className="track__time">{x.duration ? clock(x.duration) : ''}</div>
            </div>
          ))}
        </div>
        {!a.tracks.length && <Empty>{t('No songs listed')}</Empty>}
      </div>
    </div>
  );
}

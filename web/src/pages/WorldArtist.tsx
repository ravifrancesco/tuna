import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { WorldAlbum } from '@tuna/shared';
import { api } from '../api';
import { WorldAlbumCard } from '../components/Cards';
import { Cover, Empty, Spinner } from '../components/ui';
import { t } from '../i18n';

const TYPES: Array<{ type: WorldAlbum['type']; title: () => string }> = [
  { type: 'Album', title: () => t('Albums') },
  { type: 'EP', title: () => t('EPs') },
  { type: 'Single', title: () => t('Singles') },
  { type: 'Other', title: () => t('Other') },
];

/** An artist from MusicBrainz: everything they made, with Get for what isn't in the library. */
export function WorldArtist() {
  const { mbid = '' } = useParams();
  const artist = useQuery({ queryKey: ['worldArtist', mbid], queryFn: () => api.worldArtist(mbid) });
  if (artist.isLoading) return <Spinner />;
  const a = artist.data;
  if (!a) return <Empty>{t("Couldn't find this artist")}</Empty>;
  return (
    <div className="page--flush">
      <header className="hero">
        <Cover round size={600} />
        <div>
          <div className="hero__kind">{a.artistId ? t('In your library') : t('Not in your library')}</div>
          <h1>{a.name}</h1>
          <div className="hero__meta">
            {a.disambiguation}
            {a.artistId && (
              <>
                {a.disambiguation ? ' · ' : ''}
                <Link to={`/artist/${a.artistId}`}>{t('Open in your library')}</Link>
              </>
            )}
          </div>
        </div>
      </header>
      {TYPES.map(({ type, title }) => {
        const list = a.albums.filter((x) => x.type === type);
        if (!list.length) return null;
        return (
          <div className="section" key={type}>
            <h2>{title()}</h2>
            <div className="grid">
              {list.map((x) => (
                <WorldAlbumCard key={x.mbid} album={x} />
              ))}
            </div>
          </div>
        );
      })}
      {!a.albums.length && <Empty>{t('Nothing found')}</Empty>}
    </div>
  );
}

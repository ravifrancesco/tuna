import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { GetButton } from '../components/GetButton';
import { Cover, Empty, Spinner } from '../components/ui';
import { t } from '../i18n';
import { ago } from '../lib/format';
import { artUrl } from '../lib/session';

/** What's been asked for, and where each one is. */
export function Getting() {
  const list = useQuery({
    queryKey: ['getting'],
    queryFn: api.getting,
    refetchInterval: (q) => (q.state.data?.some((x) => x.get.state === 'looking' || x.get.state === 'downloading') ? 5000 : 60_000),
  });
  return (
    <div className="page">
      <h1 className="hello">{t('On its way')}</h1>
      {list.isLoading && <Spinner />}
      {list.data && !list.data.length && <Empty>{t('Nothing asked for yet')}</Empty>}
      {list.data?.map((x) => (
        <div className="list-item" key={x.mbid}>
          <Cover src={artUrl(x.cover)} size={150} />
          <div className="list-item__text">
            <b>{x.title}</b>
            <small>
              {x.artist} · {t('{name}, {when}', { name: x.by, when: ago(x.at) })}
            </small>
          </div>
          <GetButton album={{ mbid: x.mbid, title: x.title, artist: x.artist, get: x.get }} />
        </div>
      ))}
    </div>
  );
}

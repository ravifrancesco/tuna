import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { GetButton } from '../components/GetButton';
import { Cover, Empty, Spinner, toast } from '../components/ui';
import { t, tn } from '../i18n';
import { ago } from '../lib/format';
import { artUrl, useMe } from '../lib/session';

/** Albums Get all still has to ask for (a few at a time), with Stop for whoever asked, or an admin. */
function StillToAsk() {
  const qc = useQueryClient();
  const me = useMe();
  const left = useQuery({ queryKey: ['still-to-ask'], queryFn: api.stillToAsk, refetchInterval: 15_000 });
  if (!left.data?.count) return null;
  const stop = async () => {
    const { stopped } = await api.stopAsking();
    toast(tn(stopped, 'Stopped asking for {n} album', 'Stopped asking for {n} albums'));
    void qc.invalidateQueries({ queryKey: ['still-to-ask'] });
  };
  return (
    <div className="list-item list-item--quiet">
      <div className="list-item__text">
        <b>{tn(left.data.count, '{n} more album to ask for', '{n} more albums to ask for')}</b>
      </div>
      {(me?.admin || left.data.mine > 0) && (
        <button className="btn btn--small" onClick={() => void stop()}>
          {t('Stop')}
        </button>
      )}
    </div>
  );
}

/** What's been asked for, and where each one is. */
/** Albums asked for by name (Get all, a playlist's missing songs) that couldn't be found. */
function Missed() {
  const qc = useQueryClient();
  const missed = useQuery({ queryKey: ['missed'], queryFn: api.missed, refetchInterval: 30_000 });
  const [retried, setRetried] = useState(false);
  if (!missed.data?.length) return null;
  const retry = async () => {
    setRetried(true);
    await api.getMany(missed.data.map((m) => ({ artist: m.artist, album: m.album })));
    void qc.invalidateQueries({ queryKey: ['still-to-ask'] });
  };
  return (
    <section className="section">
      <div className="row__head">
        <h2>{t("Couldn't find")}</h2>
        <button className="btn btn--small" disabled={retried} onClick={() => void retry()}>
          {t('Try again')}
        </button>
      </div>
      {missed.data.slice(0, 100).map((m) => (
        <div className="list-item list-item--quiet" key={`${m.artist}|${m.album}`}>
          <div className="list-item__text">
            <b>{m.album}</b>
            <small>
              {m.artist} · {t('{name}, {when}', { name: m.by, when: ago(new Date(m.at).toISOString()) })}
            </small>
          </div>
        </div>
      ))}
    </section>
  );
}

export function Getting() {
  // Each visit says it's been opened first (its own list, so the sidebar's doesn't flash up meanwhile).
  const visit = useRef(false);
  const list = useQuery({
    queryKey: ['getting', 'page'],
    queryFn: () => (visit.current ? api.getting() : ((visit.current = true), api.gettingOpened())),
    gcTime: 0,
    refetchInterval: (q) => (q.state.data?.some((x) => x.get.state === 'looking' || x.get.state === 'downloading') ? 5000 : 60_000),
  });
  return (
    <div className="page">
      <h1 className="hello">{t('On its way')}</h1>
      <StillToAsk />
      {list.isLoading && <Spinner />}
      {list.data && !list.data.length && <Empty>{t('Nothing on its way')}</Empty>}
      {list.data?.map((x) => (
        <div className="list-item" key={x.mbid}>
          <Cover src={artUrl(x.cover)} size={150} />
          <div className="list-item__text">
            <b>{x.title}</b>
            <small>
              {x.kind === 'song' && x.album ? `${x.artist} · ${x.album}` : x.artist} · {t('{name}, {when}', { name: x.by, when: ago(x.at) })}
            </small>
          </div>
          <GetButton
            album={{ mbid: x.mbid, title: x.title, artist: x.artist, get: x.get }}
            onAsk={x.kind === 'song' ? () => api.getSongs([{ artist: x.artist, title: x.title, album: x.album }]).then(() => ({ state: 'looking' as const })) : undefined}
          />
        </div>
      ))}
      <Missed />
    </div>
  );
}

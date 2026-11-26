import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LogOut, Settings, Sparkles } from 'lucide-react';
import type { Listen, StatsPeriod } from '@tuna/shared';
import { api } from '../api';
import { AlbumCard, ArtistCard, Row } from '../components/Cards';
import { Avatar, signOut } from '../components/Profile';
import { TrackList } from '../components/TrackList';
import { YearStory } from '../components/YearStory';
import { Cover, Empty, Spinner } from '../components/ui';
import { locale, t, tn } from '../i18n';
import { length } from '../lib/format';
import { playTracks } from '../lib/player';
import { useMe } from '../lib/session';

const PERIODS: { value: StatsPeriod; label: () => string }[] = [
  { value: 'week', label: () => t('Week') },
  { value: 'month', label: () => t('Month') },
  { value: 'year', label: () => t('Year') },
  { value: 'all', label: () => t('All time') },
];

const plays = (n: number) => tn(n, '{n} play', '{n} plays');

/** Who's signed in: what they listen to, and the way to Settings. */
export function Profile() {
  const me = useMe();
  const [period, setPeriod] = useState<StatsPeriod>('month');
  const stats = useQuery({ queryKey: ['stats', period], queryFn: () => api.stats(period), placeholderData: keepPreviousData });
  const [story, setStory] = useState(false);
  const year = new Date().getFullYear();
  if (!me) return null;
  const s = stats.data;
  return (
    <div className="page profile">
      <div className="profile__head">
        <Avatar me={me} size={84} />
        <div className="profile__who">
          <h1>{me.name}</h1>
          <span>
            {me.username} · {me.admin ? t('Administrator') : t('Member')}
          </span>
        </div>
      </div>
      <div className="profile__actions">
        <Link className="btn btn--small" to="/settings">
          <Settings size={16} /> {t('Settings')}
        </Link>
        <button className="btn btn--small" onClick={() => void signOut()}>
          <LogOut size={16} /> {t('Sign out')}
        </button>
      </div>
      {stats.data?.since && (
        <button className="year-card" onClick={() => setStory(true)}>
          <Sparkles size={22} />
          <span>
            <b>{t('Your {year} in music', { year })}</b>
            <small>{t('See your year')}</small>
          </span>
        </button>
      )}
      {story && <YearStory year={year} onClose={() => setStory(false)} />}

      <div className="segments" role="tablist">
        {PERIODS.map((p) => (
          <button key={p.value} role="tab" aria-selected={period === p.value} className={period === p.value ? 'on' : ''} onClick={() => setPeriod(p.value)}>
            {p.label()}
          </button>
        ))}
      </div>
      {!s ? (
        <Spinner />
      ) : !s.plays ? (
        <Empty>{s.since ? t('Nothing played in this time') : t('Nothing played yet')}</Empty>
      ) : (
        <>
          <div className="stat-tiles">
            <div>
              <b>{length(s.seconds)}</b>
              <span>{t('Listening time')}</span>
            </div>
            <div>
              <b>{s.plays.toLocaleString(locale)}</b>
              <span>{t('Songs played')}</span>
            </div>
            <div>
              <b>{s.artists.toLocaleString(locale)}</b>
              <span>{t('Artists')}</span>
            </div>
          </div>
          {s.topArtists.length > 0 && (
            <Row title={t('Top artists')}>
              {s.topArtists.map((a) => (
                <ArtistCard key={a.id} artist={a} sub={plays(a.plays)} />
              ))}
            </Row>
          )}
          <section className="row">
            <div className="row__head">
              <h2>{t('Top songs')}</h2>
            </div>
            <TrackList tracks={s.topSongs} source={{ kind: 'queue', title: t('Top songs') }} compact />
          </section>
          {s.topAlbums.length > 0 && (
            <Row title={t('Top albums')}>
              {s.topAlbums.map((a) => (
                <AlbumCard key={a.id} album={a} sub={plays(a.plays)} />
              ))}
            </Row>
          )}
        </>
      )}
      <History />
    </div>
  );
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
function day(at: Date): string {
  const now = new Date();
  if (sameDay(at, now)) return t('Today');
  if (sameDay(at, new Date(now.getTime() - 86_400_000))) return t('Yesterday');
  return at.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Every play, newest first, by day. */
function History() {
  const [size, setSize] = useState(40);
  const history = useQuery({ queryKey: ['history', size], queryFn: () => api.history(0, size), placeholderData: keepPreviousData });
  const list = history.data ?? [];
  if (!list.length) return null;
  const days: { label: string; items: (Listen & { i: number })[] }[] = [];
  list.forEach((l, i) => {
    const label = day(new Date(l.at));
    if (days.at(-1)?.label !== label) days.push({ label, items: [] });
    days.at(-1)!.items.push({ ...l, i });
  });
  const tracks = list.map((l) => l.track);
  return (
    <section className="row history">
      <div className="row__head">
        <h2>{t('Listening history')}</h2>
      </div>
      {days.map((d) => (
        <div key={d.label}>
          <h3 className="history__day">{d.label}</h3>
          {d.items.map(({ at, track, i }) => (
            <button key={`${at}-${track.id}`} className="history__item" onClick={() => playTracks(tracks, i, { kind: 'queue', title: t('Listening history') }, { shuffle: false })}>
              <Cover cover={track.cover} size={100} />
              <span className="history__text">
                <b>{track.title}</b>
                <span>{track.artist}</span>
              </span>
              <time dateTime={at}>{new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time>
            </button>
          ))}
        </div>
      ))}
      {list.length === size && (
        <button className="btn btn--small" onClick={() => setSize(size + 40)}>
          {t('Show more')}
        </button>
      )}
    </section>
  );
}

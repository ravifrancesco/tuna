import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, X } from 'lucide-react';
import { api } from '../api';
import { locale, t, tn } from '../i18n';
import { playTracks } from '../lib/player';
import { Cover, Spinner } from './ui';

const plays = (n: number) => tn(n, '{n} play', '{n} plays');

/** Someone's year in music, one card at a time: tap the right side for the next, the left to go back. */
export function YearStory({ year, onClose }: { year: number; onClose: () => void }) {
  const y = useQuery({ queryKey: ['year', year], queryFn: () => api.year(year) });
  const [at, setAt] = useState(0);
  const d = y.data;
  const cards: React.ReactNode[] = !d
    ? []
    : !d.plays
      ? [
          <div className="year__card" key="none">
            <h2>{t('Your {year} in music', { year })}</h2>
            <p>{t('Not much this year yet')}</p>
          </div>,
        ]
      : [
          <div className="year__card" key="intro">
            <p className="year__kicker">{t('Your {year} in music', { year })}</p>
            <h2 className="year__big">{tn(Math.round(d.seconds / 60), '{n} minute', '{n} minutes')}</h2>
            <p>
              {plays(d.plays)} {tn(d.days, 'on {n} day', 'on {n} days')}
            </p>
          </div>,
          d.topArtists[0] && (
            <div className="year__card" key="artist">
              <p className="year__kicker">{t('Your top artist')}</p>
              <Cover cover={d.topArtists[0].cover} size={600} round />
              <h2>{d.topArtists[0].name}</h2>
              <ol className="year__list">
                {d.topArtists.slice(1).map((a) => (
                  <li key={a.id}>{a.name}</li>
                ))}
              </ol>
            </div>
          ),
          d.topSongs[0] && (
            <div className="year__card" key="song">
              <p className="year__kicker">{t('Your top song')}</p>
              <Cover cover={d.topSongs[0].cover} size={600} />
              <h2>{d.topSongs[0].title}</h2>
              <p>
                {d.topSongs[0].artist} · {plays(d.topSongs[0].plays)}
              </p>
              <ol className="year__list">
                {d.topSongs.slice(1).map((s) => (
                  <li key={s.id}>
                    {s.title} <span>{s.artist}</span>
                  </li>
                ))}
              </ol>
            </div>
          ),
          d.topAlbum && (
            <div className="year__card" key="album">
              <p className="year__kicker">{t('Your top album')}</p>
              <Cover cover={d.topAlbum.cover} size={600} />
              <h2>{d.topAlbum.name}</h2>
              <p>{d.topAlbum.artist}</p>
            </div>
          ),
          <div className="year__card" key="month">
            {d.busiestMonth && (
              <>
                <p className="year__kicker">{t('You listened most in {month}', { month: new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(year, d.busiestMonth.month, 1)) })}</p>
                <h2 className="year__big">{tn(Math.round(d.busiestMonth.seconds / 3600), '{n} hour', '{n} hours')}</h2>
              </>
            )}
            <p>{tn(d.newArtists, '{n} artist you’d never played before', '{n} artists you’d never played before')}</p>
          </div>,
          <div className="year__card" key="end">
            {d.firstSong && (
              <>
                <p className="year__kicker">{t('Your year started with')}</p>
                <Cover cover={d.firstSong.cover} size={600} />
                <h2>{d.firstSong.title}</h2>
                <p>{d.firstSong.artist}</p>
              </>
            )}
            <button
              className="btn btn--primary"
              onClick={(e) => {
                e.stopPropagation();
                playTracks(d.topSongs, 0, { kind: 'mix', id: `year:${year}`, title: t('Your {year}', { year }) }, { shuffle: false });
                onClose();
              }}
            >
              <Play size={18} fill="currentColor" /> {t('Play your top songs')}
            </button>
          </div>,
        ].filter(Boolean);
  const go = (step: number) => setAt((i) => Math.max(0, Math.min(cards.length - 1, i + step)));
  useEffect(() => {
    const key = (e: KeyboardEvent) => (e.key === 'ArrowRight' ? go(1) : e.key === 'ArrowLeft' ? go(-1) : e.key === 'Escape' ? onClose() : undefined);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return (
    <div className={`year year--${at % 4}`} data-layer="top" role="dialog" aria-label={t('Your {year}', { year })} onClick={(e) => go(e.clientX > innerWidth / 3 ? 1 : -1)}>
      <div className="year__bars">
        {cards.map((_, i) => (
          <span key={i} className={i <= at ? 'on' : ''} />
        ))}
      </div>
      <button className="icon-btn year__close" aria-label={t('Close')} data-close onClick={(e) => (e.stopPropagation(), onClose())}>
        <X size={24} />
      </button>
      {y.isLoading ? <Spinner /> : cards[at]}
    </div>
  );
}

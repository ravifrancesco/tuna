import { Link } from 'react-router';
import { Play } from 'lucide-react';
import type { Home } from '@tuna/shared';
import { t } from '../i18n';
import { useTint } from '../lib/tint';
import { playAlbum, playMix } from './Cards';
import { Cover, MixArt } from './ui';

/**
 * The feature at the top of Home: today's first mix, else the album played last, else the newest one.
 */
export function HomeHero({ home }: { home: Home }) {
  const mixes = home.rows.find((r) => r.kind === 'mixes');
  const recent = home.rows.find((r) => r.id === 'recent' && r.kind === 'albums');
  const newest = home.rows.find((r) => r.id === 'newest' && r.kind === 'albums');
  const mix = mixes?.kind === 'mixes' ? mixes.items[0] : undefined;
  const album = !mix ? (recent?.kind === 'albums' ? recent.items[0] : newest?.kind === 'albums' ? newest.items[0] : undefined) : undefined;
  const tint = useTint(mix?.covers[0] ?? album?.cover);
  if (!mix && !album) return null;

  const label = mix ? mixes!.title : album && recent?.kind === 'albums' && recent.items[0] === album ? recent.title : (newest?.title ?? '');
  const title = mix ? mix.title : album!.name;
  const sub = mix ? mix.subtitle : [album!.artist, album!.year].filter(Boolean).join(' · ');
  const to = mix ? `/mix/${encodeURIComponent(mix.id)}` : `/album/${album!.id}`;
  return (
    <section className="hero-feature" style={{ '--tint': tint } as React.CSSProperties}>
      <Link to={to} className="hero-feature__art" aria-label={title}>
        {mix ? <MixArt mix={mix} size={600} /> : <Cover cover={album!.cover} size={600} />}
      </Link>
      <div className="hero-feature__text">
        <div className="hero-feature__label">{label}</div>
        <Link to={to} className="hero-feature__title">
          {title}
        </Link>
        {sub && <div className="hero-feature__sub">{sub}</div>}
        <div className="hero-feature__actions">
          <button className="btn btn--light" onClick={() => void (mix ? playMix(mix) : playAlbum(album!))}>
            <Play size={18} fill="currentColor" /> {t('Play')}
          </button>
          <Link to={to} className="btn btn--glass">
            {t('Open')}
          </Link>
        </div>
      </div>
    </section>
  );
}

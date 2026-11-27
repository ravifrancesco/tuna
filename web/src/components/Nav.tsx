import { Link, NavLink, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity, Home, Library, Plus, Search, Settings } from 'lucide-react';
import type { GetState } from '@tuna/shared';
import { api } from '../api';
import { t } from '../i18n';
import { Brand } from './Logo';
import { pickPlaylist } from './Menu';
import { Cover, LikedCover } from './ui';

/** How many albums are being looked for or downloaded, as Netfish's count by Activity. */
export function useOnItsWay() {
  const { data } = useQuery({ queryKey: ['moving'], queryFn: api.moving, refetchInterval: 15_000 });
  const on = (x: { get: GetState }) => x.get.state === 'looking' || x.get.state === 'downloading';
  return data ? data.songs.filter(on).length + data.albums.filter(on).length : 0;
}

/** Computers and TVs: the sidebar, with your playlists. */
export function Sidebar() {
  const lists = useQuery({ queryKey: ['playlists'], queryFn: api.playlists });
  const loc = useLocation();
  const onItsWay = useOnItsWay();
  return (
    <nav className="side" aria-label={t('Menu')}>
      <div className="side__top">
        <Brand />
        <NavLink className="navlink" to="/" end>
          <Home size={22} /> {t('Home')}
        </NavLink>
        <NavLink className="navlink" to="/search">
          <Search size={22} /> {t('Search')}
        </NavLink>
        <NavLink className="navlink" to="/library">
          <Library size={22} /> {t('Your library')}
        </NavLink>
        <NavLink className="navlink" to="/getting">
          <Activity size={22} /> {t('On its way')}
          {onItsWay > 0 && <span className="nav__count">{onItsWay}</span>}
        </NavLink>
        <NavLink className="navlink" to="/settings">
          <Settings size={22} /> {t('Settings')}
        </NavLink>
      </div>
      <div className="side__lists">
        <h4>
          {t('Playlists')}
          <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={t('New playlist')} onClick={() => pickPlaylist([])}>
            <Plus size={16} />
          </button>
        </h4>
        <Link className={`side__item ${loc.pathname === '/liked' ? 'active' : ''}`} to="/liked">
          <div style={{ width: 40, flex: 'none' }}>
            <LikedCover />
          </div>
          <div>
            {t('Liked songs')}
            <small>{t('Playlist')}</small>
          </div>
        </Link>
        {(lists.data ?? []).map((p) => (
          <Link key={p.id} className={`side__item ${loc.pathname === `/playlist/${p.id}` ? 'active' : ''}`} to={`/playlist/${p.id}`}>
            <Cover cover={p.cover} size={100} />
            <div style={{ minWidth: 0 }}>
              <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
              <small>{p.mine ? t('Playlist') : t('By {name}', { name: p.owner ?? '' })}</small>
            </div>
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** Phones: tabs at the bottom. */
export function Tabs() {
  return (
    <nav className="tabs" aria-label={t('Menu')}>
      <NavLink to="/" end>
        <Home size={24} />
        {t('Home')}
      </NavLink>
      <NavLink to="/search">
        <Search size={24} />
        {t('Search')}
      </NavLink>
      <NavLink to="/library">
        <Library size={24} />
        {t('Your library')}
      </NavLink>
    </nav>
  );
}

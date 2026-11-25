import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleArrowDown, Disc3, Heart, ListEnd, ListPlus, ListStart, Mic2, Plus, Radio, Trash2, X } from 'lucide-react';
import type { Track } from '@tuna/shared';
import { api } from '../api';
import { t } from '../i18n';
import { useLiked } from '../lib/actions';
import { canDownload, download, removeDownload, useDownload, useOnDevice } from '../lib/downloads';
import { addToQueue, playNext, playTracks, removeFromQueue } from '../lib/player';
import { Cover, Sheet, toast } from './ui';

/** Menus: at the pointer on a computer, a sheet from the bottom on a phone. One at a time. */

interface Open {
  x: number;
  y: number;
  content: ReactNode;
}
let openMenu: ((m: Open | undefined) => void) | undefined;

export function showMenu(e: React.MouseEvent | { clientX: number; clientY: number }, content: ReactNode) {
  if ('preventDefault' in e) {
    e.preventDefault();
    e.stopPropagation();
  }
  openMenu?.({ x: e.clientX, y: e.clientY, content });
}
export const closeMenu = () => openMenu?.(undefined);

export function MenuHost() {
  const [menu, setMenu] = useState<Open>();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useEffect(() => {
    openMenu = setMenu;
    return () => {
      openMenu = undefined;
    };
  }, []);
  useEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - r.height - 8)) });
    ref.current.querySelector<HTMLElement>('button, a')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(undefined);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [menu]);
  if (!menu) return null;
  return (
    <div className="menu-layer" data-layer="top" onClick={() => setMenu(undefined)} onContextMenu={(e) => (e.preventDefault(), setMenu(undefined))}>
      <div className="menu" ref={ref} style={pos} role="menu" onClick={(e) => e.stopPropagation()}>
        {menu.content}
      </div>
    </div>
  );
}

export function Item({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={() => {
        closeMenu();
        onClick();
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// ---- Adding to a playlist ------------------------------------------------------------------------------

let openPicker: ((tracks: Track[] | undefined) => void) | undefined;
export const pickPlaylist = (tracks: Track[]) => openPicker?.(tracks);

export function PlaylistPickerHost() {
  const [tracks, setTracks] = useState<Track[]>();
  useEffect(() => {
    openPicker = setTracks;
    return () => {
      openPicker = undefined;
    };
  }, []);
  return tracks ? <PlaylistPicker tracks={tracks} onClose={() => setTracks(undefined)} /> : null;
}

function PlaylistPicker({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: ['playlists'], queryFn: api.playlists });
  const [name, setName] = useState('');
  const ids = tracks.map((x) => x.id);
  const done = (title: string) => {
    void qc.invalidateQueries({ queryKey: ['playlists'] });
    void qc.invalidateQueries({ queryKey: ['playlist'] });
    toast(ids.length ? t('Added to {name}', { name: title }) : t('Made {name}', { name: title }));
    onClose();
  };
  return (
    <Sheet title={ids.length ? t('Add to playlist') : t('New playlist')} onClose={onClose}>
      <form
        className="field"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const p = await api.createPlaylist(name.trim(), ids);
          done(p.name);
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" placeholder={t('New playlist')} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn--primary" type="submit" disabled={!name.trim()}>
            <Plus size={16} /> {t('Create')}
          </button>
        </div>
      </form>
      {(ids.length ? (lists.data ?? []) : [])
        .filter((p) => p.mine)
        .map((p) => (
          <button
            key={p.id}
            className="list-item"
            style={{ width: '100%', textAlign: 'left' }}
            onClick={async () => {
              await api.updatePlaylist(p.id, { add: ids });
              done(p.name);
            }}
          >
            <Cover cover={p.cover} size={100} />
            <div className="list-item__text">
              <b>{p.name}</b>
              <small>{t('{n} songs', { n: p.songCount })}</small>
            </div>
          </button>
        ))}
      <div className="sheet__buttons">
        <button className="btn btn--ghost" onClick={onClose} data-close>
          {t('Cancel')}
        </button>
      </div>
    </Sheet>
  );
}

// ---- A song's menu --------------------------------------------------------------------------------------

export function TrackMenu({ track, onRemove, queueIndex }: { track: Track; onRemove?: () => void; queueIndex?: number }) {
  const navigate = useNavigate();
  const [liked, toggleLike] = useLiked('track', track.id, track.liked);
  return (
    <>
      <div className="menu__head">
        <Cover cover={track.cover} size={100} />
        <div style={{ minWidth: 0 }}>
          <b style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</b>
          <small className="muted">{track.artist}</small>
        </div>
      </div>
      <hr />
      <Item icon={<ListStart size={18} />} onClick={() => (playNext([track]), toast(t('Plays next')))}>
        {t('Play next')}
      </Item>
      <Item icon={<ListEnd size={18} />} onClick={() => (addToQueue([track]), toast(t('Added to the queue')))}>
        {t('Add to queue')}
      </Item>
      <Item icon={<Radio size={18} />} onClick={() => void api.mix(`song:${track.id}`).then((tracks) => playTracks(tracks, 0, { kind: 'mix', id: `song:${track.id}`, title: t('{title} radio', { title: track.title }) }, { shuffle: false }))}>
        {t('Start radio')}
      </Item>
      <Item icon={<ListPlus size={18} />} onClick={() => pickPlaylist([track])}>
        {t('Add to playlist')}
      </Item>
      {canDownload && <DownloadSong track={track} />}
      <Item icon={<Heart size={18} fill={liked ? 'currentColor' : 'none'} />} onClick={toggleLike}>
        {liked ? t('Remove from liked songs') : t('Add to liked songs')}
      </Item>
      <hr />
      {track.albumId && (
        <Item icon={<Disc3 size={18} />} onClick={() => navigate(`/album/${track.albumId}`)}>
          {t('Go to album')}
        </Item>
      )}
      {track.artistId && (
        <Item icon={<Mic2 size={18} />} onClick={() => navigate(`/artist/${track.artistId}`)}>
          {t('Go to artist')}
        </Item>
      )}
      {onRemove && (
        <>
          <hr />
          <Item icon={<Trash2 size={18} />} onClick={onRemove}>
            {t('Remove from this playlist')}
          </Item>
        </>
      )}
      {queueIndex !== undefined && (
        <>
          <hr />
          <Item icon={<X size={18} />} onClick={() => removeFromQueue(queueIndex)}>
            {t('Remove from queue')}
          </Item>
        </>
      )}
    </>
  );
}

/** A single song to keep on the device (unless an album or playlist downloaded has it already). */
function DownloadSong({ track }: { track: Track }) {
  const id = `song:${track.id}`;
  const d = useDownload(id);
  const here = useOnDevice(track.id);
  if (here && !d) return null;
  return (
    <Item icon={<CircleArrowDown size={18} />} onClick={() => (d ? removeDownload(id) : download({ id, kind: 'song', title: track.title, subtitle: track.artist, cover: track.cover, tracks: [track] }))}>
      {d ? t('Remove download') : t('Download')}
    </Item>
  );
}

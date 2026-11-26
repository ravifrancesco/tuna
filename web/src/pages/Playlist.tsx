import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, MoreHorizontal, Pencil, Shuffle, Trash2 } from 'lucide-react';
import { DownloadButton } from '../components/DownloadButton';
import type { download } from '../lib/downloads';
import type { Track, WaitingSong } from '@tuna/shared';
import { api } from '../api';
import { Item, showMenu } from '../components/Menu';
import { PlayButton } from '../components/PlayButton';
import { DateScroller } from '../components/DateScroller';
import { FreshCatchArt } from '../components/FreshCatchArt';
import { TrackList } from '../components/TrackList';
import { Cover, Empty, LikedCover, Sheet, Spinner, toast } from '../components/ui';
import { t, tn } from '../i18n';
import { sum } from '../lib/actions';
import { length, songs } from '../lib/format';
import { playTracks, type Source } from '../lib/player';
import { useTint } from '../lib/tint';
import { useMe } from '../lib/session';

function Header({ kind, title, meta, cover, tint }: { kind: string; title: string; meta: string; cover: React.ReactNode; tint?: string }) {
  return (
    <header className="hero" style={tint ? ({ '--hero': tint } as React.CSSProperties) : undefined}>
      {cover}
      <div>
        <div className="hero__kind">{kind}</div>
        <h1>{title}</h1>
        <div className="hero__meta">{meta}</div>
      </div>
    </header>
  );
}

/** A playlist's songs that aren't here yet, in its order: the songs themselves (or, without slskd, their albums). */
function GetMissing({ waiting }: { waiting: WaitingSong[] }) {
  const [asked, setAsked] = useState<string>();
  if (!waiting.length) return null;
  const said = (r: { asked: number; songs: boolean }) => (r.songs ? tn(r.asked, 'Asked for {n} song', 'Asked for {n} songs') : tn(r.asked, 'Asked for {n} album', 'Asked for {n} albums'));
  return (
    <button
      className="btn btn--small"
      disabled={asked !== undefined}
      onClick={() =>
        void api
          .getSongs(waiting.map((w) => ({ artist: w.artist, title: w.title, album: w.album })))
          .then((r) => (setAsked(said(r)), toast(said(r))))
          .catch((err: Error) => toast(err.message))
      }
    >
      <Download size={16} /> {asked ?? t('Get the missing songs')}
    </button>
  );
}

function PlayActions({ tracks, source, extra, want }: { tracks: Track[]; source: Source; extra?: React.ReactNode; want?: Parameters<typeof download>[0] }) {
  return (
    <div className="actions">
      <PlayButton source={source} disabled={!tracks.length} onPlay={() => playTracks(tracks, 0, source, { shuffle: false })} />
      <button className="icon-btn" aria-label={t('Shuffle')} disabled={!tracks.length} onClick={() => playTracks(tracks, 0, source, { shuffle: true })}>
        <Shuffle size={24} />
      </button>
      {want && <DownloadButton want={want} />}
      {extra}
    </div>
  );
}

export function Playlist() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pl = useQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) });
  const tint = useTint(pl.data?.cover);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  if (pl.isLoading) return <Spinner />;
  const p = pl.data;
  if (!p) return <Empty>{t("Couldn't find this playlist")}</Empty>;
  const source = { kind: 'playlist' as const, id: p.id, title: p.name };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['playlist', id] });
    void qc.invalidateQueries({ queryKey: ['playlists'] });
  };
  return (
    <div className="page--flush">
      <Header
        kind={t('Playlist')}
        title={p.name}
        meta={`${p.owner ?? ''} · ${songs(p.songCount)}, ${length(p.duration)}${p.waiting?.length ? ` · ${tn(p.waiting.length, '{n} not here yet', '{n} not here yet')}` : ''}`}
        cover={<Cover cover={p.cover} size={600} />}
        tint={tint}
      />
      <PlayActions
        tracks={p.tracks}
        source={source}
        want={{ id: `playlist:${p.id}`, kind: 'playlist', title: p.name, subtitle: p.owner, cover: p.cover, tracks: p.tracks }}
        extra={
          p.mine && (
            <button
              className="icon-btn"
              aria-label={t('More')}
              onClick={(e) =>
                showMenu(
                  e,
                  <>
                    <Item icon={<Pencil size={18} />} onClick={() => (setName(p.name), setRenaming(true))}>
                      {t('Rename')}
                    </Item>
                    <Item
                      icon={<Trash2 size={18} />}
                      onClick={async () => {
                        if (!confirm(t('Delete "{name}"?', { name: p.name }))) return;
                        await api.deletePlaylist(p.id);
                        void qc.invalidateQueries({ queryKey: ['playlists'] });
                        toast(t('Playlist deleted'));
                        navigate('/library');
                      }}
                    >
                      {t('Delete')}
                    </Item>
                  </>,
                )
              }
            >
              <MoreHorizontal size={24} />
            </button>
          )
        }
      />
      {p.mine && p.waiting && p.waiting.length > 0 && (
        <div className="section section--tight">
          <GetMissing waiting={p.waiting} />
        </div>
      )}
      <div className="section">
        {p.tracks.length || p.waiting?.length ? (
          <TrackList
            tracks={p.tracks}
            added={p.added}
            waiting={p.waiting}
            source={source}
            onRemove={
              p.mine
                ? async (i) => {
                    await api.updatePlaylist(p.id, { remove: [i] });
                    refresh();
                  }
                : undefined
            }
          />
        ) : (
          <Empty>{t('This playlist is empty')}</Empty>
        )}
      </div>
      <DateScroller />
      {renaming && (
        <Sheet title={t('Rename')} onClose={() => setRenaming(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await api.updatePlaylist(p.id, { name });
              setRenaming(false);
              refresh();
            }}
          >
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <div className="sheet__buttons">
              <button type="button" className="btn btn--ghost" onClick={() => setRenaming(false)} data-close>
                {t('Cancel')}
              </button>
              <button className="btn btn--primary" type="submit" disabled={!name.trim()}>
                {t('Save')}
              </button>
            </div>
          </form>
        </Sheet>
      )}
    </div>
  );
}

export function Liked() {
  const liked = useQuery({ queryKey: ['liked'], queryFn: api.liked });
  const me = useMe();
  if (liked.isLoading) return <Spinner />;
  const tracks = liked.data?.tracks ?? [];
  const waiting = liked.data?.waiting ?? [];
  const source = { kind: 'liked' as const, title: t('Liked songs') };
  return (
    <div className="page--flush">
      <Header
        kind={t('Playlist')}
        title={t('Liked songs')}
        meta={`${me?.name ?? ''} · ${songs(tracks.length)}, ${length(sum(tracks))}${waiting.length ? ` · ${tn(waiting.length, '{n} not here yet', '{n} not here yet')}` : ''}`}
        cover={
          <div style={{ width: 220, flex: 'none' }}>
            <LikedCover />
          </div>
        }
      />
      <PlayActions tracks={tracks} source={source} want={{ id: 'liked', kind: 'liked', title: t('Liked songs'), tracks }} />
      {waiting.length > 0 && (
        <div className="section section--tight">
          <GetMissing waiting={waiting} />
        </div>
      )}
      <div className="section">
        {tracks.length || waiting.length ? <TrackList tracks={tracks} added={liked.data?.added} waiting={waiting} source={source} /> : <Empty>{t('No liked songs yet')}</Empty>}
      </div>
      <DateScroller />
    </div>
  );
}

export function Mix() {
  const { id = '' } = useParams();
  const mix = useQuery({ queryKey: ['mix', id], queryFn: () => api.mix(id), staleTime: 10 * 60_000 });
  const mixes = useQuery({ queryKey: ['mixes'], queryFn: api.mixes, staleTime: 10 * 60_000 });
  if (mix.isLoading) return <Spinner />;
  const tracks = mix.data ?? [];
  const info = mixes.data?.find((m) => m.id === id);
  const named: Record<string, () => string> = { liked: () => t('Liked songs mix'), discover: () => t('Discover'), fresh: () => t('Fresh catch'), unplayed: () => t('Not played yet') };
  const title = info?.title ?? named[id]?.() ?? t('Mix');
  const source = { kind: 'mix' as const, id, title };
  return (
    <div className="page--flush">
      <Header kind={t('Mix')} title={title} meta={info?.subtitle ?? songs(tracks.length)} cover={id === 'fresh' ? <FreshCatchArt /> : <Cover cover={tracks[0]?.cover} size={600} />} />
      <PlayActions tracks={tracks} source={source} />
      <div className="section">{tracks.length ? <TrackList tracks={tracks} source={source} /> : <Empty>{t('Nothing here yet')}</Empty>}</div>
    </div>
  );
}

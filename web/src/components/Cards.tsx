import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import type { Album, Artist, Mix, Playlist, Row as RowData, Track, WorldAlbum, WorldArtist } from '@tuna/shared';
import { api } from '../api';
import { t, tn } from '../i18n';
import { playTracks, type Source } from '../lib/player';
import { artUrl } from '../lib/session';
import { GetButton } from './GetButton';
import { Cover, MixArt } from './ui';

/** Plays something that has to be fetched first (an album, a playlist, a mix). */
export async function playThing(load: () => Promise<Track[]>, source: Source, opts: { shuffle?: boolean } = {}) {
  const tracks = await load();
  playTracks(tracks, 0, source, opts);
}

export const playAlbum = (a: Pick<Album, 'id' | 'name'>, shuffle = false) =>
  playThing(() => api.album(a.id).then((x) => x.tracks), { kind: 'album', id: a.id, title: a.name }, { shuffle });
export const playPlaylist = (p: Pick<Playlist, 'id' | 'name'>, shuffle = false) =>
  playThing(() => api.playlist(p.id).then((x) => x.tracks), { kind: 'playlist', id: p.id, title: p.name }, { shuffle });
export const playMix = (m: Pick<Mix, 'id' | 'title'>) => playThing(() => api.mix(m.id), { kind: 'mix', id: m.id, title: m.title }, { shuffle: false });

function PlayOver({ onPlay, label }: { onPlay: () => void; label: string }) {
  return (
    <button
      className="play-btn"
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPlay();
      }}
    >
      <Play size={20} fill="currentColor" />
    </button>
  );
}

function Card({ to, art, title, sub, onPlay, extra, ready }: { to: string; art: ReactNode; title: string; sub?: ReactNode; onPlay?: () => void; extra?: ReactNode; ready?: () => void }) {
  // Pointed at or touched: what it opens is fetched already, so it shows at once.
  return (
    <Link className="card" to={to} onPointerEnter={ready} onFocus={ready} onTouchStart={ready}>
      <div className="card__art">
        {art}
        {onPlay && <PlayOver onPlay={onPlay} label={t('Play {title}', { title })} />}
      </div>
      <div className="card__title" title={title}>
        {title}
      </div>
      {sub && <div className="card__sub">{sub}</div>}
      {extra}
    </Link>
  );
}

export function AlbumCard({ album, sub }: { album: Album; sub?: string }) {
  const qc = useQueryClient();
  const ready = () => {
    void qc.prefetchQuery({ queryKey: ['album', album.id], queryFn: () => api.album(album.id), staleTime: 60_000 });
    void qc.prefetchQuery({ queryKey: ['album-whole', album.id], queryFn: () => api.albumWhole(album.id), staleTime: 5 * 60_000 });
  };
  return <Card to={`/album/${album.id}`} art={<Cover cover={album.cover} />} title={album.name} sub={sub ?? [album.year, album.artist].filter(Boolean).join(' · ')} onPlay={() => void playAlbum(album)} ready={ready} />;
}

export const ArtistCard = ({ artist, sub }: { artist: Artist; sub?: string }) => (
  <Card to={`/artist/${artist.id}`} art={<Cover cover={artist.cover} round />} title={artist.name} sub={sub ?? t('Artist')} onPlay={() => void playMix({ id: `artist:${artist.id}`, title: artist.name })} />
);

export const PlaylistCard = ({ playlist }: { playlist: Playlist }) => (
  <Card
    to={`/playlist/${playlist.id}`}
    art={<Cover cover={playlist.cover} />}
    title={playlist.name}
    sub={playlist.mine ? tn(playlist.songCount, '{n} song', '{n} songs') : t('By {name}', { name: playlist.owner ?? '' })}
    onPlay={() => void playPlaylist(playlist)}
  />
);

export const MixCard = ({ mix }: { mix: Mix }) => (
  <Card to={`/mix/${encodeURIComponent(mix.id)}`} art={<MixArt mix={mix} />} title={mix.title} sub={mix.subtitle} onPlay={() => void playMix(mix)} />
);

export function WorldAlbumCard({ album }: { album: WorldAlbum }) {
  const to = album.albumId ? `/album/${album.albumId}` : `/world/album/${album.mbid}`;
  return <Card to={to} art={<Cover src={artUrl(album.cover)} />} title={album.title} sub={[album.year, album.artist].filter(Boolean).join(' · ')} extra={<GetButton album={album} />} />;
}

export const WorldArtistCard = ({ artist }: { artist: WorldArtist }) => (
  <Card
    to={artist.artistId ? `/artist/${artist.artistId}` : `/world/artist/${artist.mbid}`}
    art={<Cover src={artist.cover ? artUrl(artist.cover) : undefined} round />}
    title={artist.name}
    sub={artist.artistId ? t('In your library') : (artist.disambiguation ?? t('Artist'))}
  />
);

export function Row({ title, to, children }: { title: string; to?: string; children: ReactNode }) {
  return (
    <section className="row">
      <div className="row__head">
        <h2>{title}</h2>
        {to && <Link to={to}>{t('Show all')}</Link>}
      </div>
      <div className="row__scroll">{children}</div>
    </section>
  );
}

export function HomeRow({ row }: { row: RowData }) {
  switch (row.kind) {
    case 'albums':
      return <Row title={row.title}>{row.items.map((a) => <AlbumCard key={a.id} album={a} />)}</Row>;
    case 'artists':
      return <Row title={row.title}>{row.items.map((a) => <ArtistCard key={a.id} artist={a} />)}</Row>;
    case 'playlists':
      return (
        <Row title={row.title} to="/library?show=playlists">
          {row.items.map((p) => <PlaylistCard key={p.id} playlist={p} />)}
        </Row>
      );
    case 'mixes':
      return <Row title={row.title}>{row.items.map((m) => <MixCard key={m.id} mix={m} />)}</Row>;
    case 'world':
      return <Row title={row.title}>{row.items.map((a) => <WorldAlbumCard key={a.mbid} album={a} />)}</Row>;
    case 'worldArtists':
      return <Row title={row.title}>{row.items.map((a) => <WorldArtistCard key={a.mbid} artist={a} />)}</Row>;
    case 'tracks':
      return null;
  }
}

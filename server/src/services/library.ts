import type { Album, AlbumDetail, Artist, Playlist, PlaylistDetail, Track } from '@tuna/shared';
import { subsonic, type AlbumID3, type ArtistID3, type Child, type PlaylistInfo, type SubsonicAuth } from '../clients/navidrome';
import { MINUTE, TTLCache } from '../lib/cache';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { UpstreamError } from '../lib/upstream';

/** The library, from Navidrome, in Tuna's shapes. */

export const toTrack = (c: Child): Track => ({
  id: c.id,
  title: c.title,
  artist: c.artist ?? t('Unknown artist'),
  artistId: c.artistId,
  album: c.album ?? '',
  albumId: c.albumId,
  duration: c.duration ?? 0,
  track: c.track,
  disc: c.discNumber,
  year: c.year,
  cover: c.coverArt,
  liked: Boolean(c.starred),
  plays: c.playCount,
  suffix: c.suffix,
  bitRate: c.bitRate,
});

export const toAlbum = (a: AlbumID3): Album => ({
  id: a.id,
  name: a.name,
  artist: a.artist ?? t('Unknown artist'),
  artistId: a.artistId,
  year: a.year,
  cover: a.coverArt,
  songCount: a.songCount ?? 0,
  duration: a.duration ?? 0,
  genre: a.genre,
  liked: Boolean(a.starred),
  added: a.created,
  mbid: a.musicBrainzId || undefined,
});

export const toArtist = (a: ArtistID3): Artist => ({
  id: a.id,
  name: a.name,
  cover: a.coverArt,
  albumCount: a.albumCount,
  liked: Boolean(a.starred),
  mbid: a.musicBrainzId || undefined,
});

export const toPlaylist = (p: PlaylistInfo, username: string): Playlist => ({
  id: p.id,
  name: p.name,
  songCount: p.songCount ?? 0,
  duration: p.duration ?? 0,
  cover: p.coverArt,
  owner: p.owner,
  mine: p.owner === username,
  created: p.created,
});

export type AlbumSort = 'newest' | 'recent' | 'frequent' | 'random' | 'starred' | 'alphabeticalByName' | 'alphabeticalByArtist';

export async function albums(auth: SubsonicAuth, type: AlbumSort, size = 40, offset = 0): Promise<Album[]> {
  const r = await subsonic<{ albumList2?: { album?: AlbumID3[] } }>(auth, 'getAlbumList2', { type, size, offset });
  return (r.albumList2?.album ?? []).map(toAlbum);
}

export async function album(auth: SubsonicAuth, id: string): Promise<AlbumDetail> {
  const r = await subsonic<{ album: AlbumID3 }>(auth, 'getAlbum', { id });
  const a = r.album;
  let moreBy: Album[] = [];
  if (a.artistId) {
    try {
      const ar = await subsonic<{ artist: ArtistID3 }>(auth, 'getArtist', { id: a.artistId });
      moreBy = (ar.artist.album ?? []).filter((x) => x.id !== a.id).map(toAlbum);
    } catch {
      /* optional */
    }
  }
  const tracks = (a.song ?? []).map(toTrack).sort((x, y) => (x.disc ?? 1) - (y.disc ?? 1) || (x.track ?? 0) - (y.track ?? 0));
  return { ...toAlbum(a), tracks, moreBy };
}

export async function artists(auth: SubsonicAuth): Promise<Artist[]> {
  // An empty library is an error to Navidrome ("Library not found or empty"); to us it's no artists yet.
  type Index = { artists?: { index?: Array<{ artist?: ArtistID3[] }> } };
  const r = await subsonic<Index>(auth, 'getArtists').catch((err): Index => {
    if (err instanceof UpstreamError && err.status === 404) return {};
    throw err;
  });
  return (r.artists?.index ?? []).flatMap((i) => i.artist ?? []).map(toArtist);
}

export async function playlists(auth: SubsonicAuth): Promise<Playlist[]> {
  const r = await subsonic<{ playlists?: { playlist?: PlaylistInfo[] } }>(auth, 'getPlaylists');
  return (r.playlists?.playlist ?? []).map((p) => toPlaylist(p, auth.username));
}

export async function playlist(auth: SubsonicAuth, id: string): Promise<PlaylistDetail> {
  const r = await subsonic<{ playlist: PlaylistInfo }>(auth, 'getPlaylist', { id });
  return { ...toPlaylist(r.playlist, auth.username), tracks: (r.playlist.entry ?? []).map(toTrack) };
}

export async function createPlaylist(auth: SubsonicAuth, name: string, songIds: string[] = []): Promise<Playlist> {
  const r = await subsonic<{ playlist?: PlaylistInfo }>(auth, 'createPlaylist', { name, songId: songIds });
  log.info('playlists', `${auth.username} made the playlist "${name}"`);
  if (r.playlist) return toPlaylist(r.playlist, auth.username);
  const mine = await playlists(auth);
  return mine.find((p) => p.name === name && p.mine) ?? mine[0];
}

export async function updatePlaylist(
  auth: SubsonicAuth,
  id: string,
  change: { name?: string; add?: string[]; remove?: number[]; order?: string[] },
): Promise<PlaylistDetail> {
  if (change.order) {
    // Subsonic has no "move": the playlist is written again in its new order.
    await subsonic(auth, 'createPlaylist', { playlistId: id, songId: change.order });
  }
  if (change.name || change.add?.length || change.remove?.length) {
    await subsonic(auth, 'updatePlaylist', { playlistId: id, name: change.name, songIdToAdd: change.add, songIndexToRemove: change.remove });
  }
  return playlist(auth, id);
}

export const deletePlaylist = (auth: SubsonicAuth, id: string) => subsonic(auth, 'deletePlaylist', { id });

/** Everything someone likes, newest first; `starred`: when each song was liked (ISO). */
export async function liked(auth: SubsonicAuth): Promise<{ tracks: Track[]; albums: Album[]; artists: Artist[]; starred: Record<string, string> }> {
  const r = await subsonic<{ starred2?: { song?: Child[]; album?: AlbumID3[]; artist?: ArtistID3[] } }>(auth, 'getStarred2');
  const s = r.starred2 ?? {};
  // Newest likes first.
  const bySaved = <T extends { starred?: string }>(xs: T[] = []) => [...xs].sort((a, b) => (b.starred ?? '').localeCompare(a.starred ?? ''));
  const starred = Object.fromEntries((s.song ?? []).flatMap((c) => (c.starred ? [[c.id, c.starred]] : [])));
  return { tracks: bySaved(s.song).map(toTrack), albums: bySaved(s.album).map(toAlbum), artists: bySaved(s.artist).map(toArtist), starred };
}

export async function like(auth: SubsonicAuth, kind: 'track' | 'album' | 'artist', id: string, on: boolean) {
  const key = kind === 'track' ? 'id' : kind === 'album' ? 'albumId' : 'artistId';
  await subsonic(auth, on ? 'star' : 'unstar', { [key]: id });
}

export async function song(auth: SubsonicAuth, id: string): Promise<Track> {
  const r = await subsonic<{ song: Child }>(auth, 'getSong', { id });
  return toTrack(r.song);
}

// ---- What's in the library, to tell "you have this" from "Get" ----------------------------------

export interface LibraryIndex {
  albumByMbid: Map<string, string>;
  albumByName: Map<string, string>;
  artistByMbid: Map<string, string>;
  artistByName: Map<string, string>;
}

/** "The Beatles" and "beatles, the" and "Beatles" match; accents and punctuation don't matter. */
export const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .replace(/, the$/, '')
    .trim();

const indexCache = new TTLCache<LibraryIndex>(1);

/** The whole library is the same for everyone, so one index serves the household. */
export function libraryIndex(auth: SubsonicAuth): Promise<LibraryIndex> {
  return indexCache.wrap('index', 10 * MINUTE, async () => {
    const idx: LibraryIndex = { albumByMbid: new Map(), albumByName: new Map(), artistByMbid: new Map(), artistByName: new Map() };
    for (let offset = 0; offset < 20000; offset += 500) {
      const page = await subsonic<{ albumList2?: { album?: AlbumID3[] } }>(auth, 'getAlbumList2', { type: 'alphabeticalByName', size: 500, offset });
      const list = page.albumList2?.album ?? [];
      for (const a of list) {
        if (a.musicBrainzId) idx.albumByMbid.set(a.musicBrainzId, a.id);
        idx.albumByName.set(`${norm(a.artist ?? '')}|${norm(a.name)}`, a.id);
      }
      if (list.length < 500) break;
    }
    for (const a of await artists(auth)) {
      if (a.mbid) idx.artistByMbid.set(a.mbid, a.id);
      idx.artistByName.set(norm(a.name), a.id);
    }
    return idx;
  });
}

export const forgetLibraryIndex = () => indexCache.clear();

export function findAlbum(idx: LibraryIndex, mbid: string | undefined, artist: string, title: string): string | undefined {
  return (mbid && idx.albumByMbid.get(mbid)) || idx.albumByName.get(`${norm(artist)}|${norm(title)}`);
}

export function findArtist(idx: LibraryIndex, mbid: string | undefined, name: string): string | undefined {
  return (mbid && idx.artistByMbid.get(mbid)) || idx.artistByName.get(norm(name));
}

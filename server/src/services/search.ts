import type { SearchResult, WorldAlbum, WorldArtist } from '@tuna/shared';
import { subsonic, type AlbumID3, type ArtistID3, type Child, type SubsonicAuth } from '../clients/navidrome';
import { mbSearchAlbums, mbSearchArtists } from '../clients/public';
import { settle } from '../lib/async';
import { findArtist, libraryIndex, norm, playlists, toAlbum, toArtist, toTrack } from './library';
import { freshen } from './getting';
import { toWorldAlbum } from './world';

/** Search: the library first (fast), then everything else that exists (MusicBrainz) in a second call. */

export async function searchLibrary(auth: SubsonicAuth, q: string): Promise<Omit<SearchResult, 'world'>> {
  const query = q.trim();
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const [r, lists] = await Promise.all([
    subsonic<{ searchResult3?: { song?: Child[]; album?: AlbumID3[]; artist?: ArtistID3[] } }>(auth, 'search3', {
      query,
      songCount: 20,
      albumCount: 12,
      artistCount: 8,
    }),
    settle(playlists(auth), []),
  ]);
  const s = r.searchResult3 ?? {};
  const n = norm(query);
  return {
    tracks: (s.song ?? []).map(toTrack),
    albums: (s.album ?? []).map(toAlbum),
    artists: (s.artist ?? []).map(toArtist),
    playlists: lists.filter((p) => norm(p.name).includes(n)).slice(0, 6),
  };
}

export async function searchWorld(auth: SubsonicAuth, q: string): Promise<SearchResult['world']> {
  const query = q.trim();
  if (query.length < 2) return { artists: [], albums: [] };
  await freshen();
  const escaped = query.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
  const [artists, groups, idx] = await Promise.all([
    settle(mbSearchArtists(escaped), []),
    settle(mbSearchAlbums(escaped), []),
    libraryIndex(auth),
  ]);
  const worldArtists: WorldArtist[] = artists
    .filter((a) => (a.score ?? 0) >= 60)
    .slice(0, 6)
    .map((a) => ({ mbid: a.id, name: a.name, disambiguation: a.disambiguation || undefined, artistId: findArtist(idx, a.id, a.name) }));
  const albums: WorldAlbum[] = groups
    .filter((g) => (g.score ?? 0) >= 60 && !(g['secondary-types'] ?? []).length)
    .map((g) => toWorldAlbum(g, idx))
    .slice(0, 10);
  return { artists: worldArtists, albums };
}

import type { SearchResult, WorldAlbum, WorldArtist } from '@tuna/shared';
import { subsonic, type AlbumID3, type ArtistID3, type Child, type SubsonicAuth } from '../clients/navidrome';
import * as lidarr from '../clients/lidarr';
import { mbSearchAlbums, mbSearchArtists, type MbArtist, type MbReleaseGroup } from '../clients/public';
import { has } from '../connections';
import { settle } from '../lib/async';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { HttpError } from '../lib/upstream';
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

// Why a search failed, in the log once every few minutes per service rather than every keystroke.
const warned = new Map<string, number>();
function failed(service: string, err: unknown): undefined {
  if (Date.now() - (warned.get(service) ?? 0) > 5 * 60_000) {
    warned.set(service, Date.now());
    log.warn('search', `Couldn't search ${service}`, err);
  }
  return undefined;
}

const names = (types: lidarr.LFoundAlbum['secondaryTypes']) => (types ?? []).map((x) => (typeof x === 'string' ? x : (x.name ?? ''))).filter(Boolean);

/** Lidarr's search: what Get can fetch, and no MusicBrainz rate limit. In MusicBrainz's shapes. */
async function viaLidarr(query: string): Promise<[MbArtist[], MbReleaseGroup[]]> {
  const [artists, albums] = await Promise.all([lidarr.findArtists(query), lidarr.findAlbums(query)]);
  return [
    artists.map((a) => ({ id: a.foreignArtistId, name: a.artistName, disambiguation: a.disambiguation, score: 100 })),
    albums.map((a) => ({
      id: a.foreignAlbumId,
      title: a.title,
      'primary-type': a.albumType,
      'secondary-types': names(a.secondaryTypes),
      'first-release-date': a.releaseDate,
      'artist-credit': a.artist ? [{ name: a.artist.artistName, artist: { id: a.artist.foreignArtistId, name: a.artist.artistName } }] : [],
      score: 100,
    })),
  ];
}

async function viaMusicBrainz(query: string): Promise<[MbArtist[], MbReleaseGroup[]]> {
  const escaped = query.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
  const [artists, groups] = await Promise.all([
    mbSearchArtists(escaped).catch((err) => failed('MusicBrainz', err)),
    mbSearchAlbums(escaped).catch((err) => failed('MusicBrainz', err)),
  ]);
  if (!artists || !groups) throw new HttpError(502, t("Couldn't search all music right now"));
  return [artists, groups];
}

async function find(query: string): Promise<[MbArtist[], MbReleaseGroup[]]> {
  if (has.lidarr()) {
    try {
      return await viaLidarr(query);
    } catch (err) {
      failed('Lidarr', err);
    }
  }
  return viaMusicBrainz(query);
}

export async function searchWorld(auth: SubsonicAuth, q: string): Promise<SearchResult['world']> {
  const query = q.trim();
  if (query.length < 2) return { artists: [], albums: [] };
  await freshen();
  const [[artists, groups], idx] = await Promise.all([find(query), libraryIndex(auth)]);
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

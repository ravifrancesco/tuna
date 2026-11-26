import type { ArtistDetail, Track, WorldAlbum, WorldAlbumDetail, WorldArtist, WorldArtistDetail } from '@tuna/shared';
import { subsonic, type ArtistID3, type Child, type SubsonicAuth } from '../clients/navidrome';
import { coverArtFor, lastfmSimilar, mbArtist, mbArtistAlbums, mbReleaseGroup, mbReleases, mbSearchArtists, type MbReleaseGroup } from '../clients/public';
import { settle } from '../lib/async';
import { log } from '../lib/log';
import { freshen, stateOf } from './getting';
import { songState, withTracks } from './songs';
import { findAlbum, findArtist, libraryIndex, norm, toAlbum, toArtist, toTrack, type LibraryIndex } from './library';

/** Music beyond the library: MusicBrainz says what exists, Lidarr gets it. */

const TYPE: Record<string, WorldAlbum['type']> = { Album: 'Album', Single: 'Single', EP: 'EP' };

export function toWorldAlbum(g: MbReleaseGroup, idx: LibraryIndex): WorldAlbum {
  const credit = g['artist-credit']?.[0];
  const artist = credit?.name ?? credit?.artist.name ?? '';
  const albumId = findAlbum(idx, g.id, artist, g.title);
  return {
    mbid: g.id,
    title: g.title,
    artist,
    artistMbid: credit?.artist.id,
    year: Number(g['first-release-date']?.slice(0, 4)) || undefined,
    cover: coverArtFor(g.id),
    type: TYPE[g['primary-type'] ?? ''] ?? 'Other',
    albumId,
    get: albumId ? { state: 'ready', albumId } : stateOf(g.id),
  };
}

const newestFirst = (a: WorldAlbum, b: WorldAlbum) => (b.year ?? 0) - (a.year ?? 0);
const typeOrder: Record<string, number> = { Album: 0, EP: 1, Single: 2, Other: 3 };

export async function worldArtist(auth: SubsonicAuth, mbid: string): Promise<WorldArtistDetail> {
  await freshen();
  const [a, groups, idx] = await Promise.all([mbArtist(mbid), mbArtistAlbums(mbid), libraryIndex(auth)]);
  const albums = groups
    .map((g) => toWorldAlbum({ ...g, 'artist-credit': g['artist-credit'] ?? [{ name: a.name, artist: { id: mbid, name: a.name } }] }, idx))
    .sort((x, y) => typeOrder[x.type ?? 'Other'] - typeOrder[y.type ?? 'Other'] || newestFirst(x, y));
  return { mbid, name: a.name, disambiguation: a.disambiguation || undefined, artistId: findArtist(idx, mbid, a.name), albums };
}

/** An artist in the library, with what else they made and who's like them. */
export async function artistDetail(auth: SubsonicAuth, id: string): Promise<ArtistDetail> {
  const r = await subsonic<{ artist: ArtistID3 }>(auth, 'getArtist', { id });
  const artist = r.artist;
  const albums = (artist.album ?? []).map(toAlbum).sort((x, y) => (y.year ?? 0) - (x.year ?? 0));

  const [info, top, idx] = await Promise.all([
    settle(
      subsonic<{ artistInfo2?: { biography?: string; musicBrainzId?: string; similarArtist?: ArtistID3[] } }>(auth, 'getArtistInfo2', { id, count: 12 }),
      {},
    ),
    settle(subsonic<{ topSongs?: { song?: Child[] } }>(auth, 'getTopSongs', { artist: artist.name, count: 10 }), {}),
    libraryIndex(auth),
  ]);
  const bio = info.artistInfo2?.biography?.replace(/<a [^>]*>.*?<\/a>\.?/gi, '').replace(/<[^>]+>/g, '').trim() || undefined;
  let topTracks: Track[] = (top.topSongs?.song ?? []).map(toTrack);
  if (!topTracks.length) topTracks = await mostPlayed(auth, albums.slice(0, 6).map((a) => a.id));

  // What else they made: MusicBrainz, minus what's here already.
  let mbid = artist.musicBrainzId || info.artistInfo2?.musicBrainzId || undefined;
  if (!mbid) {
    const found = await settle(mbSearchArtists(`artist:"${artist.name}"`), []);
    mbid = found.find((x) => norm(x.name) === norm(artist.name) && (x.score ?? 0) >= 90)?.id;
  }
  let elsewhere: WorldAlbum[] = [];
  if (mbid) {
    await freshen();
    const groups = await settle(mbArtistAlbums(mbid), [], (err) => log.debug('world', `MusicBrainz: ${String(err)}`));
    elsewhere = groups
      .map((g) => toWorldAlbum({ ...g, 'artist-credit': g['artist-credit'] ?? [{ name: artist.name, artist: { id: mbid!, name: artist.name } }] }, idx))
      .filter((w) => !w.albumId && !albums.some((a) => norm(a.name) === norm(w.title)))
      .sort((x, y) => typeOrder[x.type ?? 'Other'] - typeOrder[y.type ?? 'Other'] || newestFirst(x, y));
  }

  const similar = (info.artistInfo2?.similarArtist ?? []).map(toArtist);
  const lfm = await settle(lastfmSimilar(artist.name, mbid), []);
  const similarElsewhere: WorldArtist[] = lfm
    .filter((s) => s.mbid && !findArtist(idx, s.mbid, s.name))
    .slice(0, 12)
    .map((s) => ({ mbid: s.mbid!, name: s.name }));
  for (const s of lfm) {
    const inLibrary = findArtist(idx, s.mbid, s.name);
    if (inLibrary && !similar.some((x) => x.id === inLibrary) && inLibrary !== id) similar.push({ id: inLibrary, name: s.name, cover: `ar-${inLibrary}` });
  }

  return { ...toArtist(artist), mbid, bio, top: topTracks.slice(0, 10), albums, elsewhere, similar: similar.slice(0, 12), similarElsewhere };
}

async function mostPlayed(auth: SubsonicAuth, albumIds: string[]): Promise<Track[]> {
  const lists = await Promise.all(albumIds.map((id) => settle(subsonic<{ album: { song?: Child[] } }>(auth, 'getAlbum', { id }), { album: {} })));
  return lists
    .flatMap((l) => l.album.song ?? [])
    .map(toTrack)
    .sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0))
    .slice(0, 10);
}

/** The world for an artist in the library (by name), for search and Discover. */
export const worldArtistFromName = (idx: LibraryIndex, name: string, mbid: string): WorldArtist => ({ mbid, name, artistId: findArtist(idx, mbid, name) });

/** An album that isn't in the library: its songs from its earliest official release (the original). */
export async function worldAlbum(auth: SubsonicAuth, mbid: string): Promise<WorldAlbumDetail> {
  await freshen();
  const [group, releases, idx] = await Promise.all([mbReleaseGroup(mbid), settle(mbReleases(mbid), []), libraryIndex(auth)]);
  const withSongs = releases.filter((r) => r.media?.some((m) => m.tracks?.length));
  const official = withSongs.filter((r) => !r.status || /official/i.test(r.status));
  const release = (official.length ? official : withSongs).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))[0];
  const album = toWorldAlbum(group, idx);
  const tracks = (release?.media ?? []).flatMap((m) =>
    (m.tracks ?? []).map((tr) => {
      const title = tr.title || tr.recording?.title || '';
      return { title, duration: tr.length ? Math.round(tr.length / 1000) : undefined, get: songState({ artist: album.artist, title }) };
    }),
  );
  return { ...album, tracks: await withTracks(auth, tracks.map((x) => ({ ...x, artist: album.artist }))) };
}

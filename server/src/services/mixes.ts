import type { Mix, Track } from '@tuna/shared';
import { subsonic, type AlbumID3, type ArtistID3, type Child, type SubsonicAuth } from '../clients/navidrome';
import { lbRecommendations } from '../clients/public';
import { settle } from '../lib/async';
import { HOUR, TTLCache } from '../lib/cache';
import { t } from '../lib/i18n';
import { HttpError } from '../lib/upstream';
import { liked, libraryIndex, norm, toTrack } from './library';
import { nameOf } from '../sessions';
import { blendable, blendCovers, blendTracks, listeners, playedIds } from './listens';

/**
 * Mixes, made from the library when they're played: radio from a song, an album or an artist,
 * a few daily mixes around what each person plays most, their liked songs, and Discover
 * (the songs ListenBrainz suggests that are already here).
 */

const shuffle = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const unique = (tracks: Track[]) => {
  const seen = new Set<string>();
  return tracks.filter((x) => !seen.has(x.id) && seen.add(x.id));
};

/** Never three songs by the same artist in a row. */
function spread(tracks: Track[]): Track[] {
  const out: Track[] = [];
  const rest = [...tracks];
  while (rest.length) {
    const i = rest.findIndex((x) => !(out.length >= 2 && out.at(-1)!.artist === x.artist && out.at(-2)!.artist === x.artist));
    out.push(...rest.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

const similar = (auth: SubsonicAuth, id: string, count = 50) =>
  settle(subsonic<{ similarSongs2?: { song?: Child[] } }>(auth, 'getSimilarSongs2', { id, count }), {}).then((r) =>
    (r.similarSongs2?.song ?? []).map(toTrack),
  );

async function artistSongs(auth: SubsonicAuth, artistId: string, max = 40): Promise<Track[]> {
  const r = await settle(subsonic<{ artist: ArtistID3 }>(auth, 'getArtist', { id: artistId }), { artist: { id: artistId, name: '' } });
  const albums = shuffle(r.artist.album ?? []).slice(0, 5);
  const lists = await Promise.all(albums.map((a) => settle(subsonic<{ album: AlbumID3 }>(auth, 'getAlbum', { id: a.id }), { album: a })));
  return shuffle(lists.flatMap((l) => l.album.song ?? []).map(toTrack)).slice(0, max);
}

async function genreSongs(auth: SubsonicAuth, genre: string | undefined, size = 30): Promise<Track[]> {
  const r = await settle(subsonic<{ randomSongs?: { song?: Child[] } }>(auth, 'getRandomSongs', { size, genre }), {});
  return (r.randomSongs?.song ?? []).map(toTrack);
}

/** Navidrome's own "similar" needs an outside source (Last.fm); without it, the same artist and genre. */
async function radio(auth: SubsonicAuth, seedId: string, artistId?: string, genre?: string): Promise<Track[]> {
  const fromNavidrome = await similar(auth, seedId);
  if (fromNavidrome.length >= 15) return fromNavidrome;
  const [own, sameGenre] = await Promise.all([artistId ? artistSongs(auth, artistId, 15) : [], genreSongs(auth, genre, 35)]);
  return [...fromNavidrome, ...shuffle([...own, ...sameGenre])];
}

const topArtistsCache = new TTLCache<Array<{ id: string; name: string; cover?: string }>>(200);

/** The artists someone plays most, from their most played albums. */
function topArtists(auth: SubsonicAuth) {
  return topArtistsCache.wrap(auth.username, HOUR, async () => {
    const r = await subsonic<{ albumList2?: { album?: AlbumID3[] } }>(auth, 'getAlbumList2', { type: 'frequent', size: 60 });
    const out = new Map<string, { id: string; name: string; cover?: string; plays: number }>();
    for (const a of r.albumList2?.album ?? []) {
      if (!a.artistId) continue;
      const cur = out.get(a.artistId) ?? { id: a.artistId, name: a.artist ?? '', cover: a.coverArt, plays: 0 };
      cur.plays += a.playCount ?? 1;
      out.set(a.artistId, cur);
    }
    return [...out.values()].sort((a, b) => b.plays - a.plays);
  });
}

/** Up to four daily mixes, each around a few of someone's most played artists. */
export async function dailyMixes(auth: SubsonicAuth): Promise<Mix[]> {
  const top = await topArtists(auth);
  if (top.length < 2) return [];
  const groups = Array.from({ length: Math.min(4, Math.ceil(top.length / 3)) }, (_, i) => top.filter((_, j) => j % Math.min(4, Math.ceil(top.length / 3)) === i));
  return groups.map((g, i) => ({
    id: `daily:${i + 1}`,
    title: t('Daily Mix {n}', { n: i + 1 }),
    subtitle: g.length > 2 ? t('{a}, {b} and more', { a: g[0].name, b: g[1].name }) : g.map((x) => x.name).join(', '),
    covers: g.slice(0, 4).map((x) => x.cover).filter((c): c is string => Boolean(c)),
  }));
}

export async function mixTracks(auth: SubsonicAuth, id: string, listenbrainzUser?: string): Promise<Track[]> {
  const [kind, seed] = [id.split(':')[0], id.slice(id.indexOf(':') + 1)];
  switch (kind) {
    case 'song': {
      const r = await subsonic<{ song: Child }>(auth, 'getSong', { id: seed });
      const first = toTrack(r.song);
      return [first, ...spread(unique((await radio(auth, seed, r.song.artistId, r.song.genre)).filter((x) => x.id !== first.id)))].slice(0, 60);
    }
    case 'album': {
      const r = await subsonic<{ album: AlbumID3 }>(auth, 'getAlbum', { id: seed });
      return spread(unique(await radio(auth, seed, r.album.artistId, r.album.genre))).slice(0, 60);
    }
    case 'artist': {
      const [own, others] = await Promise.all([artistSongs(auth, seed, 20), similar(auth, seed, 40)]);
      return spread(unique(shuffle([...own, ...others]))).slice(0, 60);
    }
    case 'daily': {
      const top = await topArtists(auth);
      const n = Math.min(4, Math.ceil(top.length / 3));
      const group = top.filter((_, j) => j % n === Number(seed) - 1).slice(0, 5);
      const lists = await Promise.all(group.flatMap((a) => [artistSongs(auth, a.id, 10), similar(auth, a.id, 10)]));
      return spread(unique(shuffle(lists.flat()))).slice(0, 50);
    }
    case 'liked':
      return shuffle((await liked(auth)).tracks);
    case 'discover':
      return discoverTracks(auth, listenbrainzUser);
    case 'fresh':
      return freshCatch(auth, listenbrainzUser);
    case 'blend':
      return spread(blendTracks(auth.username, seed));
    default:
      throw new HttpError(404, t('Not found'));
  }
}

/** A Blend with each person in the household who's been listening: "Sam + Alex". */
export function blends(username: string, name: string): Mix[] {
  if (!blendable(username)) return [];
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  return listeners()
    .filter((u) => u !== username && blendable(u))
    .map((u) => ({ id: `blend:${u}`, title: t('{a} + {b}', { a: first(name), b: first(nameOf(u)) }), subtitle: t('What you both play'), covers: blendCovers(username, u) }));
}

/** The songs ListenBrainz suggests that are already in the library. */
export async function discoverTracks(auth: SubsonicAuth, listenbrainzUser?: string): Promise<Track[]> {
  if (!listenbrainzUser) return [];
  const recs = await settle(lbRecommendations(listenbrainzUser), []);
  const idx = await libraryIndex(auth);
  const found: Track[] = [];
  for (const rec of recs.slice(0, 40)) {
    if (!idx.artistByName.has(norm(rec.artist))) continue;
    const r = await settle(subsonic<{ searchResult3?: { song?: Child[] } }>(auth, 'search3', { query: rec.title, songCount: 5, albumCount: 0, artistCount: 0 }), {});
    const hit = (r.searchResult3?.song ?? []).find((s) => norm(s.title) === norm(rec.title) && norm(s.artist ?? '') === norm(rec.artist));
    if (hit) found.push(toTrack(hit));
  }
  return spread(unique(found));
}

// ---- Fresh catch -------------------------------------------------------------------------------------

/** The week (from Monday) a moment is in, as a number. */
const weekOf = (at = Date.now()) => Math.floor((at / 86_400_000 + 3) / 7);

/** The same "random" order for the same seed. */
function seeded(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const freshCache = new TTLCache<Track[]>(200);

/**
 * Fresh catch: thirty songs someone hasn't played yet, new every Monday. ListenBrainz's picks that
 * are here, songs by artists like the ones they play most, and what came into the library lately.
 */
export function freshCatch(auth: SubsonicAuth, listenbrainzUser?: string): Promise<Track[]> {
  const week = weekOf();
  return freshCache.wrap(`${auth.username}:${week}`, 6 * HOUR, async () => {
    const played = playedIds(auth.username);
    const top = (await topArtists(auth)).slice(0, 6);
    const newest = await settle(subsonic<{ albumList2?: { album?: AlbumID3[] } }>(auth, 'getAlbumList2', { type: 'newest', size: 6 }), {});
    const [recs, ...lists] = await Promise.all([
      settle(discoverTracks(auth, listenbrainzUser), []),
      ...top.map((a) => similar(auth, a.id, 20)),
      ...(newest.albumList2?.album ?? []).map((a) =>
        settle(subsonic<{ album: AlbumID3 }>(auth, 'getAlbum', { id: a.id }), { album: a }).then((r) => (r.album.song ?? []).map(toTrack)),
      ),
    ]);
    const mostPlayed = new Set(top.map((a) => a.id));
    const pool = unique([...recs, ...lists.flat()]).filter((x) => !played.has(x.id) && !x.plays && !(x.artistId && mostPlayed.has(x.artistId)));
    // The same order all week; never more than two songs by one artist.
    const r = seeded(`${auth.username}:${week}`);
    const order = pool.map((x) => ({ x, k: r() })).sort((a, b) => a.k - b.k);
    const per = new Map<string, number>();
    const out: Track[] = [];
    for (const { x } of order) {
      if ((per.get(x.artist) ?? 0) >= 2) continue;
      per.set(x.artist, (per.get(x.artist) ?? 0) + 1);
      out.push(x);
      if (out.length >= 30) break;
    }
    return spread(out);
  });
}

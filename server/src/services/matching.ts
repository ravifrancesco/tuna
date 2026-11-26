import { subsonic, type Child, type SubsonicAuth } from '../clients/navidrome';
import { MINUTE, TTLCache } from '../lib/cache';
import { norm } from './library';

/** Finding a song from somewhere else (Spotify, ListenBrainz, Last.fm) in the library, by its names. */

export interface Song {
  artist: string;
  title: string;
  album?: string;
}

/** "Currents (Deluxe Edition)", "Abbey Road (Remastered 2019)", "Song - Single" are "Currents", "Abbey Road", "Song". */
export const cleanAlbum = (s: string) =>
  s
    .replace(/\s*[([][^)\]]*\b(deluxe|remaster(ed)?|edition|expanded|anniversary|bonus|version|mono|stereo|explicit|reissue)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(single|ep)$/i, '')
    .replace(/\s+-\s+.*\b(remaster(ed)?|edition|version)\b.*$/i, '')
    .trim() || s;

/** "Song - Remastered 2011" is "Song"; "A, B & C" is any of them. */
const titles = (s: string) => [...new Set([norm(s), norm(s.replace(/\s+-\s+.*$/, ''))])].filter(Boolean);
export const artistsOf = (s: string) =>
  [...new Set([norm(s), ...s.split(/\s*(?:,|;|\/|&|\bfeat\.?|\bft\.?|\bfeaturing)\s*/i).map(norm)])].filter(Boolean);

export interface SongIndex {
  byArtist: Map<string, Child>;
  byAlbum: Map<string, Child>;
}
const songsCache = new TTLCache<SongIndex>(1);

/** Every song in the library (Navidrome lists them all for an empty search). */
export function songIndex(auth: SubsonicAuth): Promise<SongIndex> {
  return songsCache.wrap('songs', 10 * MINUTE, async () => {
    const idx: SongIndex = { byArtist: new Map(), byAlbum: new Map() };
    for (let offset = 0; offset < 1_000_000; offset += 500) {
      const r = await subsonic<{ searchResult3?: { song?: Child[] } }>(auth, 'search3', { query: '""', songCount: 500, songOffset: offset, albumCount: 0, artistCount: 0 });
      const songs = r.searchResult3?.song ?? [];
      for (const c of songs) {
        for (const title of titles(c.title)) {
          for (const a of artistsOf(c.artist ?? '')) if (!idx.byArtist.has(`${a}|${title}`)) idx.byArtist.set(`${a}|${title}`, c);
          if (c.album && !idx.byAlbum.has(`${norm(c.album)}|${title}`)) idx.byAlbum.set(`${norm(c.album)}|${title}`, c);
        }
      }
      if (songs.length < 500) break;
    }
    return idx;
  });
}

export const forgetSongIndex = () => songsCache.clear();

export function matcher(idx: SongIndex) {
  const memo = new Map<string, Child | undefined>();
  return (s: Song) => {
    const key = `${s.artist}|${s.title}|${s.album ?? ''}`;
    if (memo.has(key)) return memo.get(key);
    let hit: Child | undefined;
    for (const title of titles(s.title)) {
      for (const a of artistsOf(s.artist)) hit ??= idx.byArtist.get(`${a}|${title}`);
      if (s.album) hit ??= idx.byAlbum.get(`${norm(s.album)}|${title}`);
    }
    memo.set(key, hit);
    return hit;
  };
}


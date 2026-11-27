import { subsonic, type Child, type SubsonicAuth } from '../clients/navidrome';
import type { MbRecording } from '../clients/public';
import { MINUTE, TTLCache } from '../lib/cache';
import { norm } from './library';

/** Finding a song from somewhere else (Spotify, ListenBrainz, Last.fm) in the library, by its names. */

export interface Song {
  artist: string;
  title: string;
  album?: string;
  /** When it went into the playlist on Spotify (ISO), where Spotify's files say. */
  added?: string;
  /** Its code (Exportify's files have it): MusicBrainz finds it by that, whatever the names. */
  isrc?: string;
}

/** A soundtrack's subtitle: "(Original Motion Picture Soundtrack)", ": Music from the Netflix Series". */
const SOUNDTRACK = /\s*(?:[([]|[:\-–]\s)[^)\]]*\b(?:soundtrack|motion picture|original score|music from|ost)\b[^)\]]*[)\]]?$/i;
export const isSoundtrack = (s: string) => SOUNDTRACK.test(s);

/** "Currents (Deluxe Edition)", "Abbey Road (Remastered 2019)", "Song - Single", "Whiplash (Original Motion Picture Soundtrack)" are "Currents", "Abbey Road", "Song", "Whiplash". */
export const cleanAlbum = (s: string) =>
  s
    .replace(/\s*[([][^)\]]*\b(deluxe|remaster(ed)?|edition|expanded|anniversary|bonus|version|mono|stereo|explicit|reissue)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(single|ep)$/i, '')
    .replace(/\s+-\s+.*\b(remaster(ed)?|edition|version)\b.*$/i, '')
    .replace(SOUNDTRACK, '')
    .trim() || s;

/** Letters to change to make one into the other. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * The same name but for spacing, punctuation, accents or a letter here and there: Spotify's "D'esordio
 * De I Cani" is MusicBrainz's "d'esordio dei cani". Numbers must agree ("Vol. 1" is never "Vol. 2").
 */
export function alike(a: string, b: string): boolean {
  const x = norm(a).replace(/ /g, '');
  const y = norm(b).replace(/ /g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.replace(/\D/g, '') !== y.replace(/\D/g, '')) return false;
  const longest = Math.max(x.length, y.length);
  return longest >= 12 && distance(x, y) <= Math.floor(longest / 12);
}

/** An album, single or EP as MusicBrainz knows it, with its album artist. */
export interface MbAlbum {
  mbid: string;
  artistMbid?: string;
  title: string;
  artist: string;
  /** Album first, then single, EP, the rest; soundtracks after those. */
  rank: number;
  /** The recordings of the song on it. */
  recordings: string[];
}

/**
 * What these recordings came out on: albums, singles and EPs (and soundtracks, after those), never
 * compilations, live albums or mixes; each with its album artist (a soundtrack's is its composer,
 * not the song's), in MusicBrainz's order within a rank.
 */
export function releaseGroups(recs: MbRecording[]): MbAlbum[] {
  const type = (t?: string) => (t === 'Album' ? 0 : t === 'Single' ? 1 : t === 'EP' ? 2 : 3);
  const out = new Map<string, MbAlbum>();
  for (const r of recs) {
    for (const rel of r.releases ?? []) {
      const g = rel['release-group'];
      const extra = g?.['secondary-types'] ?? [];
      if (!g || extra.some((x) => x !== 'Soundtrack')) continue;
      const by = rel['artist-credit']?.[0] ?? r['artist-credit']?.[0];
      if (!by) continue;
      const known = out.get(g.id);
      if (known) {
        if (!known.recordings.includes(r.id)) known.recordings.push(r.id);
        continue;
      }
      out.set(g.id, { mbid: g.id, artistMbid: by.artist.id, title: g.title, artist: by.name, rank: type(g['primary-type']) + (extra.length ? 10 : 0), recordings: [r.id] });
    }
  }
  return [...out.values()].sort((a, b) => a.rank - b.rank);
}

/** "Song - Remastered 2011" is "Song"; "A, B & C" is any of them. */
const titles = (s: string) => [...new Set([norm(s), norm(s.replace(/\s+-\s+.*$/, ''))])].filter(Boolean);
/**
 * The main artist of a song's list: Spotify's files write "Gorillaz;Black Thought", Exportify's
 * "Kanye West, Chance the Rapper, Kelly Price". Searches use just this one (Soulseek finds only files
 * with every word asked for).
 */
export const firstArtist = (s: string) => s.split(/\s*;\s*|,\s+/)[0]?.trim() || s;

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


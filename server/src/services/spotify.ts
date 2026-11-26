import type { SpotifyImport } from '@tuna/shared';
import { subsonic, type SubsonicAuth } from '../clients/navidrome';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { HttpError } from '../lib/upstream';
import { unzip } from '../lib/zip';
import { findAlbum, findArtist, libraryIndex, norm, playlists, toTrack } from './library';
import { keepImported, LIKED } from './imported';
import { addListens } from './listens';
import { cleanAlbum, matcher, songIndex, type Song } from './matching';

/**
 * Bringing someone's music over from Spotify: the ZIP from Spotify's "Download your data"
 * (playlists, liked songs, saved albums, followed artists and listening history), or playlists
 * exported as CSV files (Exportify). What's in the library comes in; the rest is listed.
 */

interface Play extends Song {
  /** When it ended, and for how long it played. */
  end: number;
  ms: number;
}
interface Found {
  playlists: { name: string; songs: Song[] }[];
  liked: Song[];
  albums: { artist: string; album: string }[];
  artists: string[];
  plays: Play[];
}

// ---- Reading Spotify's files ---------------------------------------------------------------------

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as Json[]) : []);

function read(name: string, data: Buffer, into: Found) {
  const base = name.split('/').pop() ?? name;
  if (data.length > 4 && data.readUInt32LE(0) === 0x04034b50) {
    for (const [inner, d] of unzip(data, (n) => /\.(json|csv)$/i.test(n))) read(inner, d, into);
    return;
  }
  if (/\.csv$/i.test(base)) return readCsv(base, data.toString('utf8'), into);
  let json: unknown;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    return;
  }
  if (/^YourLibrary\.json$/i.test(base)) {
    const lib = json as Json;
    for (const x of list(lib.tracks)) {
      const artist = str(x.artist);
      const title = str(x.track);
      if (artist && title) into.liked.push({ artist, title, album: str(x.album) });
    }
    for (const x of list(lib.albums)) {
      const artist = str(x.artist);
      const album = str(x.album);
      if (artist && album) into.albums.push({ artist, album });
    }
    for (const x of list(lib.artists)) {
      const n = str(x.name);
      if (n) into.artists.push(n);
    }
  } else if (/^Playlist\d*\.json$/i.test(base)) {
    for (const pl of list((json as Json).playlists)) {
      const songs = list(pl.items).flatMap((i) => {
        const tr = (i.track ?? {}) as Json;
        const artist = str(tr.artistName);
        const title = str(tr.trackName);
        return artist && title ? [{ artist, title, album: str(tr.albumName), added: str(i.addedDate) }] : [];
      });
      const plName = str(pl.name);
      if (plName && songs.length) into.playlists.push({ name: plName, songs });
    }
  } else if (/^StreamingHistory(_music)?_?\d*\.json$/i.test(base)) {
    // "endTime": "2024-03-01 18:22", in UTC.
    for (const x of list(json)) {
      const artist = str(x.artistName);
      const title = str(x.trackName);
      const end = Date.parse(`${String(x.endTime).replace(' ', 'T')}Z`);
      if (artist && title && end) into.plays.push({ artist, title, end, ms: Number(x.msPlayed) || 0 });
    }
  } else if (/^(Streaming_History_Audio_.*|endsong_\d+)\.json$/i.test(base)) {
    // The extended history: every play ever, "ts" being when it ended.
    for (const x of list(json)) {
      const artist = str(x.master_metadata_album_artist_name);
      const title = str(x.master_metadata_track_name);
      const end = Date.parse(String(x.ts));
      if (artist && title && end) into.plays.push({ artist, title, album: str(x.master_metadata_album_album_name), end, ms: Number(x.ms_played) || 0 });
    }
  }
}

/** Exportify's CSV: one playlist per file, named after it ("liked_songs.csv" is Liked songs). */
function readCsv(file: string, text: string, into: Found) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const titleAt = head.indexOf('track name');
  const artistAt = head.findIndex((h) => h.startsWith('artist name'));
  const albumAt = head.indexOf('album name');
  const addedAt = head.indexOf('added at');
  if (titleAt < 0 || artistAt < 0) return;
  const songs = rows.flatMap((r) =>
    r[titleAt]?.trim() && r[artistAt]?.trim() ? [{ title: r[titleAt].trim(), artist: r[artistAt].trim(), album: r[albumAt]?.trim() || undefined, added: Date.parse(r[addedAt] ?? '') || 0 }] : [],
  );
  const name = file.replace(/\.csv$/i, '').replace(/_/g, ' ').trim();
  const dated = ({ added, ...s }: (typeof songs)[number]) => ({ ...s, added: added ? new Date(added).toISOString() : undefined });
  // Liked songs newest first, as Spotify shows them; a playlist in its own order.
  if (/^liked songs$/i.test(name)) into.liked.push(...[...songs].sort((a, b) => b.added - a.added).map(dated));
  else if (songs.length) into.playlists.push({ name: name.charAt(0).toUpperCase() + name.slice(1), songs: songs.map(dated) });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      (row = []), (cell = '');
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

// ---- Bringing it in --------------------------------------------------------------------------------

/** Subsonic takes the songs in the address: a few hundred at a time. */
const CHUNK = 300;
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

export async function importSpotify(auth: SubsonicAuth, username: string, name: string, data: Buffer): Promise<SpotifyImport> {
  const into: Found = { playlists: [], liked: [], albums: [], artists: [], plays: [] };
  try {
    read(name, data, into);
  } catch {
    /* not a file we know */
  }
  if (!into.playlists.length && !into.liked.length && !into.albums.length && !into.artists.length && !into.plays.length) {
    throw new HttpError(400, t("There's nothing from Spotify in that file"));
  }

  const find = matcher(await songIndex(auth));
  const missing = new Map<string, { artist: string; album: string; songs: Set<string>; plays: number }>();
  const seen = new Map<string, boolean>();
  const look = (s: Song) => {
    const c = find(s);
    const key = `${norm(s.artist)}|${norm(s.title)}`;
    seen.set(key, Boolean(c) || Boolean(seen.get(key)));
    if (!c && s.album) {
      // "Currents" and "Currents (Deluxe)" are one album to get.
      const k = `${norm(s.artist)}|${norm(cleanAlbum(s.album))}`;
      const m = missing.get(k) ?? { artist: s.artist, album: cleanAlbum(s.album), songs: new Set<string>(), plays: 0 };
      m.songs.add(norm(s.title));
      m.plays++;
      missing.set(k, m);
    }
    return c;
  };

  // Playlists: one of yours with the same name gets these songs instead. Made even when nothing
  // is here yet: the rest shows where it belongs and goes in as it arrives.
  const mine = (await playlists(auth)).filter((p) => p.mine);
  let made = 0;
  for (const pl of into.playlists) {
    const found = pl.songs.map(look);
    const ids = [...new Set(found.flatMap((c) => (c ? [c.id] : [])))];
    const [first = [], ...rest] = chunks(ids);
    const existing = mine.find((p) => p.name === pl.name);
    const r = await subsonic<{ playlist?: { id: string } }>(auth, 'createPlaylist', existing ? { playlistId: existing.id, songId: first } : { name: pl.name, songId: first });
    const id = existing?.id ?? r.playlist?.id ?? (await playlists(auth)).find((p) => p.mine && p.name === pl.name)?.id;
    for (const more of rest) if (id) await subsonic(auth, 'updatePlaylist', { playlistId: id, songIdToAdd: more });
    if (id) keepImported(username, id, pl.name, pl.songs, found.map((c) => c?.id));
    made++;
  }

  // Liked songs: the ones here are liked now; all of them are kept, in Spotify's order, so the rest
  // show where they belong and are liked as they arrive.
  const likedFound = into.liked.map(look);
  const liked = [...new Set(likedFound.flatMap((c) => (c ? [c.id] : [])))];
  for (const ids of chunks(liked)) await subsonic(auth, 'star', { id: ids });
  if (into.liked.length) keepImported(username, LIKED, 'Liked songs', into.liked, likedFound.map((c) => c?.id));

  const lib = await libraryIndex(auth);
  const albums = [...new Set(into.albums.flatMap((a) => findAlbum(lib, undefined, a.artist, a.album) ?? []))];
  for (const ids of chunks(albums)) await subsonic(auth, 'star', { albumId: ids });
  const artists = [...new Set(into.artists.flatMap((n) => findArtist(lib, undefined, n) ?? []))];
  for (const ids of chunks(artists)) await subsonic(auth, 'star', { artistId: ids });

  // Plays: what Spotify counts as one (30 seconds or more) of songs that are here.
  const plays = into.plays.flatMap((p) => {
    if (p.ms < 30_000) return [];
    const c = look(p);
    return c ? [{ end: p.end, sec: Math.round(Math.min(p.ms / 1000, c.duration || Infinity)), track: toTrack(c) }] : [];
  });
  const added = addListens(username, plays);

  const result: SpotifyImport = {
    playlists: made,
    liked: liked.length,
    albums: albums.length,
    artists: artists.length,
    plays: added,
    missing: [...seen.values()].filter((found) => !found).length,
    missingAlbums: [...missing.values()]
      .sort((a, b) => b.plays - a.plays || b.songs.size - a.songs.size)
      .slice(0, 2000)
      .map((m) => ({ artist: m.artist, album: m.album, songs: m.songs.size, plays: m.plays })),
  };
  log.info(
    'spotify',
    `${username} brought in ${made} playlists, ${liked.length} liked songs, ${albums.length} albums, ${artists.length} artists and ${added} plays from Spotify (${result.missing} songs aren't in the library)`,
  );
  return result;
}

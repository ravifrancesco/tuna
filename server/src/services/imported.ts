import fs from 'node:fs';
import path from 'node:path';
import type { Track, WaitingSong } from '@tuna/shared';
import { subsonic, type SubsonicAuth } from '../clients/navidrome';
import { config } from '../config';
import { log } from '../lib/log';
import { UpstreamError } from '../lib/upstream';
import { authFor } from '../sessions';
import { liked, playlist } from './library';
import { matcher, songIndex, type Song } from './matching';

/**
 * Playlists brought over from Spotify, kept whole: songs that aren't in the library yet show
 * where they belong, and go into the playlist once they arrive. What someone changes stays:
 * songs they add keep their place, and songs they take out don't come back.
 */

interface Wanted extends Song {
  /** The library's song, once it's here. */
  id?: string;
}
interface Imported {
  playlistId: string;
  name: string;
  songs: Wanted[];
  /** Songs Tuna put in, to notice the ones someone took out. */
  added: string[];
  removed: string[];
}

const DIR = () => path.join(config.dataDir, 'imported');
const fileOf = (username: string) => path.join(DIR(), `${encodeURIComponent(username)}.json`);

function load(username: string): Imported[] {
  try {
    return JSON.parse(fs.readFileSync(fileOf(username), 'utf8')) as Imported[];
  } catch {
    return [];
  }
}
function save(username: string, list: Imported[]) {
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = `${fileOf(username)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(tmp, fileOf(username));
}

/** Liked songs from Spotify are kept the same way, under this id. */
export const LIKED = 'liked';

/** An imported playlist, as Spotify had it; `here` are the songs that went in. */
export function keepImported(username: string, playlistId: string, name: string, songs: Song[], here: (string | undefined)[]) {
  const list = load(username).filter((x) => x.playlistId !== playlistId);
  const added = [...new Set(here.filter((id): id is string => Boolean(id)))];
  list.push({ playlistId, name, songs: songs.map((s, i) => ({ ...s, id: here[i] })), added, removed: [] });
  save(username, list);
}

/** The songs of an imported playlist that are in it, with Spotify's date added where it's known. */
export function importedSongs(username: string, playlistId: string): Map<string, string | undefined> {
  const kept = load(username).find((x) => x.playlistId === playlistId);
  return new Map((kept?.songs ?? []).flatMap((s) => (s.id ? [[s.id, s.added] as const] : [])));
}

/**
 * Liked songs in Spotify's order: likes made here since come first (newest first, as they are), then
 * the imported ones as Spotify listed them.
 */
export function orderLiked(username: string, tracks: Track[]): Track[] {
  const kept = load(username).find((x) => x.playlistId === LIKED);
  if (!kept) return tracks;
  const at = new Map<string, number>();
  kept.songs.forEach((s, i) => s.id && !at.has(s.id) && at.set(s.id, i));
  const ours = tracks.filter((tr) => !at.has(tr.id));
  const theirs = tracks.filter((tr) => at.has(tr.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...ours, ...theirs];
}

/** The songs of an imported playlist that aren't in it yet, each after the song it follows. */
export function waitingIn(username: string, playlistId: string, tracks: Track[]): WaitingSong[] {
  const kept = load(username).find((x) => x.playlistId === playlistId);
  if (!kept) return [];
  const at = new Map<string, number>();
  tracks.forEach((tr, i) => at.has(tr.id) || at.set(tr.id, i));
  const removed = new Set(kept.removed);
  const out: WaitingSong[] = [];
  // Songs before the first one here go just above it (in Liked songs, below the likes made in Tuna).
  const first = kept.songs.find((s) => s.id && at.has(s.id));
  let after = first ? at.get(first.id!)! - 1 : playlistId === LIKED ? tracks.length - 1 : -1;
  for (const s of kept.songs) {
    if (s.id && at.has(s.id)) after = at.get(s.id)!;
    else if (!(s.id && removed.has(s.id))) out.push({ title: s.title, artist: s.artist, album: s.album, added: s.added, after });
  }
  return out;
}

const CHUNK = 300;
async function write(auth: SubsonicAuth, playlistId: string, ids: string[]) {
  // Subsonic has no "insert": the playlist is written again, a few hundred songs per request.
  await subsonic(auth, 'createPlaylist', { playlistId, songId: ids.slice(0, CHUNK) });
  for (let i = CHUNK; i < ids.length; i += CHUNK) await subsonic(auth, 'updatePlaylist', { playlistId, songIdToAdd: ids.slice(i, i + CHUNK) });
}

/** Puts songs that have arrived into someone's imported playlists, each near its Spotify neighbours. */
async function fill(auth: SubsonicAuth, username: string) {
  const list = load(username);
  if (!list.some((x) => x.songs.some((s) => !s.id || !(x.added.includes(s.id) || x.removed.includes(s.id))))) return;
  const find = matcher(await songIndex(auth));
  const keep: Imported[] = [];
  for (const kept of list) {
    let current: string[];
    try {
      current = (kept.playlistId === LIKED ? await liked(auth) : await playlist(auth, kept.playlistId)).tracks.map((tr) => tr.id);
    } catch (err) {
      // Deleted since: nothing more to fill.
      if (err instanceof UpstreamError && err.status === 404) continue;
      throw err;
    }
    keep.push(kept);
    const now = new Set(current);
    kept.removed = [...new Set([...kept.removed, ...kept.added.filter((id) => !now.has(id))])];
    kept.added = kept.added.filter((id) => now.has(id));
    for (const s of kept.songs) s.id ??= find(s)?.id;

    const removed = new Set(kept.removed);
    const order = [...current];
    const arrived: string[] = [];
    kept.songs.forEach((s, k) => {
      if (!s.id || now.has(s.id) || removed.has(s.id) || arrived.includes(s.id)) return;
      // After the nearest earlier Spotify song that's in the playlist, or first.
      let pos = 0;
      for (let j = k - 1; j >= 0; j--) {
        const before = kept.songs[j].id;
        const i = before ? order.indexOf(before) : -1;
        if (i >= 0) {
          pos = i + 1;
          break;
        }
      }
      order.splice(pos, 0, s.id);
      arrived.push(s.id);
    });
    if (!arrived.length) continue;
    // Liked songs are liked (their order is Spotify's, kept above); a playlist is written again.
    if (kept.playlistId === LIKED) for (let i = 0; i < arrived.length; i += CHUNK) await subsonic(auth, 'star', { id: arrived.slice(i, i + CHUNK) });
    else await write(auth, kept.playlistId, order);
    kept.added.push(...arrived);
    log.info('spotify', `${arrived.length} song${arrived.length === 1 ? '' : 's'} from Spotify went into "${kept.name}" for ${username}`);
  }
  save(username, keep);
}

let filling: Promise<void> | undefined;
/** Everyone's imported playlists, after new music arrived (and every half hour, for music added elsewhere). */
export function fillImported(): Promise<void> {
  filling ??= (async () => {
    try {
      const people = fs.existsSync(DIR()) ? fs.readdirSync(DIR()).filter((f) => f.endsWith('.json')).map((f) => decodeURIComponent(f.slice(0, -5))) : [];
      for (const username of people) {
        const auth = authFor(username);
        if (auth) await fill(auth, username).catch((err) => log.warn('spotify', `Couldn't fill ${username}'s playlists from Spotify`, err));
      }
    } finally {
      filling = undefined;
    }
  })();
  return filling;
}

setTimeout(() => void fillImported(), 60_000);
setInterval(() => void fillImported(), 30 * 60_000);

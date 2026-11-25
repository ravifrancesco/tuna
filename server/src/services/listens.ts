import fs from 'node:fs';
import path from 'node:path';
import type { Listen, ListeningStats, StatsPeriod, Track } from '@tuna/shared';
import { config } from '../config';
import { log } from '../lib/log';

/** Each person's plays as Tuna counted them, one line each, for their listening stats and history. */

interface Line {
  at: number;
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album: string;
  albumId?: string;
  cover?: string;
  /** How long it played, in seconds (the song's length for Tuna's own plays). */
  sec: number;
}

const DIR = () => path.join(config.dataDir, 'listens');
const fileOf = (username: string) => path.join(DIR(), `${encodeURIComponent(username)}.jsonl`);

export function keepListen(username: string, tr: Track) {
  const line: Line = { at: Date.now(), id: tr.id, title: tr.title, artist: tr.artist, artistId: tr.artistId, album: tr.album, albumId: tr.albumId, cover: tr.cover, sec: Math.round(tr.duration || 0) };
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(fileOf(username), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn('playing', `Couldn't keep ${username}'s play`, err);
  }
}

/**
 * Plays from elsewhere (Spotify), each only once: a play is known by its song and the minute it
 * ended, so bringing in the same file twice, or two files that overlap, adds nothing new.
 */
export function addListens(username: string, plays: { end: number; sec: number; track: Track }[]): number {
  const lines = linesOf(username);
  const key = (id: string, end: number) => `${id}|${Math.floor(end / 60_000)}`;
  const have = new Set(lines.map((l) => key(l.id, l.at + l.sec * 1000)));
  const added: Line[] = [];
  for (const { end, sec, track: tr } of plays) {
    if (have.has(key(tr.id, end))) continue;
    have.add(key(tr.id, end));
    added.push({ at: end - sec * 1000, id: tr.id, title: tr.title, artist: tr.artist, artistId: tr.artistId, album: tr.album, albumId: tr.albumId, cover: tr.cover, sec });
  }
  if (!added.length) return 0;
  const all = [...lines, ...added].sort((x, y) => x.at - y.at);
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = `${fileOf(username)}.tmp`;
  fs.writeFileSync(tmp, all.map((l) => `${JSON.stringify(l)}\n`).join(''), { mode: 0o600 });
  fs.renameSync(tmp, fileOf(username));
  read.delete(username);
  return added.length;
}

/** Someone removed from the household: their listening goes too. */
export function forgetListens(username: string) {
  fs.rmSync(fileOf(username), { force: true });
  read.delete(username);
}

// Read again only when the file has grown.
const read = new Map<string, { size: number; lines: Line[] }>();
function linesOf(username: string): Line[] {
  let size: number;
  try {
    size = fs.statSync(fileOf(username)).size;
  } catch {
    return [];
  }
  const hit = read.get(username);
  if (hit?.size === size) return hit.lines;
  const lines = fs
    .readFileSync(fileOf(username), 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l) as Line] : [];
      } catch {
        return [];
      }
    });
  read.set(username, { size, lines });
  return lines;
}

const trackOf = (l: Line): Track => ({ id: l.id, title: l.title, artist: l.artist, artistId: l.artistId, album: l.album, albumId: l.albumId, cover: l.cover, duration: l.sec });

const DAYS: Record<StatsPeriod, number> = { week: 7, month: 30, year: 365, all: Infinity };

export function listeningStats(username: string, period: StatsPeriod): ListeningStats {
  const all = linesOf(username);
  const from = Date.now() - DAYS[period] * 86_400_000;
  const lines = all.filter((l) => l.at >= from);
  type Count = { last: Line; plays: number };
  const songs = new Map<string, Count>();
  const artists = new Map<string, Count>();
  const albums = new Map<string, Count>();
  const add = (m: Map<string, Count>, key: string | undefined, l: Line) => {
    if (!key) return;
    const c = m.get(key);
    if (c) {
      c.plays++;
      c.last = l;
    } else m.set(key, { last: l, plays: 1 });
  };
  for (const l of lines) {
    add(songs, l.id, l);
    add(artists, l.artistId, l);
    add(albums, l.albumId, l);
  }
  // Most played first; a tie goes to the more recent.
  const top = (m: Map<string, Count>, n: number) => [...m.values()].sort((a, b) => b.plays - a.plays || b.last.at - a.last.at).slice(0, n);
  return {
    period,
    seconds: lines.reduce((sum, l) => sum + l.sec, 0),
    plays: lines.length,
    songs: songs.size,
    artists: new Set(lines.map((l) => l.artistId ?? l.artist)).size,
    topArtists: top(artists, 10).map(({ last, plays }) => ({ id: last.artistId!, name: last.artist, cover: `ar-${last.artistId}`, plays })),
    topSongs: top(songs, 10).map(({ last, plays }) => ({ ...trackOf(last), plays })),
    topAlbums: top(albums, 10).map(({ last, plays }) => ({ id: last.albumId!, name: last.album, artist: last.artist, artistId: last.artistId, cover: last.cover, songCount: 0, duration: 0, plays })),
    since: all[0] && new Date(all[0].at).toISOString(),
  };
}

export function listeningHistory(username: string, offset: number, size: number): Listen[] {
  const lines = linesOf(username);
  const end = Math.max(0, lines.length - offset);
  return lines
    .slice(Math.max(0, end - size), end)
    .reverse()
    .map((l) => ({ at: new Date(l.at).toISOString(), track: trackOf(l) }));
}

/** Everyone with plays Tuna counted. */
export function listeners(): string[] {
  try {
    return fs.readdirSync(DIR()).flatMap((f) => (f.endsWith('.jsonl') ? [decodeURIComponent(f.slice(0, -6))] : []));
  } catch {
    return [];
  }
}

/** Someone's plays since a moment: which song, by whom, and when. */
export const listensSince = (username: string, since: number) =>
  linesOf(username)
    .filter((l) => l.at >= since)
    .map((l) => ({ id: l.id, artist: l.artist, artistId: l.artistId, at: l.at }));

/** Every song someone has ever played here. */
export const playedIds = (username: string) => new Set(linesOf(username).map((l) => l.id));

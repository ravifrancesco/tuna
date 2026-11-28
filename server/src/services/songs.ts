import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GetItem, GetState } from '@tuna/shared';
import * as lidarr from '../clients/lidarr';
import { coverArtFor, mbSearchRecordings, type MbRecording } from '../clients/public';
import * as slskd from '../clients/slskd';
import { config } from '../config';
import { has, slskd as slskdConnection, soulseekFiles } from '../connections';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { HttpError } from '../lib/upstream';
import { albumSent, ensureArtist, scanNavidrome } from './getting';
import type { SubsonicAuth } from '../clients/navidrome';
import { norm, toTrack } from './library';
import { alike, artistsOf, cleanAlbum, firstArtist, matcher, releaseGroups, songIndex } from './matching';
import { missedSent, resolve } from './stocking';

/**
 * Single songs, for when a whole album is more than anyone wants (a playlist's missing songs, Get
 * all): slskd finds the song on Soulseek and downloads just that file, and Lidarr files it into its
 * album like anything it gets (the album stays unwatched, so the rest isn't fetched). A few at a
 * time; each is followed until it's in the library.
 */

interface Song {
  id: string;
  artist: string;
  title: string;
  album?: string;
  /** Its code, where Spotify's files had it. */
  isrc?: string;
  /** Its title and album artist as MusicBrainz has them, where they differ from Spotify's (Soulseek is searched for both). */
  mb?: { title: string; artist: string };
  by: string;
  at: string;
  state: 'waiting' | 'looking' | 'downloading' | 'ready' | 'notFound';
  /** Lidarr's side, once found. */
  albumMbid?: string;
  artistId?: number;
  albumId?: number;
  releaseId?: number;
  trackId?: number;
  /** Seconds. */
  length?: number;
  /** The copy being downloaded (and when slskd said it had it all), and those tried before it. */
  from?: { username: string; filename: string; size: number; since: number; done?: number };
  tried?: string[];
  /** How many of those were refused. */
  refused?: number;
  /** Looking it up failed this many times (Lidarr or MusicBrainz not answering); not again before `after`. */
  failures?: number;
  after?: number;
  progress?: number;
  ready?: string;
  /** Why Lidarr has no album for it (then it goes straight into the music folder). */
  loose?: string;
  /** When it wasn't found (ms). */
  settled?: number;
  /** A file someone has for it, waiting to go into the library (in the music folder's .tuna), and its cover; who sent it. */
  upload?: { file: string; cover?: string; seconds?: number; names?: Names };
  imported?: string;
  /** Discoveries (Tuna's, for these people, that week; from a song's radio): kept only if someone keeps them. */
  for?: string[];
  week?: number;
  radio?: string;
}

const FILE = () => path.join(config.dataDir, 'songs.json');
let songs: Song[] = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Song[];
  } catch {
    return [];
  }
})();
const save = () => writeJson(FILE(), songs.slice(-3000));

/** Songs being looked for or downloaded at once. */
const AT_ONCE = 4;
/** Waiting in someone's upload queue this long: another copy. */
const QUEUED_TOO_LONG = 20 * 60_000;
const TRIES = 3;
/** Refused copies don't count as tries, up to this many copies in all. */
const COPIES = 8;
/** Someone who refused isn't asked again, for any song, for this long. */
const REFUSED_FOR = 60 * 60_000;
const refused = new Map<string, number>();
/** Looking a song up failed: again after these waits, then it's given up. */
const AGAIN = [60_000, 5 * 60_000, 30 * 60_000];
/** Downloaded but not in slskd's downloads folder after this long: it isn't coming. */
const LANDING = 5 * 60_000;

const busy = () => songs.filter((s) => s.state === 'looking' || s.state === 'downloading');
export const songsOnTheWay = () => busy().length + songs.filter((s) => s.state === 'waiting').length;

/** "Song (feat. X) - 2011 Remaster" is looked for as "Song". */
export const cleanTitle = (t: string) =>
  t
    .replace(/\s*[([](?:feat|ft|with)\.?\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*\b(?:remaster(?:ed)?|version|edit|mono|stereo|mix)\b.*$/i, '')
    .replace(/\s*[([][^)\]]*\b(?:remaster(?:ed)?|version|edit)\b[^)\]]*[)\]]/gi, '')
    .trim() || t;
const words = (s: string) => norm(s).split(' ').filter((w) => w.length > 1);

// ---- Asking ------------------------------------------------------------------------------------------

const key = (s: { artist: string; title: string }) => `${norm(s.artist)}|${norm(cleanTitle(s.title))}`;

/** Asks for songs; `discovery`: Tuna's own picks for someone (a song's radio, or the week's new songs). */
export function wantSongs(by: string, list: Array<{ artist: string; title: string; album?: string; isrc?: string }>, discovery?: { for: string; week: number; radio?: string }): number {
  const known = new Map(songs.filter((s) => s.state !== 'notFound').map((s) => [key(s), s]));
  for (const s of list) {
    const k = known.get(key(s));
    if (k && s.isrc) k.isrc ??= s.isrc;
    // Wanted by a person now: kept for good. Another person's discovery too: theirs as well.
    if (k && !discovery) Object.assign(k, { for: undefined, week: undefined, by: k.by === 'Tuna' ? by : k.by });
    else if (k?.for && discovery && !k.for.includes(discovery.for)) k.for.push(discovery.for);
  }
  const fresh = list.filter((s) => s.artist && s.title && !known.has(key(s)) && (known.set(key(s), {} as Song), true));
  // Asked again after it wasn't found: looked for once more.
  songs = songs.filter((s) => !(s.state === 'notFound' && list.some((l) => key(l) === key(s))));
  const at = new Date().toISOString();
  songs.push(
    ...fresh.map((s) => ({
      id: crypto.randomUUID(),
      artist: s.artist,
      title: s.title,
      album: s.album,
      isrc: s.isrc || undefined,
      by,
      at,
      state: 'waiting' as const,
      ...(discovery ? { for: [discovery.for], week: discovery.week, radio: discovery.radio } : {}),
    })),
  );
  save();
  if (fresh.length) log.info('get', `${by} asked for ${fresh.length} song${fresh.length === 1 ? '' : 's'}, to get ${AT_ONCE} at a time`);
  void tick();
  return fresh.length;
}

/** Stops asking for songs not started yet: someone's own, or everyone's. */
export function stopSongs(by: string | undefined): number {
  const before = songs.length;
  songs = songs.filter((s) => !(s.state === 'waiting' && (!by || s.by === by)));
  save();
  return before - songs.length;
}
export const songsWaiting = (by?: string) => songs.filter((s) => s.state === 'waiting' && (!by || s.by === by)).length;

/** Songs people asked for that couldn't be found (not Tuna's own picks). */
export const songsNotFound = () => songs.filter((s) => s.state === 'notFound' && !s.for?.length);

/** Looks for all of those again, from the start. */
export function lookAgain(by: string): number {
  const again = songsNotFound();
  for (const s of again) Object.assign(s, { state: 'waiting', tried: undefined, refused: undefined, failures: undefined, after: undefined, from: undefined, progress: undefined, loose: undefined });
  save();
  if (again.length) log.info('get', `${by} asked to look again for ${again.length} song${again.length === 1 ? '' : 's'}, to get ${AT_ONCE} at a time`);
  void tick();
  return again.length;
}

/** Where a song asked for on its own is at, if it was. */
export function songState(s: { artist: string; title: string }): GetState | undefined {
  const found = songs.find((x) => key(x) === key(s));
  return found && stateOf(found);
}

/** Where each song asked for on its own is at (for many songs at once). */
export function songStates(): (s: { artist: string; title: string }) => GetState | undefined {
  const by = new Map(songs.map((x) => [key(x), x]));
  return (s) => {
    const x = by.get(key(s));
    return x && stateOf(x);
  };
}

/** Songs that arrived, with themselves as they are in the library (for downloading onto a device). */
export async function withTracks<T extends { title: string; artist: string; album?: string; get?: GetState }>(auth: SubsonicAuth, items: T[]): Promise<T[]> {
  if (!items.some((x) => x.get?.state === 'ready')) return items;
  const here = matcher(await songIndex(auth));
  return items.map((x) => {
    if (x.get?.state !== 'ready') return x;
    const c = here(x);
    return c ? { ...x, get: { ...x.get, track: toTrack(c) } } : x;
  });
}

/** Whether a song has been asked for (by anyone) or looked for already. */
export const known = (s: { artist: string; title: string }) => songs.some((x) => key(x) === key(s));

/** Tuna's discoveries that are in the library. */
export const discoveries = () => songs.filter((s) => s.for?.length && s.state === 'ready');

/** A discovery nobody kept: its file goes (through Lidarr), and it's forgotten. */
export async function letGo(id: string) {
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  const track = s.albumId ? (await lidarr.tracks(s.albumId)).find((t) => t.id === s.trackId) : undefined;
  if (track?.trackFileId) await lidarr.deleteTrackFile(track.trackFileId);
  songs = songs.filter((x) => x.id !== id);
  save();
}

// ---- Finding its place in Lidarr ---------------------------------------------------------------------

type Album = { mbid: string; artistMbid?: string; title: string; artist: string; recordings?: string[] };

/**
 * Its album (as Lidarr knows it) and its track there; Lidarr adds the artist, watching nothing. By its
 * code when Spotify's files had one (exactly the albums it's on, whatever the names); else the album
 * the playlist names, else one the song came out on: a greatest hits isn't one Lidarr keeps. Why not,
 * when it can't be placed.
 */
async function place(s: Song): Promise<string | undefined> {
  const coded = s.isrc ? releaseGroups(await mbSearchRecordings(`isrc:${s.isrc}`).catch(() => [])) : [];
  if (coded.length) {
    const named = s.album ? coded.filter((a) => alike(cleanAlbum(a.title), cleanAlbum(s.album!))) : [];
    if (await placeOn(s, [...named, ...coded.filter((a) => !named.includes(a))])) return;
  }
  // Lidarr's search fails for some names (its metadata server): then the song's own way, below.
  const named = s.album ? await resolve(s.artist, s.album).catch(() => undefined) : undefined;
  if (named && (await placeOn(s, [named]))) return;
  const own = (await releasesOf(s)).filter((a) => a.mbid !== named?.mbid);
  if (!coded.length && !named && !own.length) return 'not in MusicBrainz';
  if (!(await placeOn(s, own))) return 'not on an album Lidarr has';
}

/** The albums, singles and EPs the song came out on (soundtracks after; no compilations, live albums or mixes), albums first. */
async function releasesOf(s: Song): Promise<Album[]> {
  const first = firstArtist(s.artist);
  const query = `recording:"${cleanTitle(s.title).replace(/"/g, '')}" AND artist:"${first.replace(/"/g, '')}"`;
  const want = cleanTitle(s.title);
  const recs: MbRecording[] = [];
  // A famous song has dozens of recordings, most of them on compilations: a few pages, until one is on an album.
  for (let page = 0; page < 3 && !releaseGroups(recs).some((a) => a.rank === 0); page++) {
    const more = await mbSearchRecordings(query, page * 100);
    recs.push(...more.filter((r) => r['artist-credit']?.length && (norm(cleanTitle(r.title)) === norm(want) || alike(cleanTitle(r.title), want))));
    if (more.length < 100) break;
  }
  return releaseGroups(recs);
}

/** The song's track on the first of these albums that Lidarr has: its recording, else its name. */
async function placeOn(s: Song, albums: Album[]): Promise<boolean> {
  const artists: Artists = new Map();
  const want = norm(cleanTitle(s.title));
  for (const album of albums) {
    const at = await lidarrAlbum(album, artists);
    const track = at && trackOf(at.tracks, s.title, album.recordings);
    if (!at || !track) continue;
    const differs = norm(cleanTitle(track.title)) !== want || !artistsOf(s.artist).some((a) => artistsOf(album.artist).includes(a));
    Object.assign(s, {
      albumMbid: album.mbid,
      artistId: at.artistId,
      albumId: at.albumId,
      releaseId: at.releaseId,
      trackId: track.id,
      length: track.duration ? Math.round(track.duration / 1000) : undefined,
      mb: differs ? { title: track.title, artist: album.artist } : undefined,
    });
    if (track.hasFile) Object.assign(s, { state: 'ready', ready: new Date().toISOString() });
    return true;
  }
  return false;
}

type Artists = Map<string, { id: number; albums: lidarr.LAlbum[] }>;
type InLidarr = { mbid: string; artistId: number; albumId: number; releaseId: number; title: string; artist: string; year?: string; tracks: lidarr.LTrack[] };

/** An album as Lidarr has it (it adds the artist, watching nothing): the edition it files songs into, and that edition's songs. */
async function lidarrAlbum(album: Album, artists: Artists = new Map()): Promise<InLidarr | undefined> {
  if (!album.artistMbid) return;
  let artist = artists.get(album.artistMbid);
  if (!artist) {
    const id = await ensureArtist(album.artistMbid, album.artist);
    artists.set(album.artistMbid, (artist = { id, albums: await albumsOf(id) }));
  }
  const found = artist.albums.find((a) => a.foreignAlbumId === album.mbid);
  return found && edition(found, artist.id, album.artist);
}

async function edition(found: lidarr.LAlbum, artistId: number, artist: string): Promise<InLidarr | undefined> {
  const full = found.releases ? found : await lidarr.album(found.id);
  const release = full.releases?.find((r) => r.monitored) ?? full.releases?.[0];
  if (!release) return;
  const tracks = (await lidarr.tracks(found.id)).filter((t) => !t.albumReleaseId || t.albumReleaseId === release.id);
  return { mbid: found.foreignAlbumId, artistId, albumId: found.id, releaseId: release.id, title: found.title, artist, year: found.releaseDate?.slice(0, 4), tracks };
}

/** A song's track among an album's: its recording, else its name (`loose`: also a name inside the other). */
function trackOf(tracks: lidarr.LTrack[], title: string, recordings?: string[], loose = true) {
  const want = norm(cleanTitle(title));
  return (
    tracks.find((t) => t.foreignRecordingId && recordings?.includes(t.foreignRecordingId)) ??
    tracks.find((t) => norm(cleanTitle(t.title)) === want) ??
    tracks.find((t) => alike(cleanTitle(t.title), title)) ??
    (loose ? tracks.find((t) => norm(t.title).includes(want) || want.includes(norm(cleanTitle(t.title)))) : undefined)
  );
}

/** An artist's albums in Lidarr; a newly added artist's arrive over a few seconds. */
async function albumsOf(artistId: number): Promise<lidarr.LAlbum[]> {
  let last = await lidarr.albums(artistId);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await lidarr.albums(artistId);
    if (now.length && now.length === last.length) return now;
    last = now;
  }
  return last;
}

// ---- Finding a copy on Soulseek ----------------------------------------------------------------------

const AUDIO = /\.(flac|mp3|m4a|aac|ogg|opus|wav|aiff?|alac)$/i;
const UNWANTED = ['live', 'remix', 'instrumental', 'karaoke', 'cover', 'acapella', 'a capella', 'demo', 'slowed', 'sped up', 'reverb', '8d'];

/** Why copies were passed over (for the log when none fit). */
type Passed = { title: number; artist: number; unwanted: number; length: number };

/**
 * The best copy: the right song (title and artist in its path, its length), of the kind the household
 * chose (Settings → Connections: lossless up to CD quality, any lossless, or MP3 320; another kind only
 * when nobody has that), from someone who can send it now: not someone who refused lately, and not
 * someone sending Tuna another song when someone else has it too.
 */
function best(s: Song, responses: slskd.SResponse[], anyone = false, passed?: Passed) {
  const titles = [s.title, s.mb?.title].filter(Boolean).map((x) => words(cleanTitle(x!)));
  const artist = [...artistsOf(s.artist), ...(s.mb ? artistsOf(s.mb.artist) : [])].map(words);
  const unwanted = UNWANTED.filter((u) => !norm(s.title).includes(u));
  const files = soulseekFiles();
  const sending = new Set(songs.filter((x) => x !== s && x.state === 'downloading').map((x) => x.from!.username));
  const out: Array<{ username: string; filename: string; size: number; rank: number; busy: boolean; score: number }> = [];
  for (const r of responses) {
    if (!anyone && (refused.get(r.username) ?? 0) > Date.now()) continue;
    for (const f of r.files) {
      if (f.isLocked || !AUDIO.test(f.filename) || s.tried?.includes(`${r.username}|${f.filename}`)) continue;
      const file = norm(f.filename.split(/[\\/]/).pop() ?? '');
      const full = norm(f.filename);
      const no = (why: keyof Passed) => (passed && passed[why]++, true);
      if (!titles.some((title) => title.every((w) => file.includes(w))) && no('title')) continue;
      if (!artist.some((a) => a.length && a.every((w) => full.includes(w))) && no('artist')) continue;
      if (unwanted.some((u) => file.includes(u)) && no('unwanted')) continue;
      if (s.length && f.length && Math.abs(f.length - s.length) > 6 && no('length')) continue;
      const ext = f.filename.split('.').pop()!.toLowerCase();
      const lossless = ext === 'flac' || ext === 'alac';
      // Hi-res: more than CD's 16 bits at 44.1 or 48 kHz; when the file doesn't say, more than about 12 MB a minute.
      const seconds = f.length || s.length;
      const hires = lossless && ((f.bitDepth ?? 0) > 16 || (f.sampleRate ?? 0) > 48_000 || (!f.bitDepth && !f.sampleRate && Boolean(seconds) && f.size / seconds! > 200_000));
      const kbps = f.bitRate ?? 0;
      const lossy = kbps >= 300 ? 22 : kbps >= 250 ? 16 : kbps >= 190 ? 8 : ext === 'mp3' ? 4 : 0;
      // The kind chosen first, then the nearest, hi-res last (unless that's the choice); within each, the best copy.
      const chosen = files === 'mp3' ? !lossless && kbps >= 240 : files === 'cd' ? lossless && !hires : lossless;
      const rank = chosen ? 2 : hires && files !== 'lossless' ? 0 : 1;
      const quality = files === 'mp3' ? (lossless ? 6 : lossy) : lossless ? (hires && files === 'lossless' ? 34 : 30) : lossy;
      const peer = (r.hasFreeUploadSlot ? 15 : 0) - Math.min(r.queueLength, 15) + Math.min(10, Math.log2(1 + r.uploadSpeed / 100_000) * 2);
      const exact = s.length && f.length ? 6 - Math.abs(f.length - s.length) : 0;
      out.push({ username: r.username, filename: f.filename, size: f.size, rank, busy: sending.has(r.username), score: quality + peer + exact });
    }
  }
  return out.sort((a, b) => b.rank - a.rank || Number(a.busy) - Number(b.busy) || b.score - a.score)[0];
}

async function start(s: Song) {
  s.state = 'looking';
  save();
  try {
    const why = s.trackId ? undefined : await place(s);
    // Not on an album Lidarr has: from Soulseek all the same, straight into the music folder (where Tuna has it).
    if (why && !(await musicFolder())) return notFound(s, why);
    if (why) log.info('get', `"${s.title}" by ${s.artist} is ${why}: from Soulseek straight into the music folder`);
    s.loose = why;
    // Lidarr had it already.
    if ((s.state as Song['state']) === 'ready') return void scanNavidrome();
    await fetchCopy(s);
  } catch (err) {
    // Again in a while (the songs behind it carry on meanwhile), a few times.
    const wait = AGAIN[s.failures ?? 0];
    s.failures = (s.failures ?? 0) + 1;
    log.warn('get', `Couldn't look for "${s.title}" by ${s.artist}${wait ? ` (again in ${wait / 60_000} min)` : ''}`, err);
    if (!wait) return notFound(s, 'looking it up kept failing');
    Object.assign(s, { state: 'waiting', after: Date.now() + wait });
    save();
  }
}

/** Searches Soulseek and asks slskd for the best copy not tried yet. */
async function fetchCopy(s: Song) {
  const first = firstArtist(s.artist);
  const clean = (q: string) => q.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const title = cleanTitle(s.title);
  // The artist's longest word ("Kanye" of "Kanye West"), when the name has more than one.
  const word = (first.match(/[\p{L}\p{N}']+/gu) ?? []).sort((a, b) => b.length - a.length)[0];
  // Spotify's names, then MusicBrainz's. Soulseek doesn't answer searches for some names at all
  // ("Kanye West"): then by the title and its album, the title and one word of the name, the title alone.
  const searches = [
    ...new Set(
      [
        clean(`${first} ${title}`),
        s.mb && clean(`${s.mb.artist} ${cleanTitle(s.mb.title)}`),
        s.album && norm(cleanAlbum(s.album)) !== norm(title) && clean(`${title} ${cleanAlbum(s.album)}`),
        word && norm(word) !== norm(first) && clean(`${title} ${word}`),
        // As people search: the title alone (copies still need the artist in their path).
        clean(title).length >= 4 && clean(title),
      ].filter((q): q is string => Boolean(q)),
    ),
  ];
  const found: slskd.SResponse[] = [];
  let asked = 0;
  for (const q of searches) {
    found.push(...(await slskd.search(q)));
    asked++;
    if (best(s, found, true)) break;
  }
  const pick = best(s, found);
  if (!pick) {
    // Only people who refused lately have it: again once they may send.
    const later = best(s, found, true);
    if (!later) {
      const passed: Passed = { title: 0, artist: 0, unwanted: 0, length: 0 };
      best(s, found, true, passed);
      const people = new Set(found.map((r) => r.username)).size;
      const files = found.reduce((n, r) => n + r.files.length, 0);
      const seen = people
        ? `${people} answered with ${files} file${files === 1 ? '' : 's'}: ${[passed.title && `${passed.title} without the title`, passed.artist && `${passed.artist} without the artist`, passed.unwanted && `${passed.unwanted} live, remixed or covers`, passed.length && `${passed.length} the wrong length`].filter(Boolean).join(', ') || 'none fit'}`
        : `nobody answered ${asked === 1 ? 'the search' : `${asked} searches`}`;
      return notFound(s, `${s.refused ? 'nobody on Soulseek would send it' : 'nobody on Soulseek has it'}: ${seen}`);
    }
    Object.assign(s, { state: 'waiting', after: refused.get(later.username) });
    return void save();
  }
  await slskd.download(pick.username, [{ filename: pick.filename, size: pick.size }]);
  Object.assign(s, { state: 'downloading', from: { username: pick.username, filename: pick.filename, size: pick.size, since: Date.now() }, progress: 0 });
  save();
}

function notFound(s: Song, why: string) {
  Object.assign(s, { state: 'notFound', settled: Date.now() });
  save();
  log.info('get', `Couldn't find "${s.title}" by ${s.artist} (${why})`);
}

// ---- Following downloads, and Lidarr filing them -----------------------------------------------------

/** Where slskd put a download, as Lidarr sees it (through Lidarr's remote path mappings for slskd). */
async function inLidarr(remote: string): Promise<string> {
  const folder = (await slskd.downloadsFolder()) ?? '/downloads';
  const parts = remote.split(/[\\/]/).filter(Boolean);
  let local = path.posix.join(folder, parts.at(-2) ?? '', parts.at(-1) ?? '');
  const host = new URL(slskdConnection()!.url).hostname;
  for (const m of await lidarr.remotePathMappings().catch(() => [])) {
    if (m.host === host && local.startsWith(m.remotePath)) local = path.posix.join(m.localPath, local.slice(m.remotePath.length));
  }
  return local;
}

/**
 * Lidarr files a finished download. slskd says a download succeeded a moment before the file is in
 * its downloads folder (longer for a big file): false until it's there, true once filed or given up.
 */
async function file(s: Song): Promise<boolean> {
  const where = await inLidarr(s.from!.filename);
  if (s.loose) return shelveDownload(s, where);
  const candidates = await lidarr.importable(path.posix.dirname(where)).catch(() => []);
  const item = candidates.find((c) => c.path === where) ?? candidates.find((c) => path.posix.basename(c.path) === path.posix.basename(where));
  if (!item) {
    s.from!.done ??= Date.now();
    save();
    if (Date.now() - s.from!.done < LANDING) return false;
    log.warn('get', `Lidarr can't see "${where}": slskd's downloads folder needs to be visible to Lidarr`);
    notFound(s, "Lidarr can't see slskd's downloads");
    return true;
  }
  if (await intoAlbum(s, item)) arrived(s);
  else notFound(s, "Lidarr couldn't file it");
  return true;
}

/**
 * A song Lidarr has no album for: from slskd's downloads (where Lidarr would see them, in the data
 * folder Tuna has too) straight into the music folder, named and tagged as it was asked for.
 */
async function shelveDownload(s: Song, where: string): Promise<boolean> {
  const root = await musicFolder();
  if (!root || !fs.existsSync(where)) {
    s.from!.done ??= Date.now();
    save();
    if (Date.now() - s.from!.done < LANDING) return false;
    log.warn('get', root ? `Tuna can't see "${where}": slskd's downloads folder needs to be in the data folder Tuna has` : "Tuna can't reach the music folder");
    notFound(s, "Tuna can't see slskd's downloads");
    return true;
  }
  const staged = path.join(root, STAGING, 'soulseek', crypto.randomUUID(), `song${path.extname(where).toLowerCase()}`);
  try {
    await fs.promises.mkdir(path.dirname(staged), { recursive: true });
    await fs.promises.copyFile(where, staged);
    await fs.promises.rm(where, { force: true }).catch(() => undefined);
    await shelve(staged, { title: s.title, artist: tagArtists(s.artist), album: s.album || s.title, albumArtist: firstArtist(s.artist) }, undefined, root);
    arrived(s);
  } catch (err) {
    log.warn('get', `Couldn't put "${s.title}" by ${s.artist} in the music folder`, err);
    notFound(s, "it couldn't go into the music folder");
  } finally {
    await drop(staged);
  }
  return true;
}

/** Lidarr files a copy into the song's track (renamed and tagged as everything it gets): true once it's there. */
async function intoAlbum(s: Pick<Song, 'artistId' | 'albumId' | 'releaseId' | 'trackId'>, item: { path: string; quality: lidarr.LQuality }): Promise<boolean> {
  const { id } = await lidarr.importSong({ path: item.path, artistId: s.artistId!, albumId: s.albumId!, albumReleaseId: s.releaseId!, trackId: s.trackId!, quality: item.quality });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const c = await lidarr.command(id);
    if (c.status === 'completed') return true;
    if (c.status === 'failed' || c.status === 'aborted') break;
  }
  return false;
}

function arrived(s: Song) {
  Object.assign(s, { state: 'ready', ready: new Date().toISOString(), progress: 1 });
  save();
  log.info('get', `Ready: "${s.title}" by ${s.artist} (${s.imported ? `imported by ${s.imported}` : `asked for by ${s.by}`})`);
  void scanNavidrome();
}

/**
 * Tuna's copies that came to nothing (refused, failed, cancelled) off slskd's list. slskd only takes
 * off a download that has ended, and one cancelled while queued ends a moment later: true while any
 * is still ending. Also clears what earlier versions left there.
 */
async function clear(transfers: slskd.STransfer[]): Promise<boolean> {
  const ours = new Set(songs.flatMap((s) => [...(s.tried ?? []), ...(s.from && s.state !== 'downloading' ? [`${s.from.username}|${s.from.filename}`] : [])]));
  let ending = false;
  for (const t of transfers.filter((x) => ours.has(`${x.username}|${x.filename}`))) {
    await slskd.cancel(t.username, t.id).catch(() => undefined);
    if (!t.state.startsWith('Completed')) ending = true;
  }
  return ending;
}

let ticking = false;
let timer: NodeJS.Timeout | undefined;
let leftovers = true;

async function tick() {
  if (ticking || !has.slskd() || !has.lidarr()) return;
  ticking = true;
  try {
    const downloading = songs.filter((s) => s.state === 'downloading');
    if (downloading.length || leftovers) {
      const transfers = await slskd.transfers();
      leftovers = await clear(transfers);
      const of = (s: Song) => transfers.find((x) => x.username === s.from!.username && x.filename === s.from!.filename);
      // Everyone who refused, before another copy is picked for any song.
      for (const s of downloading) if (of(s)?.state.includes('Rejected')) refused.set(s.from!.username, Date.now() + REFUSED_FOR);
      for (const s of downloading) {
        const t = of(s);
        const state = t?.state ?? '';
        if (state.includes('Succeeded') || (!t && s.from!.done)) {
          // Off slskd's list only once filed: taken off before the file is in its downloads folder,
          // slskd stops and leaves it behind.
          if ((await file(s)) && t) await slskd.cancel(t.username, t.id).catch(() => undefined);
        } else if (!t || state.startsWith('Completed') || (state.includes('Queued') && Date.now() - s.from!.since > QUEUED_TOO_LONG)) {
          // Failed, refused, or stuck in a queue: off slskd's list (once it has ended), and another copy.
          if (t) await slskd.cancel(t.username, t.id).catch(() => undefined);
          if (t && !state.startsWith('Completed')) leftovers = true;
          const no = state.includes('Rejected');
          if (no) log.info('get', `${s.from!.username} wouldn't send "${s.title}" by ${s.artist}${t?.exception ? `: ${t.exception}` : ''}`);
          s.tried = [...(s.tried ?? []), `${s.from!.username}|${s.from!.filename}`];
          s.refused = (s.refused ?? 0) + (no ? 1 : 0);
          if (s.tried.length - s.refused >= TRIES || s.tried.length >= COPIES) notFound(s, 'no copy came through');
          else await fetchCopy(s).catch(() => ((s.state = 'waiting'), save()));
        } else if (t?.percentComplete !== undefined && t.percentComplete / 100 !== s.progress) {
          s.progress = t.percentComplete / 100;
        }
      }
    }
    const due = songs.filter((x) => x.state === 'waiting' && (x.after ?? 0) <= Date.now());
    for (const s of due.slice(0, Math.max(0, AT_ONCE - busy().length))) await start(s);
  } catch (err) {
    log.warn('get', "Couldn't check on slskd", err);
  } finally {
    ticking = false;
  }
  const active = leftovers || songs.some((s) => s.state === 'waiting' || s.state === 'looking' || s.state === 'downloading');
  if (active && !timer) timer = setInterval(() => void tick(), 10_000);
  if (!active && timer) (clearInterval(timer), (timer = undefined));
}

// Downloads under way before a restart carry on; songs half looked for start again, and files people sent go in.
for (const s of songs) if (s.state === 'looking' && !s.upload) s.state = 'waiting';
setTimeout(() => {
  for (const s of songs) if (s.state === 'looking' && s.upload) void bring(s);
  void tick();
}, 15_000);

// ---- On its way --------------------------------------------------------------------------------------

function stateOf(s: Song): GetState {
  if (s.state === 'ready') return { state: 'ready' };
  if (s.state === 'notFound') return { state: 'notFound' };
  if (s.state === 'downloading') return { state: 'downloading', progress: s.progress ?? 0 };
  return s.state === 'waiting' ? { state: 'looking', queued: true } : { state: 'looking' };
}

/** Songs on their way, and those that just got somewhere (or weren't found): for the Get buttons on screen. */
export function songsMoving() {
  const lately = Date.now() - 120_000;
  const moving = (s: Song) => s.state === 'waiting' || s.state === 'looking' || s.state === 'downloading' || (s.state === 'ready' ? Date.parse(s.ready ?? '') > lately : (s.settled ?? 0) > lately);
  return songs.filter(moving).map((s) => ({ id: s.id, title: s.title, artist: s.artist, get: stateOf(s) }));
}

export const songItems = (): Array<GetItem & { ready?: string }> =>
  songs.map((s) => ({ mbid: s.id, kind: 'song', title: s.title, artist: s.artist, album: s.album, cover: s.albumMbid ? coverArtFor(s.albumMbid) : undefined, get: stateOf(s), by: s.by, at: s.at, ready: s.ready }));

// ---- Files people have themselves --------------------------------------------------------------------

/** Where a file someone sends waits to go into the library: hidden, so Navidrome and Lidarr pass over it. */
const STAGING = '.tuna';
const SONG_LIMIT = 2 * 1024 ** 3;
const COVER_LIMIT = 30 * 1024 ** 2;
const SONG_FILE = /^\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac|wma|ape|wv)$/;
/** A file this many seconds longer or shorter than the song is another version, or another song. */
const LENGTH_OFF = 10;

let music: { path?: string; at: number } = { at: 0 };
/** Lidarr's music folder, when Tuna has it at the same path (both have the data folder as /data). */
export async function musicFolder(): Promise<string | undefined> {
  if (Date.now() - music.at < 60_000) return music.path;
  let found: string | undefined;
  for (const r of has.lidarr() ? await lidarr.rootFolders().catch(() => []) : []) {
    const at = r.path.replace(/(.)\/+$/, '$1');
    if (await fs.promises.access(at, fs.constants.W_OK).then(() => true, () => false)) {
      found = at;
      break;
    }
  }
  music = { path: found, at: Date.now() };
  return found;
}

/** ffmpeg with these arguments: whether it worked (undefined: there's no ffmpeg). */
function ffmpeg(args: string[]): Promise<boolean | undefined> {
  return new Promise((done) => {
    const p = spawn(process.env.FFMPEG ?? 'ffmpeg', ['-nostdin', '-v', 'error', ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('error', () => (clearTimeout(timer), done(undefined)));
    p.on('exit', (code) => (clearTimeout(timer), done(code === 0)));
  });
}

/** What a file is: its length (seconds) and its tags, lower-cased; null when there's no sound in it (undefined: no ffprobe). */
function probe(file: string): Promise<{ seconds?: number; tags: Record<string, string> } | null | undefined> {
  return new Promise((done) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', file];
    execFile(process.env.FFPROBE ?? 'ffprobe', args, { timeout: 60_000, maxBuffer: 8 * 1024 ** 2 }, (err, out) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return done(undefined);
      try {
        const p = JSON.parse(out) as { streams?: Array<{ duration?: string; tags?: Record<string, string> }>; format?: { duration?: string; tags?: Record<string, string> } };
        if (!p.streams?.length) return done(null);
        const tags = Object.fromEntries(Object.entries({ ...p.streams[0].tags, ...p.format?.tags }).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
        const seconds = Math.round(Number(p.format?.duration ?? p.streams[0].duration));
        done({ seconds: seconds > 0 ? seconds : undefined, tags });
      } catch {
        done(null);
      }
    });
  });
}

/** What comes in, into a file, up to `limit` bytes. */
async function keep(body: Readable, to: string, limit: number) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, next) {
      size += chunk.length;
      next(size > limit ? new HttpError(413, t('That file is too big')) : null, chunk);
    },
  });
  try {
    await pipeline(body, count, fs.createWriteStream(to));
  } catch (err) {
    await fs.promises.rm(to, { force: true });
    throw err;
  }
  if (!size) throw new HttpError(400, t('That file is empty'));
}

const drop = (file: string) => fs.promises.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
/** Why a file isn't the song, by their lengths (where both are known). */
const wrongLength = (file?: number, song?: number) => (file && song && Math.abs(file - song) > LENGTH_OFF ? t('That file is {file} long; the song is {song}', { file: clock(file), song: clock(song) }) : undefined);

/** A file someone sends, kept in the music folder's hidden corner, if it's one that plays: with its length and tags. */
async function receive(name: string, body: Readable, batch: string) {
  const root = await musicFolder();
  if (!root) throw new HttpError(409, t("Tuna can't reach the music folder"));
  const ext = path.extname(name).toLowerCase();
  if (!SONG_FILE.test(ext)) throw new HttpError(400, t("That isn't a song file"));
  // Sends nobody finished: gone after a day.
  for (const old of await fs.promises.readdir(path.join(root, STAGING)).catch(() => [])) {
    const at = path.join(root, STAGING, old);
    if (Date.now() - ((await fs.promises.stat(at).catch(() => undefined))?.mtimeMs ?? Date.now()) > 86400_000) await fs.promises.rm(at, { recursive: true, force: true });
  }
  const id = crypto.randomUUID();
  const file = path.join(root, STAGING, batch, id, `song${ext}`);
  try {
    await keep(body, file, SONG_LIMIT);
    const what = await probe(file);
    if (what === null || (await ffmpeg(['-i', file, '-map', '0:a:0', '-t', '1', '-f', 'null', '-'])) === false) throw new HttpError(400, t("That isn't a song file"));
    return { id, root, file, seconds: what?.seconds, tags: what?.tags ?? {} };
  } catch (err) {
    await drop(file);
    throw err;
  }
}

// A cover sent with files (before them): one per send, a day at most.
const BATCH = /^[\w-]{8,64}$/;
const coversIn = () => path.join(config.dataDir, 'covers-in');
const coverOf = (batch?: string) => (batch && BATCH.test(batch) ? ['.jpg', '.png', '.webp'].map((ext) => path.join(coversIn(), batch + ext)).find((f) => fs.existsSync(f)) : undefined);

/** A cover for the files that follow: as a JPEG of at most 1400 px across (as it came, without ffmpeg). */
export async function takeCover(batch: string, body: Readable) {
  if (!BATCH.test(batch)) throw new HttpError(400, 'batch');
  for (const f of await fs.promises.readdir(coversIn()).catch(() => [])) {
    const at = path.join(coversIn(), f);
    if (Date.now() - ((await fs.promises.stat(at).catch(() => undefined))?.mtimeMs ?? Date.now()) > 86400_000) await fs.promises.rm(at, { force: true });
  }
  const raw = path.join(coversIn(), `${batch}.in`);
  await keep(body, raw, COVER_LIMIT);
  const head = Buffer.alloc(12);
  const fd = await fs.promises.open(raw, 'r');
  await fd.read(head, 0, 12, 0).finally(() => fd.close());
  const kind = head[0] === 0xff && head[1] === 0xd8 ? '.jpg' : head.toString('hex', 0, 4) === '89504e47' ? '.png' : head.toString('latin1', 8, 12) === 'WEBP' ? '.webp' : undefined;
  if (!kind) {
    await fs.promises.rm(raw, { force: true });
    throw new HttpError(400, t("That isn't a picture"));
  }
  const jpg = path.join(coversIn(), `${batch}.jpg`);
  if (!(await ffmpeg(['-i', raw, '-vf', "scale='min(1400,iw)':-2", '-frames:v', '1', '-q:v', '3', '-y', jpg]))) {
    await fs.promises.rm(jpg, { force: true });
    await fs.promises.rename(raw, path.join(coversIn(), batch + kind));
  }
  await fs.promises.rm(raw, { force: true });
}

/** What a file seems to be: by its tags, else its folders (Artist/Album/…) and its name. */
export interface Guess {
  title: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  year?: string;
  number?: number;
  disc?: number;
}
/** The names a song goes in with (as the person looked them over). */
interface Names {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year?: string;
  number?: number;
  disc?: number;
}
interface Staged {
  id: string;
  batch: string;
  by: string;
  file: string;
  root: string;
  seconds?: number;
  guess: Guess;
}
/** Files sent, not put in yet: for the person to look over first. */
const staged = new Map<string, Staged>();

/** A file someone sends to put in (a song's, an album's, or any): kept aside if it plays, with what it seems to be. */
export async function stage(by: string, batch: string, name: string, where: string | undefined, body: Readable): Promise<{ id: string; seconds?: number; guess: Guess }> {
  if (!BATCH.test(batch)) throw new HttpError(400, 'batch');
  const got = await receive(name, body, batch);
  const tags = got.tags;
  const folders = (where ?? '').split('/').slice(0, -1);
  const base = path.basename(name, path.extname(name));
  const guess: Guess = {
    title: tags.title || base.replace(/^[\s\d.\-_]+(?=\S)/, '').trim() || base,
    artist: tags.artist || tags.album_artist || tags.albumartist || folders.at(-2),
    albumArtist: tags.album_artist || tags.albumartist || tags.artist || folders.at(-2),
    album: tags.album || folders.at(-1),
    year: (tags.date || tags.year || tags.originaldate || '').match(/\d{4}/)?.[0],
    number: parseInt(tags.track ?? '', 10) || parseInt(base.match(/^\s*(\d{1,3})[\s.\-_]/)?.[1] ?? '', 10) || undefined,
    disc: parseInt(tags.disc ?? '', 10) || undefined,
  };
  staged.set(got.id, { id: got.id, batch, by, file: got.file, root: got.root, seconds: got.seconds, guess });
  return { id: got.id, seconds: got.seconds, guess };
}

/** Someone changed their mind: what they sent goes. */
export async function discard(by: string, batch: string) {
  for (const f of [...staged.values()].filter((x) => x.batch === batch && x.by === by)) {
    staged.delete(f.id);
    await drop(f.file);
  }
  const cover = coverOf(batch);
  if (cover) await fs.promises.rm(cover, { force: true });
}

const trackSeconds = (x: lidarr.LTrack) => (x.duration ? Math.round(x.duration / 1000) : undefined);
/** A file's song on the album: by its name, else by its number when the length agrees. */
const matchTrack = (at: InLidarr, title: string, number?: number, disc?: number, seconds?: number) =>
  trackOf(at.tracks, title, undefined, false) ??
  at.tracks.find((x) => number && x.absoluteTrackNumber === number && (x.mediumNumber ?? 1) === (disc ?? 1) && seconds && trackSeconds(x) && !wrongLength(seconds, trackSeconds(x)));
/** Why a file can't be that song. */
const whyNot = (track: lidarr.LTrack, seconds?: number) => (track.hasFile ? t("It's in the library already") : wrongLength(seconds, trackSeconds(track)));

/** What Lidarr (MusicBrainz) knows of the album the files seem to be: its names and year, and each file's song on it, or why it can't be. */
export async function checkStaged(by: string, q: { artist?: string; album?: string; mbid?: string; files?: Array<{ id: string; title: string; number?: number; disc?: number }> }) {
  const at = has.lidarr() && q.artist && q.album ? await albumIn(q.artist, q.album, q.mbid) : undefined;
  if (!at) return { files: [] };
  return {
    album: { title: at.title, artist: at.artist, year: at.year, mbid: at.mbid },
    files: (q.files ?? []).flatMap((f) => {
      const s = staged.get(f.id);
      if (!s || s.by !== by) return [];
      const track = matchTrack(at, f.title, f.number, f.disc, s.seconds);
      return [track ? { id: f.id, title: track.title, number: track.absoluteTrackNumber, disc: track.mediumNumber, why: whyNot(track, s.seconds) } : { id: f.id }];
    }),
  };
}

export interface ImportRequest {
  batch: string;
  /** The song asked for that these are for (one file: it, whatever the names). */
  song?: { artist: string; title: string };
  album: { artist: string; title: string; year?: string; mbid?: string };
  files: Array<{ id: string; title: string; artist?: string; number?: number; disc?: number }>;
}

/**
 * Files someone sent and looked over, into the library with the names they gave: through Lidarr
 * where it has the album (each checked against its song's length), else straight into the music
 * folder. Why not, for each that didn't go in.
 */
export async function importStaged(by: string, req: ImportRequest): Promise<Array<{ id: string; why?: string }>> {
  const album = { artist: req.album.artist?.trim() ?? '', title: req.album.title?.trim() ?? '', year: req.album.year?.match(/\d{4}/)?.[0] };
  if (!album.artist || !album.title) throw new HttpError(400, t('Give it an artist and an album'));
  const cover = coverOf(req.batch);
  const out: Array<{ id: string; why?: string }> = [];
  const files: Array<{ f: Staged; names: Names }> = [];
  for (const x of req.files ?? []) {
    const f = staged.get(x.id);
    if (!f || f.by !== by) out.push({ id: x.id, why: t("That file isn't here any more") });
    else {
      staged.delete(f.id);
      files.push({ f, names: { title: x.title?.trim() || f.guess.title, artist: x.artist?.trim() || album.artist, album: album.title, albumArtist: album.artist, year: album.year, number: x.number || undefined, disc: x.disc || undefined } });
    }
  }
  if (req.song && files.length === 1) return [...out, { id: files[0].f.id, why: await forSong(by, req.song, files[0].f, files[0].names, cover) }];
  const at = has.lidarr() && files.length ? await albumIn(album.artist, album.title, req.album.mbid) : undefined;
  for (const { f, names } of files) {
    const track = at && matchTrack(at, names.title, names.number, names.disc, f.seconds);
    const why = track && whyNot(track, f.seconds);
    if (why) {
      await drop(f.file);
      out.push({ id: f.id, why });
    } else if (at && track) {
      track.hasFile = true;
      fileLater(by, at, track, f, names, cover);
      out.push({ id: f.id });
    } else {
      try {
        await shelve(f.file, names, cover, f.root);
        here(names.artist, names.title, by);
        out.push({ id: f.id });
      } catch (err) {
        log.warn('get', `Couldn't put "${names.title}" by ${names.artist} in the library`, err);
        out.push({ id: f.id, why: t("Couldn't put it in") });
      } finally {
        await drop(f.file);
      }
    }
  }
  if (out.some((x) => !x.why && files.some((y) => y.f.id === x.id))) {
    albumSent({ mbid: req.album.mbid ?? at?.mbid, artist: album.artist, title: album.title });
    missedSent(album.artist, album.title);
  }
  return out;
}

/** Lidarr files them one by one, in the order they came. */
let filing = Promise.resolve();
function fileLater(by: string, at: InLidarr, track: lidarr.LTrack, f: Staged, names: Names, cover?: string) {
  filing = filing.then(async () => {
    try {
      await tag(f.file, { album: at.title, album_artist: at.artist, date: names.year }, cover);
      if (await viaLidarr({ artistId: at.artistId, albumId: at.albumId, releaseId: at.releaseId, trackId: track.id }, f.file)) return here(at.artist, track.title, by);
      await shelve(f.file, names, cover, f.root);
      here(names.artist, names.title, by);
    } catch (err) {
      track.hasFile = false;
      log.warn('get', `Couldn't put "${track.title}" by ${at.artist} in the library`, err);
    } finally {
      await drop(f.file);
    }
  });
}

const busyWith = (s?: Song) => s && (s.state === 'ready' || s.state === 'downloading' || s.state === 'looking');

/** A file for one song asked for (one Soulseek didn't have, say), checked against its length where it's known: why not, if not. */
async function forSong(by: string, want: { artist: string; title: string }, f: Staged, names: Names, cover?: string): Promise<string | undefined> {
  const s = songs.find((x) => key(x) === key(want));
  const why = busyWith(s) ? (s!.state === 'ready' ? t("It's in the library already") : t("It's on its way already")) : wrongLength(f.seconds, s?.length);
  if (why) {
    await drop(f.file);
    return why;
  }
  const song: Song = s ?? { id: crypto.randomUUID(), artist: want.artist, title: want.title, album: names.album, by, at: new Date().toISOString(), state: 'looking' };
  if (!s) songs.push(song);
  Object.assign(song, { state: 'looking', album: song.album ?? names.album, upload: { file: f.file, cover, seconds: f.seconds, names }, imported: by, for: undefined, week: undefined, after: undefined });
  save();
  log.info('get', `${by} sent a file for "${song.title}" by ${song.artist}`);
  void bring(song);
}

/**
 * Puts a file someone sent for a song into the library: through Lidarr when the song is on an album
 * it has (it files it there, as anything it gets), else straight into the music folder, with the
 * names they gave (else the playlist's) and its cover.
 */
async function bring(s: Song) {
  const { file, cover, seconds } = s.upload!;
  const names = s.upload!.names ?? { title: s.title, artist: tagArtists(s.artist), album: s.album || s.title, albumArtist: firstArtist(s.artist) };
  try {
    const root = await musicFolder();
    if (!root || !fs.existsSync(file)) throw new Error("the file isn't there any more");
    if (!s.trackId) await place(s).catch(() => undefined);
    if ((s.state as Song['state']) === 'ready') return void scanNavidrome();
    const off = wrongLength(seconds, s.length);
    if (off) return notFound(s, `the file sent isn't it: ${off}`);
    if (s.trackId) {
      const album = await lidarr.album(s.albumId!).catch(() => undefined);
      await tag(file, { title: names.title, artist: names.artist, album: album?.title, album_artist: album?.artist?.artistName, date: names.year }, cover);
      if (await viaLidarr(s, file)) return arrived(s);
    }
    await shelve(file, names, cover, root);
    arrived(s);
  } catch (err) {
    log.warn('get', `Couldn't put "${s.title}" by ${s.artist} in the library`, err);
    notFound(s, "the file someone sent couldn't go in");
  } finally {
    await drop(file);
    if (cover) await fs.promises.rm(cover, { force: true }).catch(() => undefined);
    s.upload = undefined;
    save();
  }
}

/** Lidarr files a file someone sent into its track: true once it's there. */
async function viaLidarr(ids: Pick<Song, 'artistId' | 'albumId' | 'releaseId' | 'trackId'>, file: string): Promise<boolean> {
  const items = await lidarr.importable(path.dirname(file)).catch(() => []);
  const item = items.find((c) => c.path === file) ?? items.find((c) => path.basename(c.path) === path.basename(file));
  if (item && ((await intoAlbum(ids, item)) || !fs.existsSync(file))) return true;
  log.warn('get', item ? `Lidarr couldn't file "${file}": into the music folder as it is` : `Lidarr can't see "${file}": Tuna needs the music folder at the same path as Lidarr`);
  return false;
}

const albumsSeen = new Map<string, { at: number; found: Promise<InLidarr | undefined> }>();
/** An album by its names (or its MusicBrainz id), as Lidarr has it; remembered a while, for the rest of its files. */
function albumIn(artist: string, album: string, mbid?: string): Promise<InLidarr | undefined> {
  const k = `${norm(artist)}|${norm(album)}|${mbid ?? ''}`;
  const seen = albumsSeen.get(k);
  if (seen && Date.now() - seen.at < 10 * 60_000) return seen.found;
  const found = (async () => {
    const known = mbid ? await lidarr.albumByMbid(mbid).catch(() => undefined) : undefined;
    if (known?.artistId) return edition(known, known.artistId, known.artist?.artistName ?? artist);
    const named = await resolve(artist, album).catch(() => undefined);
    return named ? lidarrAlbum(named) : undefined;
  })().catch(() => undefined);
  albumsSeen.set(k, { at: Date.now(), found });
  return found;
}

/** A song someone sent is in: the same song asked for is too. */
function here(artist: string, title: string, by: string) {
  const want = norm(cleanTitle(title));
  let told = false;
  for (const s of songs) {
    const same = norm(cleanTitle(s.title)) === want && artistsOf(s.artist).some((a) => artistsOf(artist).includes(a));
    if (same && s.state !== 'ready' && s.state !== 'downloading' && !s.upload) {
      s.imported = by;
      arrived(s);
      told = true;
    }
  }
  if (!told) log.info('get', `Ready: "${title}" by ${artist} (imported by ${by})`);
  void scanNavidrome();
}

/** Spotify's "A;B" as players split artists. */
const tagArtists = (artist: string) => artist.split(/\s*;\s*/).join('; ');

/** A name as a file or folder name anywhere (Windows shares too). */
const safe = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120) || '_';

/**
 * Into the music folder as Album artist/Album/NN - Title, with those names written into it, and the
 * cover next to it (cover.jpg, as players look for) unless the album has one.
 */
async function shelve(file: string, n: Names, cover: string | undefined, root: string) {
  await tag(file, { title: n.title, artist: n.artist, album_artist: n.albumArtist, album: n.album, date: n.year, track: n.number ? String(n.number) : undefined, disc: n.disc ? String(n.disc) : undefined }, cover);
  const dir = path.join(root, safe(n.albumArtist), safe(n.album));
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(file);
  const name = `${n.number ? `${n.disc && n.disc > 1 ? `${n.disc}-` : ''}${String(n.number).padStart(2, '0')} - ` : ''}${safe(n.title)}`;
  let to = path.join(dir, `${name}${ext}`);
  for (let i = 2; fs.existsSync(to); i++) to = path.join(dir, `${name} (${i})${ext}`);
  await fs.promises.rename(file, to);
  if (cover && !(await fs.promises.readdir(dir)).some((f) => /^(cover|folder)\.(jpe?g|png|webp)$/i.test(f))) await fs.promises.copyFile(cover, path.join(dir, `cover${path.extname(cover)}`));
}

/** Names (and the cover, where the file can hold one) written into the file; as it was where ffmpeg can't. */
async function tag(file: string, names: Record<string, string | undefined>, cover?: string) {
  const ext = path.extname(file);
  const out = path.join(path.dirname(file), `tagged${ext}`);
  const meta = Object.entries(names).flatMap(([k, v]) => (v ? ['-metadata', `${k}=${v}`] : []));
  if (!meta.length && !cover) return;
  const ways = [
    ...(cover ? [['-i', file, '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v:0', 'attached_pic']] : []),
    ['-i', file, '-map', '0', '-c', 'copy'],
    ['-i', file, '-map', '0:a', '-c', 'copy'],
  ];
  for (const way of ways) {
    if (await ffmpeg([...way, '-map_metadata', '0', ...meta, ...(ext === '.mp3' ? ['-id3v2_version', '3'] : []), '-y', out])) return fs.promises.rename(out, file);
  }
  await fs.promises.rm(out, { force: true });
}

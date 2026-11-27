import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GetItem, GetState } from '@tuna/shared';
import * as lidarr from '../clients/lidarr';
import { coverArtFor, mbSearchRecordings, type MbRecording } from '../clients/public';
import * as slskd from '../clients/slskd';
import { config } from '../config';
import { has, slskd as slskdConnection, soulseekFiles } from '../connections';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { ensureArtist, scanNavidrome } from './getting';
import type { SubsonicAuth } from '../clients/navidrome';
import { norm, toTrack } from './library';
import { alike, artistsOf, cleanAlbum, firstArtist, matcher, releaseGroups, songIndex } from './matching';
import { resolve } from './stocking';

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
  for (const s of again) Object.assign(s, { state: 'waiting', tried: undefined, refused: undefined, failures: undefined, after: undefined, from: undefined, progress: undefined });
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
  const artists = new Map<string, { id: number; albums: lidarr.LAlbum[] }>();
  const want = norm(cleanTitle(s.title));
  for (const album of albums) {
    if (!album.artistMbid) continue;
    let artist = artists.get(album.artistMbid);
    if (!artist) {
      const id = await ensureArtist(album.artistMbid, album.artist);
      artists.set(album.artistMbid, (artist = { id, albums: await albumsOf(id) }));
    }
    const found = artist.albums.find((a) => a.foreignAlbumId === album.mbid);
    if (!found) continue;
    const full = found.releases ? found : await lidarr.album(found.id);
    const release = full.releases?.find((r) => r.monitored) ?? full.releases?.[0];
    const tracks = (await lidarr.tracks(found.id)).filter((t) => !release || !t.albumReleaseId || t.albumReleaseId === release.id);
    const track =
      tracks.find((t) => t.foreignRecordingId && album.recordings?.includes(t.foreignRecordingId)) ??
      tracks.find((t) => norm(cleanTitle(t.title)) === want) ??
      tracks.find((t) => alike(cleanTitle(t.title), s.title)) ??
      tracks.find((t) => norm(t.title).includes(want) || want.includes(norm(cleanTitle(t.title))));
    if (!track || !release) continue;
    const differs = norm(cleanTitle(track.title)) !== want || !artistsOf(s.artist).some((a) => artistsOf(album.artist).includes(a));
    Object.assign(s, {
      albumMbid: album.mbid,
      artistId: artist.id,
      albumId: found.id,
      releaseId: release.id,
      trackId: track.id,
      length: track.duration ? Math.round(track.duration / 1000) : undefined,
      mb: differs ? { title: track.title, artist: album.artist } : undefined,
    });
    if (track.hasFile) Object.assign(s, { state: 'ready', ready: new Date().toISOString() });
    return true;
  }
  return false;
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

/**
 * The best copy: the right song (title and artist in its path, its length), of the kind the household
 * chose (Settings → Connections: lossless up to CD quality, any lossless, or MP3 320; another kind only
 * when nobody has that), from someone who can send it now: not someone who refused lately, and not
 * someone sending Tuna another song when someone else has it too.
 */
function best(s: Song, responses: slskd.SResponse[], anyone = false) {
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
      if (!titles.some((title) => title.every((w) => file.includes(w)))) continue;
      if (!artist.some((a) => a.length && a.every((w) => full.includes(w)))) continue;
      if (unwanted.some((u) => file.includes(u))) continue;
      if (s.length && f.length && Math.abs(f.length - s.length) > 6) continue;
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
    if (why) return notFound(s, why);
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
  const query = (artist: string, title: string) => `${artist} ${cleanTitle(title)}`.replace(/[^\p{L}\p{N}' ]+/gu, ' ');
  let found = await slskd.search(query(first, s.title));
  // Nobody has it under Spotify's names: under MusicBrainz's.
  if (s.mb && !best(s, found, true)) found = [...found, ...(await slskd.search(query(s.mb.artist, s.mb.title)))];
  const pick = best(s, found);
  if (!pick) {
    // Only people who refused lately have it: again once they may send.
    const later = best(s, found, true);
    if (!later) return notFound(s, s.refused ? 'nobody on Soulseek would send it' : 'nobody on Soulseek has it');
    Object.assign(s, { state: 'waiting', after: refused.get(later.username) });
    return void save();
  }
  await slskd.download(pick.username, [{ filename: pick.filename, size: pick.size }]);
  Object.assign(s, { state: 'downloading', from: { username: pick.username, filename: pick.filename, size: pick.size, since: Date.now() }, progress: 0 });
  save();
}

function notFound(s: Song, why: string) {
  s.state = 'notFound';
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
  const { id } = await lidarr.importSong({ path: item.path, artistId: s.artistId!, albumId: s.albumId!, albumReleaseId: s.releaseId!, trackId: s.trackId!, quality: item.quality });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const c = await lidarr.command(id);
    if (c.status === 'completed') {
      Object.assign(s, { state: 'ready', ready: new Date().toISOString(), progress: 1 });
      save();
      log.info('get', `Ready: "${s.title}" by ${s.artist} (asked for by ${s.by})`);
      void scanNavidrome();
      return true;
    }
    if (c.status === 'failed' || c.status === 'aborted') break;
  }
  notFound(s, "Lidarr couldn't file it");
  return true;
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

// Downloads under way before a restart carry on; songs half looked for start again.
for (const s of songs) if (s.state === 'looking') s.state = 'waiting';
setTimeout(() => void tick(), 15_000);

// ---- On its way --------------------------------------------------------------------------------------

function stateOf(s: Song): GetState {
  if (s.state === 'ready') return { state: 'ready' };
  if (s.state === 'notFound') return { state: 'notFound' };
  if (s.state === 'downloading') return { state: 'downloading', progress: s.progress ?? 0 };
  return { state: 'looking' };
}

export const songItems = (): Array<GetItem & { ready?: string }> =>
  songs.map((s) => ({ mbid: s.id, kind: 'song', title: s.title, artist: s.artist, album: s.album, cover: s.albumMbid ? coverArtFor(s.albumMbid) : undefined, get: stateOf(s), by: s.by, at: s.at, ready: s.ready }));

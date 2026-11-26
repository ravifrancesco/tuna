import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GetItem, GetState } from '@tuna/shared';
import * as lidarr from '../clients/lidarr';
import { coverArtFor, mbSearchRecordings } from '../clients/public';
import * as slskd from '../clients/slskd';
import { config } from '../config';
import { has, slskd as slskdConnection } from '../connections';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { ensureArtist, findAlbum, scanNavidrome } from './getting';
import type { SubsonicAuth } from '../clients/navidrome';
import { norm, toTrack } from './library';
import { artistsOf, matcher, songIndex } from './matching';
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
  /** The copy being downloaded, and those tried before it. */
  from?: { username: string; filename: string; size: number; since: number };
  tried?: string[];
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
export function wantSongs(by: string, list: Array<{ artist: string; title: string; album?: string }>, discovery?: { for: string; week: number; radio?: string }): number {
  const known = new Map(songs.filter((s) => s.state !== 'notFound').map((s) => [key(s), s]));
  for (const s of list) {
    const k = known.get(key(s));
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

/** Its album (as Lidarr knows it) and its track there; Lidarr adds the artist, watching nothing. */
async function place(s: Song): Promise<boolean> {
  const first = s.artist.split(/\s*;\s*/)[0] || s.artist;
  let album = s.album ? await resolve(s.artist, s.album) : undefined;
  if (!album) {
    // No album (or not one Lidarr knows): the release the song first came out on, an album if there's one.
    const recs = await mbSearchRecordings(`recording:"${cleanTitle(s.title).replace(/"/g, '')}" AND artist:"${first.replace(/"/g, '')}"`);
    const rank = (t?: string) => (t === 'Album' ? 0 : t === 'Single' ? 1 : t === 'EP' ? 2 : 3);
    const groups = recs
      .filter((r) => norm(cleanTitle(r.title)) === norm(cleanTitle(s.title)))
      .flatMap((r) => (r.releases ?? []).map((rel) => ({ group: rel['release-group'], artist: r['artist-credit']?.[0] })))
      .filter((x) => x.group && !x.group['secondary-types']?.length)
      .sort((a, b) => rank(a.group?.['primary-type']) - rank(b.group?.['primary-type']));
    const g = groups[0];
    if (g?.group && g.artist) album = { mbid: g.group.id, artistMbid: g.artist.artist.id, title: g.group.title, artist: g.artist.name };
  }
  if (!album?.artistMbid) return false;
  const artistId = await ensureArtist(album.artistMbid, album.artist);
  const found = await findAlbum(artistId, album.mbid);
  if (!found) return false;
  const full = found.releases ? found : await lidarr.album(found.id);
  const release = full.releases?.find((r) => r.monitored) ?? full.releases?.[0];
  const tracks = (await lidarr.tracks(found.id)).filter((t) => !release || !t.albumReleaseId || t.albumReleaseId === release.id);
  const want = norm(cleanTitle(s.title));
  const track = tracks.find((t) => norm(cleanTitle(t.title)) === want) ?? tracks.find((t) => norm(t.title).includes(want) || want.includes(norm(cleanTitle(t.title))));
  if (!track || !release) return false;
  Object.assign(s, { albumMbid: album.mbid, artistId, albumId: found.id, releaseId: release.id, trackId: track.id, length: track.duration ? Math.round(track.duration / 1000) : undefined });
  if (track.hasFile) Object.assign(s, { state: 'ready', ready: new Date().toISOString() });
  return true;
}

// ---- Finding a copy on Soulseek ----------------------------------------------------------------------

const AUDIO = /\.(flac|mp3|m4a|aac|ogg|opus|wav|aiff?|alac)$/i;
const UNWANTED = ['live', 'remix', 'instrumental', 'karaoke', 'cover', 'acapella', 'a capella', 'demo', 'slowed', 'sped up', 'reverb', '8d'];

/** The best copy: the right song (title and artist in its path, its length), lossless if there's one, from someone who can send it now. */
function best(s: Song, responses: slskd.SResponse[]) {
  const title = words(cleanTitle(s.title));
  const artist = artistsOf(s.artist).map(words);
  const unwanted = UNWANTED.filter((u) => !norm(s.title).includes(u));
  const out: Array<{ username: string; filename: string; size: number; score: number }> = [];
  for (const r of responses) {
    for (const f of r.files) {
      if (f.isLocked || !AUDIO.test(f.filename) || s.tried?.includes(`${r.username}|${f.filename}`)) continue;
      const file = norm(f.filename.split(/[\\/]/).pop() ?? '');
      const full = norm(f.filename);
      if (!title.every((w) => file.includes(w))) continue;
      if (!artist.some((a) => a.length && a.every((w) => full.includes(w)))) continue;
      if (unwanted.some((u) => file.includes(u))) continue;
      if (s.length && f.length && Math.abs(f.length - s.length) > 6) continue;
      const ext = f.filename.split('.').pop()!.toLowerCase();
      const quality = ext === 'flac' || ext === 'alac' ? 30 : (f.bitRate ?? 0) >= 300 ? 22 : (f.bitRate ?? 0) >= 250 ? 16 : (f.bitRate ?? 0) >= 190 ? 8 : ext === 'mp3' ? 4 : 0;
      const peer = (r.hasFreeUploadSlot ? 15 : 0) - Math.min(r.queueLength, 15) + Math.min(10, Math.log2(1 + r.uploadSpeed / 100_000) * 2);
      const exact = s.length && f.length ? 6 - Math.abs(f.length - s.length) : 0;
      out.push({ username: r.username, filename: f.filename, size: f.size, score: quality + peer + exact });
    }
  }
  return out.sort((a, b) => b.score - a.score)[0];
}

async function start(s: Song) {
  s.state = 'looking';
  save();
  try {
    if (!s.trackId && !(await place(s))) return notFound(s, 'not in MusicBrainz');
    // Lidarr had it already.
    if ((s.state as Song['state']) === 'ready') return void scanNavidrome();
    await fetchCopy(s);
  } catch (err) {
    log.warn('get', `Couldn't look for "${s.title}" by ${s.artist}`, err);
    s.state = 'waiting';
    save();
  }
}

/** Searches Soulseek and asks slskd for the best copy not tried yet. */
async function fetchCopy(s: Song) {
  const first = s.artist.split(/\s*;\s*/)[0] || s.artist;
  const pick = best(s, await slskd.search(`${first} ${cleanTitle(s.title)}`.replace(/[^\p{L}\p{N}' ]+/gu, ' ')));
  if (!pick) return notFound(s, 'nobody on Soulseek has it');
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

async function file(s: Song) {
  const where = await inLidarr(s.from!.filename);
  const candidates = await lidarr.importable(path.posix.dirname(where));
  const item = candidates.find((c) => c.path === where) ?? candidates.find((c) => path.posix.basename(c.path) === path.posix.basename(where));
  if (!item) {
    log.warn('get', `Lidarr can't see "${where}": slskd's downloads folder needs to be visible to Lidarr`);
    return notFound(s, "Lidarr can't see slskd's downloads");
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
      return;
    }
    if (c.status === 'failed' || c.status === 'aborted') break;
  }
  notFound(s, "Lidarr couldn't file it");
}

let ticking = false;
let timer: NodeJS.Timeout | undefined;

async function tick() {
  if (ticking || !has.slskd() || !has.lidarr()) return;
  ticking = true;
  try {
    const downloading = songs.filter((s) => s.state === 'downloading');
    if (downloading.length) {
      const transfers = await slskd.transfers();
      for (const s of downloading) {
        const t = transfers.find((x) => x.username === s.from!.username && x.filename === s.from!.filename);
        const state = t?.state ?? '';
        if (state.includes('Succeeded')) {
          await slskd.cancel(t!.username, t!.id).catch(() => undefined);
          await file(s);
        } else if (!t || state.startsWith('Completed') || (state.includes('Queued') && Date.now() - s.from!.since > QUEUED_TOO_LONG)) {
          // Failed, refused, or stuck in a queue: another copy, a couple of times.
          if (t && !state.startsWith('Completed')) await slskd.cancel(t.username, t.id).catch(() => undefined);
          s.tried = [...(s.tried ?? []), `${s.from!.username}|${s.from!.filename}`];
          if (s.tried.length >= TRIES) notFound(s, 'no copy came through');
          else await fetchCopy(s).catch(() => ((s.state = 'waiting'), save()));
        } else if (t?.percentComplete !== undefined && t.percentComplete / 100 !== s.progress) {
          s.progress = t.percentComplete / 100;
        }
      }
    }
    for (const s of songs.filter((x) => x.state === 'waiting').slice(0, Math.max(0, AT_ONCE - busy().length))) await start(s);
  } catch (err) {
    log.warn('get', "Couldn't check on slskd", err);
  } finally {
    ticking = false;
  }
  const active = songs.some((s) => s.state === 'waiting' || s.state === 'looking' || s.state === 'downloading');
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

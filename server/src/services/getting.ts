import fs from 'node:fs';
import path from 'node:path';
import type { GetItem, GetState } from '@tuna/shared';
import * as lidarr from '../clients/lidarr';
import { subsonic } from '../clients/navidrome';
import { coverArtFor, mbReleaseGroup } from '../clients/public';
import { config } from '../config';
import { has } from '../connections';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { HttpError, UpstreamError } from '../lib/upstream';
import { adminAuth, type Session } from '../sessions';
import { fillImported } from './imported';
import { forgetSongIndex } from './matching';
import { forgetLibraryIndex } from './library';

/**
 * Get: someone taps Get on an album that isn't in the library. Tuna adds its artist to Lidarr
 * (watching nothing else of theirs), watches that one album and asks Lidarr to look for it.
 * Lidarr finds it through Prowlarr, qBittorrent downloads it, Lidarr files it in the music
 * folder, and Navidrome picks it up. Tuna remembers who asked, and follows it until it's ready.
 */

interface Request {
  mbid: string;
  artistMbid?: string;
  title: string;
  artist: string;
  by: string;
  at: string;
  lidarrAlbumId?: number;
  /** When it was all there (ISO). */
  ready?: string;
}

const FILE = () => path.join(config.dataDir, 'getting.json');
let requests: Request[] = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Request[];
  } catch {
    return [];
  }
})();
const save = () => writeJson(FILE(), requests.slice(-500));

/** Lidarr's side, refreshed at most every few seconds and only while something is on its way. */
let state = { at: 0, queue: [] as lidarr.LQueueItem[], albums: new Map<number, lidarr.LAlbum>() };
let refreshing: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;

const pending = () => requests.filter((r) => !r.ready && r.lidarrAlbumId);

/** Songs Lidarr has filed for each album, to notice new ones. */
const filesSeen = new Map<number, number>();

// Lidarr filed new songs: Navidrome looks now rather than at its next scheduled scan.
let scanning = false;
let scanAgain = false;
export async function scanNavidrome() {
  if (scanning) return void (scanAgain = true);
  const auth = adminAuth();
  if (!auth) return forgetLibraryIndex();
  scanning = true;
  try {
    do {
      scanAgain = false;
      await subsonic(auth, 'startScan');
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await subsonic<{ scanStatus?: { scanning?: boolean } }>(auth, 'getScanStatus');
        if (!s.scanStatus?.scanning) break;
      }
      forgetLibraryIndex();
      forgetSongIndex();
    } while (scanAgain);
    // Songs that arrived may belong in playlists brought over from Spotify.
    void fillImported();
  } catch (err) {
    log.warn('get', "Couldn't ask Navidrome to look for new music", err);
    forgetLibraryIndex();
    forgetSongIndex();
  } finally {
    scanning = false;
  }
}

async function refresh() {
  if (!has.lidarr() || Date.now() - state.at < 4000) return;
  refreshing ??= (async () => {
    try {
      const gone = new Set<number>();
      const [queue, albums] = await Promise.all([
        lidarr.queue(),
        Promise.all(
          pending().map((r) =>
            lidarr.album(r.lidarrAlbumId!).catch((err: unknown) => {
              if (err instanceof UpstreamError && err.status === 404) gone.add(r.lidarrAlbumId!);
              return undefined;
            }),
          ),
        ),
      ]);
      // Taken out of Lidarr: no longer on its way.
      if (gone.size) {
        for (const r of requests.filter((x) => !x.ready && gone.has(x.lidarrAlbumId!))) log.info('get', `No longer in Lidarr: "${r.title}" by ${r.artist}`);
        requests = requests.filter((x) => x.ready || !gone.has(x.lidarrAlbumId!));
        save();
      }
      const map = new Map<number, lidarr.LAlbum>();
      for (const a of albums) if (a) map.set(a.id, a);
      state = { at: Date.now(), queue, albums: map };
      let changed = false;
      let landed = false;
      for (const r of pending()) {
        const s = map.get(r.lidarrAlbumId!)?.statistics;
        const files = s?.trackFileCount ?? 0;
        if (files > (filesSeen.get(r.lidarrAlbumId!) ?? 0)) landed = true;
        filesSeen.set(r.lidarrAlbumId!, files);
        if (s && s.trackCount > 0 && s.trackFileCount >= s.trackCount) {
          r.ready = new Date().toISOString();
          changed = true;
          filesSeen.delete(r.lidarrAlbumId!);
          log.info('get', `Ready: "${r.title}" by ${r.artist} (asked for by ${r.by})`);
        }
      }
      if (changed) save();
      if (landed) void scanNavidrome();
    } catch (err) {
      log.warn('get', "Couldn't check on Lidarr", err);
      state.at = Date.now();
    } finally {
      refreshing = undefined;
    }
  })();
  await refreshing;
}

function watch() {
  if (timer || !pending().length) return;
  timer = setInterval(() => {
    if (!pending().length) {
      clearInterval(timer);
      timer = undefined;
      return;
    }
    void refresh();
  }, 20_000);
}

function left(timeleft?: string): string | undefined {
  // Lidarr's "01:02:03" or "1.02:03:04" (days).
  const m = timeleft?.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (!m) return undefined;
  const minutes = Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3]);
  if (minutes < 1) return t('less than a minute');
  if (minutes < 60) return t('{n} min', { n: minutes });
  return t('{n} h', { n: Math.round(minutes / 60) });
}

export function stateOf(mbid: string): GetState {
  const r = requests.find((x) => x.mbid === mbid);
  if (!r) return { state: 'none' };
  if (r.ready) return { state: 'ready' };
  const q = state.queue.find((x) => x.albumId === r.lidarrAlbumId);
  if (q && q.size > 0) return { state: 'downloading', progress: Math.max(0, Math.min(1, 1 - q.sizeleft / q.size)), left: left(q.timeleft) };
  if (q) return { state: 'downloading', progress: 0 };
  // Nothing on its way a while after asking: Lidarr keeps looking, but people should know.
  if (Date.now() - Date.parse(r.at) > 20 * 60_000) return { state: 'notFound' };
  return { state: 'looking' };
}

/** Someone sent files of an album asked for: it's in (as much of it as they had). */
export function albumSent(album: { mbid?: string; artist: string; title: string }) {
  const same = (r: Request) => r.mbid === album.mbid || (r.artist.toLowerCase() === album.artist.toLowerCase() && r.title.toLowerCase() === album.title.toLowerCase());
  const open = requests.filter((r) => !r.ready && same(r));
  for (const r of open) r.ready = new Date().toISOString();
  if (open.length) save();
}

/** How many albums are being looked for or downloaded right now. */
export const onTheWay = () =>
  requests.filter((r) => {
    const s = stateOf(r.mbid).state;
    return s === 'looking' || s === 'downloading';
  }).length;

/** Before showing states: bring Lidarr's side up to date if anything is on its way. */
export async function freshen() {
  if (pending().length) await refresh();
}

async function profiles() {
  const [roots, quality, metadata] = await Promise.all([lidarr.rootFolders(), lidarr.qualityProfiles(), lidarr.metadataProfiles()]);
  if (!roots.length) throw new HttpError(409, t('Lidarr has no music folder yet'));
  const wanted = process.env.LIDARR_QUALITY_PROFILE?.toLowerCase();
  return {
    rootFolderPath: roots[0].path,
    qualityProfileId: (quality.find((q) => q.name.toLowerCase() === wanted) ?? quality[0])?.id,
    metadataProfileId: (metadata.find((m) => /standard/i.test(m.name)) ?? metadata[0])?.id,
  };
}

export async function ensureArtist(artistMbid: string, name: string): Promise<number> {
  const existing = (await lidarr.artists()).find((a) => a.foreignArtistId === artistMbid);
  if (existing) return existing.id;
  const [found] = await lidarr.lookupArtist(artistMbid, name);
  // One from another source its searches don't list: added by its id, Lidarr fills in the rest from that source.
  const artist = found ?? (lidarr.isMbid(artistMbid) ? undefined : { artistName: name, foreignArtistId: artistMbid });
  if (!artist) throw new HttpError(404, t("Lidarr doesn't know this artist"));
  const added = await lidarr.addArtist({
    ...artist,
    ...(await profiles()),
    monitored: true,
    monitorNewItems: 'none',
    addOptions: { monitor: 'none', searchForMissingAlbums: false },
  });
  log.info('get', `Added ${name} to Lidarr (watching nothing yet)`);
  return added.id;
}

export async function findAlbum(artistId: number, mbid: string): Promise<lidarr.LAlbum | undefined> {
  // A newly added artist's albums arrive a few seconds later.
  for (let i = 0; i < 15; i++) {
    const album = (await lidarr.albums(artistId)).find((a) => a.foreignAlbumId === mbid);
    if (album) return album;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

export const get = (session: Session, q: { mbid: string; artistMbid?: string; title: string; artist: string }) => getAs(session.name, q);

/** Whether an album has been asked for already (by anyone, or by Tuna itself). */
export const asked = (mbid: string) => requests.some((r) => r.mbid === mbid);

/** Get, for someone (or, for the weekly picks, Tuna itself). */
export async function getAs(by: string, q: { mbid: string; artistMbid?: string; title: string; artist: string }): Promise<GetState> {
  if (!has.lidarr()) throw new HttpError(409, t('Getting music needs Lidarr: an admin can add it in Settings → Connections'));
  const existing = requests.find((r) => r.mbid === q.mbid);
  if (existing && stateOf(q.mbid).state !== 'notFound') return stateOf(q.mbid);

  let { artistMbid, artist, title } = q;
  if (!artistMbid && !lidarr.isMbid(q.mbid) && (artist || title)) {
    // Known from another source (Deezer, Discogs…): its artist as Lidarr's search has it.
    const found = (await lidarr.findAlbums(`${artist} ${title}`.trim()).catch(() => [])).find((a) => a.foreignAlbumId === q.mbid);
    artistMbid = found?.artist?.foreignArtistId;
    artist ||= found?.artist?.artistName ?? '';
    title ||= found?.title ?? '';
  }
  if (!artistMbid) {
    const group = await mbReleaseGroup(q.mbid);
    artistMbid = group['artist-credit']?.[0]?.artist.id;
    artist ||= group['artist-credit']?.[0]?.name ?? '';
    title ||= group.title;
  }
  if (!artistMbid) throw new HttpError(404, t("Lidarr doesn't know this artist"));

  const artistId = await ensureArtist(artistMbid, artist);
  const album = await findAlbum(artistId, q.mbid);
  if (!album) throw new HttpError(404, t("Lidarr doesn't know this album yet"));
  await lidarr.monitorAlbums([album.id]);
  await lidarr.searchAlbums([album.id]);

  const request: Request = { mbid: q.mbid, artistMbid, title, artist, by, at: new Date().toISOString(), lidarrAlbumId: album.id };
  requests = [...requests.filter((r) => r.mbid !== q.mbid), request];
  save();
  log.info('get', `${by} asked for "${title}" by ${artist}`);
  state.at = 0;
  watch();
  return stateOf(q.mbid);
}

/** When each person opened On its way, this time and the time before (ISO). */
const SEEN = () => path.join(config.dataDir, 'getting-seen.json');
let seen: Record<string, { now: string; before?: string }> = (() => {
  try {
    return JSON.parse(fs.readFileSync(SEEN(), 'utf8')) as Record<string, { now: string; before?: string }>;
  } catch {
    return {};
  }
})();

/** Someone opened On its way: albums that were ready on their visit before this one go from it. */
export function opened(username: string) {
  seen = { ...seen, [username]: { now: new Date().toISOString(), before: seen[username]?.now } };
  writeJson(SEEN(), seen);
}

/**
 * What's been asked for (albums, and `more`: songs), newest first; what arrived shows until the visit
 * after the one it was seen on.
 */
/** Albums on their way, and those that just arrived: for the Get buttons on screen. */
export async function albumsMoving() {
  await freshen();
  const lately = Date.now() - 120_000;
  return requests.filter((r) => !r.ready || Date.parse(r.ready) > lately).map((r) => ({ mbid: r.mbid, get: stateOf(r.mbid) }));
}

export async function list(username?: string, more: Array<GetItem & { ready?: string }> = []): Promise<GetItem[]> {
  await freshen();
  const before = username ? seen[username]?.before : undefined;
  return [...requests.map((r) => ({ mbid: r.mbid, title: r.title, artist: r.artist, cover: coverArtFor(r.mbid), get: stateOf(r.mbid), by: r.by, at: r.at, ready: r.ready })), ...more]
    .filter((x) => !(before && x.ready && x.ready <= before))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 80)
    .map(({ ready: _, ...x }) => x);
}

watch();

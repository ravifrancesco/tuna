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
import { HttpError } from '../lib/upstream';
import { adminAuth, type Session } from '../sessions';
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
async function scanNavidrome() {
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
    } while (scanAgain);
  } catch (err) {
    log.warn('get', "Couldn't ask Navidrome to look for new music", err);
    forgetLibraryIndex();
  } finally {
    scanning = false;
  }
}

async function refresh() {
  if (!has.lidarr() || Date.now() - state.at < 4000) return;
  refreshing ??= (async () => {
    try {
      const [queue, albums] = await Promise.all([
        lidarr.queue(),
        Promise.all(pending().map((r) => lidarr.album(r.lidarrAlbumId!).catch(() => undefined))),
      ]);
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

async function ensureArtist(artistMbid: string, name: string): Promise<number> {
  const existing = (await lidarr.artists()).find((a) => a.foreignArtistId === artistMbid);
  if (existing) return existing.id;
  const [found] = await lidarr.lookupArtist(artistMbid);
  if (!found) throw new HttpError(404, t("Lidarr doesn't know this artist"));
  const added = await lidarr.addArtist({
    ...found,
    ...(await profiles()),
    monitored: true,
    monitorNewItems: 'none',
    addOptions: { monitor: 'none', searchForMissingAlbums: false },
  });
  log.info('get', `Added ${name} to Lidarr (watching nothing yet)`);
  return added.id;
}

async function findAlbum(artistId: number, mbid: string): Promise<lidarr.LAlbum | undefined> {
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

export async function list(): Promise<GetItem[]> {
  await freshen();
  return [...requests]
    .reverse()
    .slice(0, 60)
    .map((r) => ({ mbid: r.mbid, title: r.title, artist: r.artist, cover: coverArtFor(r.mbid), get: stateOf(r.mbid), by: r.by, at: r.at }));
}

watch();

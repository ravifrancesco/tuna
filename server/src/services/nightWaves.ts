import fs from 'node:fs';
import path from 'node:path';
import { subsonic, type AlbumID3 } from '../clients/navidrome';
import { config } from '../config';
import { HttpError } from '../lib/upstream';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { adminAuth } from '../sessions';
import { hasFfmpeg, isMeasured, waveOf } from './waveform';

/**
 * Measuring the whole library's waveforms ahead of time, in the hours an admin chooses (the
 * household's time), one song at a time and at low priority. Each night it carries on where it
 * stopped and picks up what's new, so after the first nights only new music is measured. It uses
 * the sign-in of the admin seen most recently, so it needs an admin to have signed in once.
 */

export interface NightWaves {
  enabled: boolean;
  /** "02:00" */
  from: string;
  /** "06:00"; earlier than `from` means it runs past midnight. */
  until: string;
  /** Songs in the library, and how many are measured, as of the last count. */
  total?: number;
  measured?: number;
  running: boolean;
  /** No admin has signed in yet, so it can't run. */
  needsAdmin: boolean;
  /** ffmpeg is missing. */
  noFfmpeg: boolean;
}

interface Saved {
  enabled?: boolean;
  from?: string;
  until?: string;
  total?: number;
  measured?: number;
}

const FILE = () => path.join(config.dataDir, 'waves.json');
let saved: Saved = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Saved;
  } catch {
    return {};
  }
})();
let running = false;
let noFfmpeg = false;
/** The count as it goes (written to disk every 25 songs). */
let live: number | undefined;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function nightWaves(): NightWaves {
  return {
    enabled: Boolean(saved.enabled),
    from: saved.from ?? '02:00',
    until: saved.until ?? '06:00',
    total: saved.total,
    measured: live ?? saved.measured,
    running,
    needsAdmin: !adminAuth(),
    noFfmpeg,
  };
}

export function saveNightWaves(patch: { enabled?: boolean; from?: string; until?: string }, by: string): NightWaves {
  for (const key of ['from', 'until'] as const) {
    if (patch[key] !== undefined && !TIME.test(patch[key]!)) throw new HttpError(400, t('That time isn’t right'));
  }
  const before = nightWaves();
  saved = { ...saved, ...patch };
  writeJson(FILE(), saved);
  const now = nightWaves();
  if (now.enabled !== before.enabled || now.from !== before.from || now.until !== before.until) {
    log.info('waveforms', now.enabled ? `${by} set waveforms to be measured from ${now.from} to ${now.until}` : `${by} turned off measuring waveforms at night`);
  }
  void tick();
  return now;
}

/** Now, in the household's time, as minutes since midnight. */
function minutesNow(): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: config.timeZone })
    .format(new Date())
    .split(':')
    .map(Number);
  return h * 60 + m;
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inWindow(from: string, until: string, now = minutesNow()): boolean {
  const a = toMinutes(from);
  const b = toMinutes(until);
  return a === b ? false : a < b ? now >= a && now < b : now >= a || now < b;
}

async function songIds(auth: NonNullable<ReturnType<typeof adminAuth>>): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < 50_000; offset += 500) {
    const page = await subsonic<{ albumList2?: { album?: AlbumID3[] } }>(auth, 'getAlbumList2', { type: 'alphabeticalByName', size: 500, offset });
    const albums = page.albumList2?.album ?? [];
    for (const a of albums) {
      const full = await subsonic<{ album: AlbumID3 }>(auth, 'getAlbum', { id: a.id }).catch(() => undefined);
      for (const song of full?.album.song ?? []) ids.push(song.id);
    }
    if (albums.length < 500) break;
  }
  return ids;
}

async function run() {
  const auth = adminAuth();
  if (!auth) return;
  if (!(await hasFfmpeg())) {
    noFfmpeg = true;
    return;
  }
  running = true;
  let done = 0;
  try {
    const ids = await songIds(auth);
    let measured = ids.filter(isMeasured).length;
    saved = { ...saved, total: ids.length, measured };
    writeJson(FILE(), saved);
    for (const id of ids) {
      const s = nightWaves();
      if (!s.enabled || !inWindow(s.from, s.until)) break;
      if (isMeasured(id)) continue;
      await waveOf(auth, id, true);
      measured++;
      live = measured;
      done++;
      if (done % 25 === 0) {
        saved = { ...saved, measured };
        writeJson(FILE(), saved);
      }
    }
    saved = { ...saved, measured };
    writeJson(FILE(), saved);
    if (done) log.info('waveforms', `Measured ${done} songs tonight (${measured} of ${ids.length} now)`);
  } catch (err) {
    log.warn('waveforms', "Couldn't measure waveforms tonight", err);
  } finally {
    running = false;
    live = undefined;
  }
}

async function tick() {
  const s = nightWaves();
  if (running || !s.enabled || !inWindow(s.from, s.until)) return;
  await run();
}

/** Checked every few minutes; it starts when the hours begin and stops when they end. */
export function startNightWaves() {
  setInterval(() => void tick(), 5 * 60_000).unref();
  void tick();
}

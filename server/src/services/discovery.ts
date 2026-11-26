import fs from 'node:fs';
import path from 'node:path';
import type { Track } from '@tuna/shared';
import { subsonic, type Child } from '../clients/navidrome';
import { lastfmSimilarTracks, lbRecommendations } from '../clients/public';
import { config } from '../config';
import { has } from '../connections';
import { settle } from '../lib/async';
import { HOUR } from '../lib/cache';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { adminAuth, authFor, type Session } from '../sessions';
import { scanNavidrome } from './getting';
import { toTrack } from './library';
import { listeners, listeningStats } from './listens';
import { matcher, songIndex } from './matching';
import { seeded, weekOf } from './mixes';
import { everyone } from './prefs';
import { discoveries, known, letGo, wantSongs } from './songs';

/**
 * New songs for each person, every Monday (in their Fresh catch), and a few with a song's radio:
 * songs ListenBrainz suggests for them and songs like the ones they play most, that aren't in the
 * library, got as single songs. The next week they go again, unless someone liked them or put them
 * in a playlist.
 */

interface Saved {
  /** New songs a week for each person (0: none). */
  perWeek: number;
  /** The week each person last got theirs. */
  weeks: Record<string, number>;
}
const FILE = () => path.join(config.dataDir, 'discovery.json');
let saved: Saved = (() => {
  try {
    return { perWeek: 20, weeks: {}, ...(JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Partial<Saved>) };
  } catch {
    return { perWeek: 20, weeks: {} };
  }
})();
const save = () => writeJson(FILE(), saved);

export const discoverySettings = () => ({ perWeek: saved.perWeek, available: has.slskd() && has.lidarr() });
export function saveDiscovery(admin: Session, perWeek: number) {
  saved = { ...saved, perWeek: Math.max(0, Math.min(50, Math.round(perWeek) || 0)) };
  save();
  log.info('settings', saved.perWeek ? `${admin.name} set new songs to ${saved.perWeek} a week for each person` : `${admin.name} turned the weekly new songs off`);
  return discoverySettings();
}

const ready = () => has.slskd() && has.lidarr();

/** Everyone there's something to go on for: who listens in Tuna, or has linked ListenBrainz. */
function household(): Array<{ username: string; listenbrainzUser?: string }> {
  const linked = everyone();
  return [...new Set([...linked.map((p) => p.username), ...listeners()])].map((u) => linked.find((p) => p.username === u) ?? { username: u });
}

/** Songs that aren't in the library and haven't been asked for, at most two by one artist, in a weekly order. */
async function fresh(candidates: Array<{ artist: string; title: string; album?: string }>, seed: string, n: number) {
  const auth = adminAuth();
  if (!auth) return [];
  const here = matcher(await songIndex(auth));
  const r = seeded(seed);
  const per = new Map<string, number>();
  const out: typeof candidates = [];
  for (const c of candidates.map((x) => ({ x, k: r() })).sort((a, b) => a.k - b.k).map((y) => y.x)) {
    const artist = c.artist.toLowerCase();
    if ((per.get(artist) ?? 0) >= 2 || here(c) || known(c) || out.some((o) => o.title.toLowerCase() === c.title.toLowerCase() && o.artist.toLowerCase() === artist)) continue;
    per.set(artist, (per.get(artist) ?? 0) + 1);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

/** What to try for someone: ListenBrainz's suggestions, and songs like the ones they've played most lately. */
async function candidatesFor(p: { username: string; listenbrainzUser?: string }) {
  const recs = p.listenbrainzUser ? await settle(lbRecommendations(p.listenbrainzUser), []) : [];
  const top = listeningStats(p.username, 'month').topSongs.slice(0, 8);
  const alike = await Promise.all(top.map((s) => settle(lastfmSimilarTracks(s.artist, s.title), [])));
  return [...recs.map((r) => ({ artist: r.artist, title: r.title, album: r.release })), ...alike.flat()];
}

// ---- Every Monday --------------------------------------------------------------------------------

/** Songs to keep: liked by anyone, or in anyone's playlist (as far as Tuna can see: people who've signed in). */
async function keptIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const p of household()) {
    const auth = authFor(p.username);
    if (!auth) continue;
    const starred = await settle(subsonic<{ starred2?: { song?: Child[] } }>(auth, 'getStarred2'), {});
    for (const s of starred.starred2?.song ?? []) ids.add(s.id);
    const lists = await settle(subsonic<{ playlists?: { playlist?: Array<{ id: string }> } }>(auth, 'getPlaylists'), {});
    for (const pl of lists.playlists?.playlist ?? []) {
      const full = await settle(subsonic<{ playlist?: { entry?: Child[] } }>(auth, 'getPlaylist', { id: pl.id }), {});
      for (const e of full.playlist?.entry ?? []) ids.add(e.id);
    }
  }
  return ids;
}

/** Last week's discoveries that nobody kept go. */
async function letGoOfOld(week: number) {
  const old = discoveries().filter((s) => (s.week ?? week) < week);
  const auth = adminAuth();
  if (!old.length || !auth) return;
  const here = matcher(await songIndex(auth));
  const kept = await keptIds();
  let gone = 0;
  for (const s of old) {
    const song = here(s);
    if (song && kept.has(song.id)) continue;
    await settle(letGo(s.id), undefined, (err) => log.warn('get', `Couldn't remove "${s.title}"`, err));
    gone++;
  }
  if (gone) {
    log.info('get', `Removed ${gone} song${gone === 1 ? '' : 's'} from last week's Fresh catch that nobody kept`);
    void scanNavidrome();
  }
}

async function weekly() {
  if (!ready() || !adminAuth()) return;
  const week = weekOf();
  if (Object.values(saved.weeks).some((w) => w < week)) await letGoOfOld(week);
  if (!saved.perWeek) return;
  for (const p of household()) {
    if (saved.weeks[p.username] === week) continue;
    const list = await fresh(await candidatesFor(p), `${p.username}:${week}`, saved.perWeek);
    if (list.length) wantSongs('Tuna', list, { for: p.username, week });
    saved = { ...saved, weeks: { ...saved.weeks, [p.username]: week } };
    save();
    log.info('get', `Fresh catch for ${p.username}: ${list.length} new song${list.length === 1 ? '' : 's'}`);
  }
}
setTimeout(() => void weekly().catch((err) => log.warn('get', 'The weekly new songs failed', err)), 3 * 60_000).unref();
setInterval(() => void weekly().catch((err) => log.warn('get', 'The weekly new songs failed', err)), 6 * HOUR).unref();

// ---- With a song's radio -------------------------------------------------------------------------

/** A few songs like the radio's first that aren't here, asked for as it starts; they join it as they arrive. */
export async function radioDiscoveries(username: string, seed: Track) {
  if (!ready()) return;
  const list = await fresh(await settle(lastfmSimilarTracks(seed.artist, seed.title), []), `${username}:${seed.id}`, 3);
  if (list.length) wantSongs('Tuna', list, { for: username, week: weekOf(), radio: seed.id });
}

/** Someone's discoveries that are here now: this week's, or a radio's. */
export async function arrived(username: string, opts: { week?: number; radio?: string }): Promise<Track[]> {
  const auth = authFor(username) ?? adminAuth();
  if (!auth) return [];
  const mine = discoveries().filter((s) => s.for?.includes(username) && (opts.radio ? s.radio === opts.radio : s.week === opts.week));
  if (!mine.length) return [];
  const here = matcher(await songIndex(auth));
  return mine.flatMap((s) => {
    const c = here(s);
    return c ? [toTrack(c)] : [];
  });
}

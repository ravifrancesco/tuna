import fs from 'node:fs';
import path from 'node:path';
import type { Coverage, Stocking, StockingWhy } from '@tuna/shared';
import type { SubsonicAuth } from '../clients/navidrome';
import { coverArtFor, lastfmRecent, lastfmTopAlbums, lastfmTopArtists, lbListens, lbRecommendations, mbArtistAlbums, mbSearchAlbums, mbSearchArtists, mbSearchRecordings, type OutsideListen } from '../clients/public';
import { config } from '../config';
import { has } from '../connections';
import { settle } from '../lib/async';
import { HOUR, TTLCache } from '../lib/cache';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { HttpError } from '../lib/upstream';
import { adminAuth, type Session } from '../sessions';
import { asked, getAs, onTheWay } from './getting';
import { artists as allArtists, findAlbum, libraryIndex, norm } from './library';
import { listeners, listensSince } from './listens';
import * as lidarr from '../clients/lidarr';
import { alike, artistsOf, cleanAlbum, firstArtist, isSoundtrack, matcher, releaseGroups, songIndex } from './matching';
import { everyone } from './prefs';

/**
 * Keeping the library stocked, so what people want to play is probably already here: "Get all"
 * for what a Spotify import found missing, and the weekly picks, a number of albums a week an admin
 * chooses, asked for through Get like anyone would: albums people played elsewhere (ListenBrainz,
 * Last.fm) that aren't here, new releases by the artists they play most, ListenBrainz suggestions
 * that keep coming up, and more by artists they play a lot but have little of. Nothing is deleted.
 */

const DAY = 24 * HOUR;

interface Pick {
  mbid: string;
  title: string;
  artist: string;
  why: StockingWhy;
  at: number;
}
/** An album asked for by its names that couldn't be found (newest first). */
interface Missed {
  artist: string;
  album: string;
  by: string;
  at: number;
  /** One of its songs' codes, where Spotify's files had it. */
  isrc?: string;
}
interface Saved {
  perWeek: number;
  picks: Pick[];
  missed?: Missed[];
  /** Albums still to ask for, kept across restarts. */
  queue?: Wanted[];
}

const FILE = () => path.join(config.dataDir, 'stocking.json');
let saved: Saved = (() => {
  try {
    return { perWeek: 0, picks: [], ...(JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Partial<Saved>) };
  } catch {
    return { perWeek: 0, picks: [] };
  }
})();
const save = () => writeJson(FILE(), saved);

// ---- Asking for albums, one at a time ------------------------------------------------------------

interface Wanted {
  by: string;
  artist: string;
  title: string;
  mbid?: string;
  artistMbid?: string;
  /** One of its songs' codes, where Spotify's files had it. */
  isrc?: string;
  why?: StockingWhy;
  /** Times Lidarr or MusicBrainz didn't answer when it was looked up. */
  tries?: number;
}

const queue: Wanted[] = [...(saved.queue ?? [])];
let working = false;
const keepQueue = () => {
  saved = { ...saved, queue: [...queue] };
  save();
};
/** Albums on their way at once: the next is asked for as one arrives (or isn't found). */
const AT_ONCE = 5;

const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;

type Resolved = { mbid: string; artistMbid?: string; title: string; artist: string };

/**
 * An album known by its names (as Spotify writes them), and maybe one of its songs' codes: by the
 * code first (exactly that album, whatever either side calls it), then Lidarr's own search (what Get
 * can fetch), then MusicBrainz's, then the artist's own albums. "Currents (Deluxe Edition)" is looked
 * for as "Currents", "Gorillaz;Black Thought" (Spotify's way of listing artists) by its first, and
 * names may differ a little ("De I Cani", "dei cani"). Throws when nothing answered, so it's looked up
 * again later rather than called missing.
 */
export async function resolve(artist: string, title: string, isrc?: string): Promise<Resolved | undefined> {
  const name = cleanAlbum(title);
  const first = firstArtist(artist);
  const credited = (n: string | undefined) => Boolean(n) && artistsOf(artist).some((a) => artistsOf(n!).some((b) => b === a || alike(a, b)));
  const same = (t: string) => norm(t) === norm(name) || norm(cleanAlbum(t)) === norm(name) || alike(cleanAlbum(t), name);
  let failed: unknown;
  const ask = <T>(p: Promise<T[]>) => p.catch((err: unknown) => ((failed = err), [] as T[]));
  if (isrc) {
    const on = releaseGroups(await ask(mbSearchRecordings(`isrc:${isrc}`)));
    // The one named, if the song is on it; else the album it came out on.
    const g = on.find((x) => same(x.title)) ?? on[0];
    if (g) return { mbid: g.mbid, artistMbid: g.artistMbid, title: g.title, artist: g.artist };
  }
  // Lidarr may know it from other sources too (Deezer, Discogs, with Tubifarry): MusicBrainz's first, another's if that's all there is.
  let other: Resolved | undefined;
  if (has.lidarr()) {
    const found = (await ask(lidarr.findAlbums(`${first} ${name}`))).filter((a) => credited(a.artist?.artistName) && same(a.title));
    const hit = found.find((a) => lidarr.isMbid(a.foreignAlbumId)) ?? found[0];
    const it = hit && { mbid: hit.foreignAlbumId, artistMbid: hit.artist?.foreignArtistId, title: hit.title, artist: hit.artist?.artistName ?? first };
    if (it && lidarr.isMbid(it.mbid)) return it;
    other = it;
  }
  const groups = await ask(mbSearchAlbums(`releasegroup:${quote(name)} AND artist:${quote(first)}`));
  const byArtist = (g: (typeof groups)[number]) => (g['artist-credit'] ?? []).some((c) => credited(c.name) || credited(c.artist.name));
  let g = groups.find((x) => same(x.title) && byArtist(x)) ?? groups.find((x) => (x.score ?? 0) >= 95 && byArtist(x));
  // A soundtrack is its composer's, whoever plays the song (Whiplash's is Justin Hurwitz's, not John Wasson's).
  if (!g && isSoundtrack(title)) g = (await ask(mbSearchAlbums(`releasegroup:${quote(name)} AND secondarytype:soundtrack`))).find((x) => same(x.title));
  if (g) return { mbid: g.id, artistMbid: g['artist-credit']?.[0]?.artist.id, title: g.title, artist: g['artist-credit']?.[0]?.name ?? first };
  // Named a little differently from MusicBrainz: among the artist's own albums.
  const people = await ask(mbSearchArtists(`artist:${quote(first)} OR alias:${quote(first)}`));
  const who = people.find((a) => credited(a.name)) ?? people.find((a) => (a.score ?? 0) >= 95);
  const own = who && (await ask(mbArtistAlbums(who.id))).find((x) => same(x.title));
  if (who && own) return { mbid: own.id, artistMbid: who.id, title: own.title, artist: who.name };
  if (other) return other;
  if (failed) throw failed;
  return undefined;
}

function missed(w: Wanted, found: boolean) {
  const others = (saved.missed ?? []).filter((m) => !(norm(m.artist) === norm(w.artist) && norm(m.album) === norm(w.title)));
  saved = { ...saved, missed: found ? others : [{ artist: w.artist, album: w.title, by: w.by, at: Date.now(), isrc: w.isrc }, ...others].slice(0, 300) };
  save();
  if (!found) log.info('get', `Couldn't find "${w.title}" by ${w.artist}`);
}

/** What couldn't be found when asked for by name (Get all, a playlist's missing songs). */
export const missedAlbums = () => saved.missed ?? [];

/** Someone sent files of an album that couldn't be found: it's in. */
export const missedSent = (artist: string, album: string) => missed({ artist, title: album } as Wanted, true);

function enqueue(items: Wanted[]) {
  queue.push(...items);
  keepQueue();
  if (!working) void work();
}

async function work() {
  working = true;
  while (queue.length) {
    while (queue.length && onTheWay() >= AT_ONCE) await new Promise((r) => setTimeout(r, 20_000));
    const w = queue.shift();
    if (!w) break;
    keepQueue();
    try {
      let { mbid, artistMbid, title, artist } = w;
      if (!mbid) {
        const g = await resolve(artist, title, w.isrc);
        if (!g) {
          missed(w, false);
          continue;
        }
        ({ mbid, artistMbid, title, artist } = g);
      }
      if (!w.why) missed(w, true);
      if (asked(mbid)) continue;
      const auth = adminAuth();
      if (auth && findAlbum(await libraryIndex(auth), mbid, artist, title)) continue;
      await getAs(w.by, { mbid, artistMbid, title, artist });
      // A few seconds between albums, so Lidarr and the indexers aren't flooded.
      await new Promise((r) => setTimeout(r, 3000));
      if (w.why) {
        saved = { ...saved, picks: [...saved.picks, { mbid, title, artist, why: w.why, at: Date.now() }].slice(-500) };
        save();
      }
    } catch (err) {
      log.debug('stocking', `"${w.title}" by ${w.artist}: ${String(err)}`);
      // Lidarr or MusicBrainz busy: looked up again at the end, a couple of times, before it's missing.
      const tries = (w.tries ?? 0) + 1;
      if (tries < 3) (queue.push({ ...w, tries }), keepQueue());
      else if (!w.why && !w.mbid) missed(w, false);
    }
  }
  working = false;
}

/** "Get all" and a playlist's missing songs: albums by their names, in the order given (most wanted first). */
export function getMany(session: Session, albums: Array<{ artist: string; album: string; isrc?: string }>): number {
  if (!has.lidarr()) throw new HttpError(409, t('Getting music needs Lidarr: an admin can add it in Settings → Connections'));
  const waiting = new Set(queue.map((w) => `${norm(w.artist)}|${norm(cleanAlbum(w.title))}`));
  const list = albums.filter((a) => a.artist && a.album && !waiting.has(`${norm(a.artist)}|${norm(cleanAlbum(a.album))}`)).slice(0, 2000);
  enqueue(list.map((a) => ({ by: session.name, artist: a.artist, title: a.album, isrc: a.isrc || undefined })));
  log.info('get', `${session.name} asked for ${list.length} album${list.length === 1 ? '' : 's'}, to get ${AT_ONCE} at a time`);
  return list.length;
}

/** Albums still to ask for: all of them, and how many of those someone asked for. */
export const stillToAsk = (session: Session) => ({ count: queue.length, mine: queue.filter((w) => w.by === session.name).length });

/** Stops asking for what's left: someone's own albums, or (an admin) everyone's. */
export function stopAsking(session: Session): number {
  const before = queue.length;
  const keep = queue.filter((w) => !(session.admin || w.by === session.name));
  queue.splice(0, queue.length, ...keep);
  keepQueue();
  const stopped = before - queue.length;
  if (stopped) log.info('get', `${session.name} stopped asking for ${stopped} album${stopped === 1 ? '' : 's'}`);
  return stopped;
}

// Carries on where it was before a restart.
if (queue.length) setTimeout(() => void work(), 30_000);

// ---- What the household plays, and how much of it is here -----------------------------------------

/** Plays from elsewhere, each once, even if someone sends them to both ListenBrainz and Last.fm. */
async function playedElsewhere(since: number): Promise<OutsideListen[]> {
  const all: OutsideListen[] = [];
  for (const p of everyone()) {
    const mine = [...(p.listenbrainzUser ? await settle(lbListens(p.listenbrainzUser, since), []) : []), ...(p.lastfmUser ? await settle(lastfmRecent(p.lastfmUser, since), []) : [])];
    const seen = new Set<string>();
    for (const l of mine) {
      const key = `${Math.round(l.at / 120_000)}|${norm(l.title)}`;
      if (!seen.has(key)) seen.add(key), all.push(l);
    }
  }
  return all;
}

interface Measured extends Coverage {
  /** Every missing album, most played first (for the picks). */
  wanted: Array<{ artist: string; album: string; plays: number }>;
}
const measured = new TTLCache<Measured>(1);

/** Of everything the household played in the last 30 days, here or elsewhere, how much is here. */
function measure(auth: SubsonicAuth): Promise<Measured> {
  // Measured again when someone links (or unlinks) where else they listen.
  const linked = everyone()
    .map((p) => `${p.listenbrainzUser ?? ''}/${p.lastfmUser ?? ''}`)
    .join(',');
  return measured.wrap(linked, 6 * HOUR, async () => {
    const since = Date.now() - 30 * DAY;
    const here = listeners().reduce((n, u) => n + listensSince(u, since).length, 0);
    const outside = await playedElsewhere(since);
    const find = matcher(await songIndex(auth));
    let found = 0;
    const missing = new Map<string, { artist: string; album: string; plays: number }>();
    for (const l of outside) {
      if (find(l)) found++;
      else if (l.album) {
        const k = `${norm(l.artist)}|${norm(l.album)}`;
        const m = missing.get(k) ?? { artist: l.artist, album: l.album, plays: 0 };
        m.plays++;
        missing.set(k, m);
      }
    }
    const plays = here + outside.length;
    const wanted = [...missing.values()].sort((a, b) => b.plays - a.plays);
    return { plays, percent: plays ? Math.round((100 * (here + found)) / plays) : 100, elsewhere: outside.length, missing: wanted.slice(0, 5), wanted };
  });
}

// ---- The weekly picks --------------------------------------------------------------------------------

interface Candidate {
  artist: string;
  title: string;
  mbid?: string;
  artistMbid?: string;
  why: StockingWhy;
}

/** The artists the household plays most, here and on Last.fm, with how many of their albums are here. */
async function topArtists(auth: SubsonicAuth) {
  const library = new Map((await allArtists(auth)).map((a) => [norm(a.name), a]));
  const score = new Map<string, { name: string; mbid?: string; plays: number }>();
  const add = (name: string, plays: number, mbid?: string) => {
    const k = norm(name);
    const cur = score.get(k) ?? { name, mbid: library.get(k)?.mbid ?? mbid, plays: 0 };
    cur.plays += plays;
    score.set(k, cur);
  };
  for (const u of listeners()) for (const l of listensSince(u, Date.now() - 90 * DAY)) add(l.artist, 1);
  for (const p of everyone()) {
    if (!p.lastfmUser) continue;
    (await settle(lastfmTopArtists(p.lastfmUser), [])).forEach((a, i) => add(a.name, 30 - i, a.mbid));
  }
  return [...score.values()].map((a) => ({ ...a, albumsHere: library.get(norm(a.name))?.albumCount ?? 0 })).sort((a, b) => b.plays - a.plays);
}

async function candidates(auth: SubsonicAuth): Promise<Candidate[][]> {
  const idx = await libraryIndex(auth);
  const here = (c: { mbid?: string; artist: string; title: string }) => Boolean(findAlbum(idx, c.mbid, c.artist, c.title));
  const top = (await topArtists(auth)).slice(0, 15);

  // Played elsewhere, not here.
  const elsewhere: Candidate[] = (await measure(auth)).wanted.slice(0, 40).map((m) => ({ artist: m.artist, title: m.album, why: 'elsewhere' }));

  // New releases (the last four months) by the artists played most.
  const fresh: Candidate[] = [];
  for (const a of top.filter((x) => x.mbid).slice(0, 10)) {
    for (const g of await settle(mbArtistAlbums(a.mbid!), [])) {
      const date = Date.parse(g['first-release-date'] ?? '');
      if (date > Date.now() - 120 * DAY && /album|ep/i.test(g['primary-type'] ?? '')) fresh.push({ mbid: g.id, artistMbid: a.mbid, artist: a.name, title: g.title, why: 'new' });
    }
  }

  // ListenBrainz suggestions, the ones that come up for most people (and most often) first.
  const counts = new Map<string, Candidate & { n: number }>();
  for (const p of everyone()) {
    if (!p.listenbrainzUser) continue;
    for (const r of await settle(lbRecommendations(p.listenbrainzUser), [])) {
      if (!r.releaseGroupMbid || !r.release) continue;
      const c = counts.get(r.releaseGroupMbid) ?? { mbid: r.releaseGroupMbid, artistMbid: r.artistMbid, artist: r.artist, title: r.release, why: 'listenbrainz' as const, n: 0 };
      c.n++;
      counts.set(r.releaseGroupMbid, c);
    }
  }
  const suggested = [...counts.values()].sort((a, b) => b.n - a.n);

  // More by artists played a lot but with few albums here: their best-known album that isn't.
  const more: Candidate[] = [];
  for (const a of [...top].sort((x, y) => y.plays / (y.albumsHere + 1) - x.plays / (x.albumsHere + 1)).slice(0, 8)) {
    const named = await settle(lastfmTopAlbums(a.name, a.mbid), []);
    const title = named.find((t) => !here({ artist: a.name, title: t }));
    if (title) more.push({ artist: a.name, title, why: 'more' });
    else if (a.mbid) {
      const g = (await settle(mbArtistAlbums(a.mbid), [])).filter((x) => x['primary-type'] === 'Album').find((x) => !here({ mbid: x.id, artist: a.name, title: x.title }));
      if (g) more.push({ mbid: g.id, artistMbid: a.mbid, artist: a.name, title: g.title, why: 'more' });
    }
  }
  return [elsewhere, fresh, suggested, more].map((list) => list.filter((c) => !(c.mbid && (asked(c.mbid) || here(c)))));
}

async function pickWeekly() {
  if (!saved.perWeek || !has.lidarr() || working) return;
  const auth = adminAuth();
  if (!auth) return;
  const now = Date.now();
  // Spread over the week: about a seventh a day, never more than the week's number.
  const week = saved.picks.filter((p) => p.at > now - 7 * DAY).length;
  const today = saved.picks.filter((p) => p.at > now - DAY).length;
  const n = Math.min(saved.perWeek - week, Math.ceil(saved.perWeek / 7) - today);
  if (n <= 0) return;
  const lists = await candidates(auth);
  const picked = new Set(saved.picks.map((p) => `${norm(p.artist)}|${norm(p.title)}`));
  const chosen: Candidate[] = [];
  // A bit of each kind, in turn.
  for (let i = 0; chosen.length < n * 2 && lists.some((l) => l.length > i); i++) {
    for (const l of lists) {
      const c = l[i];
      if (c && !picked.has(`${norm(c.artist)}|${norm(c.title)}`)) chosen.push(c), picked.add(`${norm(c.artist)}|${norm(c.title)}`);
    }
  }
  // A few extra in line, for the ones Lidarr can't find.
  enqueue(chosen.slice(0, n + 2).map((c) => ({ ...c, by: 'Tuna' })));
}

setTimeout(() => void pickWeekly().catch((err) => log.warn('stocking', 'Choosing the weekly picks failed', err)), 2 * 60_000).unref();
setInterval(() => void pickWeekly().catch((err) => log.warn('stocking', 'Choosing the weekly picks failed', err)), 6 * HOUR).unref();

// ---- Settings ----------------------------------------------------------------------------------------

export async function stocking(): Promise<Stocking> {
  const auth = adminAuth();
  const now = Date.now();
  return {
    perWeek: saved.perWeek,
    thisWeek: saved.picks.filter((p) => p.at > now - 7 * DAY).length,
    picks: saved.picks
      .slice(-6)
      .reverse()
      .map((p) => ({ title: p.title, artist: p.artist, why: p.why, at: new Date(p.at).toISOString(), cover: coverArtFor(p.mbid) })),
    coverage: auth ? await settle(measure(auth).then(({ wanted: _, ...c }) => c), undefined) : undefined,
    needsLidarr: !has.lidarr(),
  };
}

export async function saveStocking(admin: Session, perWeek: number): Promise<Stocking> {
  saved = { ...saved, perWeek: Math.max(0, Math.min(100, Math.round(perWeek) || 0)) };
  save();
  log.info('settings', saved.perWeek ? `${admin.name} set the weekly picks to ${saved.perWeek} albums a week` : `${admin.name} turned the weekly picks off`);
  setTimeout(() => void pickWeekly().catch((err) => log.warn('stocking', 'Choosing the weekly picks failed', err)), 5_000);
  return stocking();
}

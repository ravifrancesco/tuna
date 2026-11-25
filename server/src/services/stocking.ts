import fs from 'node:fs';
import path from 'node:path';
import type { Coverage, Stocking, StockingWhy } from '@tuna/shared';
import type { SubsonicAuth } from '../clients/navidrome';
import { coverArtFor, lastfmRecent, lastfmTopAlbums, lastfmTopArtists, lbListens, lbRecommendations, mbArtistAlbums, mbSearchAlbums, type OutsideListen } from '../clients/public';
import { config } from '../config';
import { has } from '../connections';
import { settle } from '../lib/async';
import { HOUR, TTLCache } from '../lib/cache';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { HttpError } from '../lib/upstream';
import { adminAuth, type Session } from '../sessions';
import { asked, getAs } from './getting';
import { artists as allArtists, findAlbum, libraryIndex, norm } from './library';
import { listeners, listensSince } from './listens';
import { matcher, songIndex } from './matching';
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
interface Saved {
  perWeek: number;
  picks: Pick[];
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
  why?: StockingWhy;
}

const queue: Wanted[] = [];
let working = false;

const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;

/** An album known only by its names, found on MusicBrainz. */
async function resolve(artist: string, title: string) {
  const groups = await settle(mbSearchAlbums(`releasegroup:${quote(title)} AND artist:${quote(artist)}`), []);
  const byArtist = (g: (typeof groups)[number]) => (g['artist-credit'] ?? []).some((c) => norm(c.name) === norm(artist) || norm(c.artist.name) === norm(artist));
  return groups.find((g) => norm(g.title) === norm(title) && byArtist(g)) ?? groups.find((g) => (g.score ?? 0) >= 95 && byArtist(g));
}

function enqueue(items: Wanted[]) {
  queue.push(...items);
  if (!working) void work();
}

async function work() {
  working = true;
  while (queue.length) {
    const w = queue.shift()!;
    try {
      let { mbid, artistMbid, title, artist } = w;
      if (!mbid) {
        const g = await resolve(artist, title);
        if (!g) continue;
        mbid = g.id;
        artistMbid = g['artist-credit']?.[0]?.artist.id;
        title = g.title;
        artist = g['artist-credit']?.[0]?.name ?? artist;
      }
      if (asked(mbid)) continue;
      const auth = adminAuth();
      if (auth && findAlbum(await libraryIndex(auth), mbid, artist, title)) continue;
      await getAs(w.by, { mbid, artistMbid, title, artist });
      if (w.why) {
        saved = { ...saved, picks: [...saved.picks, { mbid, title, artist, why: w.why, at: Date.now() }].slice(-500) };
        save();
      }
    } catch (err) {
      log.debug('stocking', `"${w.title}" by ${w.artist}: ${String(err)}`);
    }
  }
  working = false;
}

/** "Get all": the albums a Spotify import found missing, most played first. */
export function getMany(session: Session, albums: Array<{ artist: string; album: string }>): number {
  if (!has.lidarr()) throw new HttpError(409, t('Getting music needs Lidarr: an admin can add it in Settings → Connections'));
  const list = albums.filter((a) => a.artist && a.album).slice(0, 100);
  enqueue(list.map((a) => ({ by: session.name, artist: a.artist, title: a.album })));
  log.info('get', `${session.name} asked for ${list.length} albums at once`);
  return list.length;
}

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

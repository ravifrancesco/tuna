import type { Home, Row, WorldAlbum } from '@tuna/shared';
import type { SubsonicAuth } from '../clients/navidrome';
import { coverArtFor, lbRecommendations } from '../clients/public';
import { config } from '../config';
import { settle } from '../lib/async';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { stateOf } from './getting';
import { albums, artists as allArtists, findAlbum, libraryIndex, liked, playlists } from './library';
import { blends, dailyMixes, freshCatch } from './mixes';

/** Home: where you left off, your mixes, what's new, and what to discover (the web shows the first mix big). */

/** "Good evening, Sam": the first name is enough. */
function greeting(name: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: config.timeZone }).format(new Date()));
  const first = name.trim().split(/\s+/)[0];
  if (hour >= 5 && hour < 12) return first ? t('Good morning, {name}', { name: first }) : t('Good morning');
  if (hour >= 12 && hour < 18) return first ? t('Good afternoon, {name}', { name: first }) : t('Good afternoon');
  return first ? t('Good evening, {name}', { name: first }) : t('Good evening');
}

const quiet = (what: string) => (err: unknown) => log.debug('home', `${what}: ${String(err)}`);

export async function home(auth: SubsonicAuth, name: string, listenbrainzUser?: string): Promise<Home> {
  const [recent, newest, frequent, random, mine, mixes, likes] = await Promise.all([
    settle(albums(auth, 'recent', 16), [], quiet('recent')),
    settle(albums(auth, 'newest', 20), [], quiet('newest')),
    settle(albums(auth, 'frequent', 20), [], quiet('frequent')),
    settle(albums(auth, 'random', 16), [], quiet('random')),
    settle(playlists(auth), [], quiet('playlists')),
    settle(dailyMixes(auth), [], quiet('mixes')),
    settle(liked(auth), { tracks: [], albums: [], artists: [], starred: {} }, quiet('liked')),
  ]);

  const rows: Row[] = [];
  if (recent.length) rows.push({ id: 'recent', title: t('Recently played'), kind: 'albums', items: recent });
  const madeForYou = [...mixes];
  const fresh = await settle(freshCatch(auth, listenbrainzUser), [], quiet('fresh catch'));
  if (fresh.length >= 8) {
    const covers = [...new Set(fresh.map((x) => x.cover).filter((c): c is string => Boolean(c)))].slice(0, 4);
    madeForYou.splice(1, 0, { id: 'fresh', title: t('Fresh catch'), subtitle: t('New to you, every Monday'), covers });
  }
  if (likes.tracks.length >= 10) madeForYou.push({ id: 'liked', title: t('Liked songs mix'), subtitle: t('The songs you love, shuffled'), covers: likes.tracks.slice(0, 4).map((x) => x.cover).filter((c): c is string => Boolean(c)) });
  if (madeForYou.length) rows.push({ id: 'mixes', title: t('Made for you'), kind: 'mixes', items: madeForYou });
  const together = blends(auth.username, name);
  if (together.length) rows.push({ id: 'blends', title: t('Blends'), kind: 'mixes', items: together });
  if (newest.length) rows.push({ id: 'newest', title: t('New in the library'), kind: 'albums', items: newest });

  if (listenbrainzUser) {
    const discover = await settle(discoverAlbums(auth, listenbrainzUser), [], quiet('discover'));
    if (discover.length) rows.push({ id: 'discover', title: t('Discover'), kind: 'world', items: discover });
  }
  if (frequent.length) rows.push({ id: 'frequent', title: t('On repeat'), kind: 'albums', items: frequent });
  if (mine.length) rows.push({ id: 'playlists', title: t('Your playlists'), kind: 'playlists', items: mine });

  const top = new Map<string, { id: string; name: string; cover?: string }>();
  for (const a of frequent) if (a.artistId && !top.has(a.artistId)) top.set(a.artistId, { id: a.artistId, name: a.artist, cover: `ar-${a.artistId}` });
  if (top.size < 4) {
    const everyone = await settle(allArtists(auth), [], quiet('artists'));
    for (const a of everyone.sort(() => Math.random() - 0.5).slice(0, 12)) if (!top.has(a.id)) top.set(a.id, a);
  }
  if (top.size) rows.push({ id: 'artists', title: t('Your artists'), kind: 'artists', items: [...top.values()].slice(0, 16) });
  if (random.length) rows.push({ id: 'random', title: t('Something different'), kind: 'albums', items: random });

  return { greeting: greeting(name), rows };
}

/** Albums ListenBrainz suggests that aren't here yet, with Get. */
async function discoverAlbums(auth: SubsonicAuth, user: string): Promise<WorldAlbum[]> {
  const recs = await lbRecommendations(user);
  const idx = await libraryIndex(auth);
  const seen = new Set<string>();
  const out: WorldAlbum[] = [];
  for (const r of recs) {
    if (!r.releaseGroupMbid || seen.has(r.releaseGroupMbid)) continue;
    seen.add(r.releaseGroupMbid);
    const albumId = findAlbum(idx, r.releaseGroupMbid, r.artist, r.release ?? '');
    if (albumId) continue;
    out.push({
      mbid: r.releaseGroupMbid,
      title: r.release ?? r.title,
      artist: r.artist,
      artistMbid: r.artistMbid,
      cover: coverArtFor(r.releaseGroupMbid),
      get: stateOf(r.releaseGroupMbid),
    });
    if (out.length >= 16) break;
  }
  return out;
}

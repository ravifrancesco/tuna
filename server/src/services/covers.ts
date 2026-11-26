import { subsonic, subsonicUrl, type AlbumID3 } from '../clients/navidrome';
import { cacheFull, cachedImage, isCached } from '../lib/imageCache';
import { log } from '../lib/log';
import { adminAuth } from '../sessions';

/**
 * Covers made ready ahead: every album's cover at the sizes the interface shows most (cards and
 * lists), kept in the image cache, so a page full of covers comes from Tuna's disk instead of waiting
 * for Navidrome to resize each picture (slow on a Raspberry Pi). A while after Tuna starts and then
 * every few hours for new albums, one picture at a time, and never more than half of the cache.
 * It uses the sign-in of the admin seen most recently.
 */

/** The sizes `cover` (services/playback.ts) serves for cards (600) and lists (150). */
const SIZES = [600, 150];
const EVERY = 6 * 60 * 60_000;
/** Between pictures, so Navidrome keeps up with everything else. */
const PAUSE = 300;

let running = false;

async function warm() {
  const auth = adminAuth();
  if (running || !auth) return;
  running = true;
  let made = 0;
  try {
    for (let offset = 0; offset < 20000; offset += 500) {
      const page = await subsonic<{ albumList2?: { album?: AlbumID3[] } }>(auth, 'getAlbumList2', { type: 'newest', size: 500, offset });
      const list = page.albumList2?.album ?? [];
      for (const a of list) {
        for (const size of SIZES) {
          const key = `nd:${a.coverArt}:${size}`;
          if (!a.coverArt || isCached(key)) continue;
          if (made % 50 === 0 && cacheFull() > 0.5) return;
          await cachedImage(key, subsonicUrl(auth, 'getCoverArt', { id: a.coverArt, size }));
          made++;
          await new Promise((r) => setTimeout(r, PAUSE));
        }
      }
      if (list.length < 500) break;
    }
  } catch (err) {
    log.debug('covers', `Couldn't make covers ready: ${String(err)}`);
  } finally {
    running = false;
    if (made) log.info('covers', `${made} cover${made === 1 ? '' : 's'} made ready ahead`);
  }
}

export function startCovers() {
  setTimeout(() => void warm(), 60_000).unref();
  setInterval(() => void warm(), EVERY).unref();
}

import fs from 'node:fs';
import path from 'node:path';
import type { Lyrics } from '@tuna/shared';
import { subsonic, type SubsonicAuth } from '../clients/navidrome';
import { lrclib } from '../clients/public';
import { config } from '../config';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { song } from './library';

/**
 * Lyrics: the music file's own (or a .lrc next to it, through Navidrome), otherwise LRCLIB's.
 * LRCLIB's answer is kept on disk, an empty one for a week, so each song is looked up once.
 */

const DIR = () => path.join(config.dataDir, 'cache', 'lyrics');
const WEEK = 7 * 24 * 3600 * 1000;

export function parseLrc(text: string): Lyrics['lines'] {
  const lines: Lyrics['lines'] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length) continue;
    for (const s of stamps) lines.push({ time: Number(s[1]) * 60 + Number(s[2]), text: words });
  }
  return lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

const plain = (text: string): Lyrics['lines'] => text.split(/\r?\n/).map((l) => ({ text: l.trim() }));

interface StructuredLyrics {
  synced: boolean;
  line?: Array<{ start?: number; value: string }>;
}

export async function lyrics(auth: SubsonicAuth, songId: string): Promise<Lyrics | null> {
  const fromLibrary = await subsonic<{ lyricsList?: { structuredLyrics?: StructuredLyrics[] } }>(auth, 'getLyricsBySongId', { id: songId }).catch(() => undefined);
  const list = fromLibrary?.lyricsList?.structuredLyrics ?? [];
  const best = list.find((l) => l.synced) ?? list[0];
  if (best?.line?.length) {
    return {
      synced: best.synced,
      lines: best.line.map((l) => ({ time: best.synced && l.start !== undefined ? l.start / 1000 : undefined, text: l.value })),
      source: 'library',
    };
  }
  if (!config.lyricsOnline) return null;

  const file = path.join(DIR(), `${songId.replace(/[^\w-]/g, '_')}.json`);
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number; lyrics: Lyrics | null };
    if (kept.lyrics || Date.now() - kept.at < WEEK) return kept.lyrics;
  } catch {
    /* not looked up yet */
  }

  const track = await song(auth, songId);
  let found: Lyrics | null = null;
  try {
    const r = await lrclib({ artist: track.artist, track: track.title, album: track.album, duration: track.duration });
    if (r?.syncedLyrics) found = { synced: true, lines: parseLrc(r.syncedLyrics), source: 'lrclib' };
    else if (r?.plainLyrics) found = { synced: false, lines: plain(r.plainLyrics), source: 'lrclib' };
  } catch (err) {
    log.debug('lyrics', `LRCLIB: ${String(err)}`);
    return null;
  }
  try {
    writeJson(file, { at: Date.now(), lyrics: found });
  } catch {
    /* a cache only */
  }
  return found;
}

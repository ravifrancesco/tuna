import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/**
 * When songs went into playlists through Tuna, which Navidrome doesn't keep: playlist id → song id →
 * ISO time. Songs from Spotify keep Spotify's date instead (services/imported.ts).
 */

const FILE = () => path.join(config.dataDir, 'added.json');
let dates: Record<string, Record<string, string>> | undefined;

function all() {
  if (!dates) {
    try {
      dates = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Record<string, Record<string, string>>;
    } catch {
      dates = {};
    }
  }
  return dates;
}

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all()), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

export function noteAdded(playlistId: string, songIds: string[]) {
  if (!songIds.length) return;
  const now = new Date().toISOString();
  const playlist = (all()[playlistId] ??= {});
  for (const id of songIds) playlist[id] = now;
  save();
}

export const addedDates = (playlistId: string): Record<string, string> => all()[playlistId] ?? {};

export function forgetAdded(playlistId: string) {
  if (!all()[playlistId]) return;
  delete all()[playlistId];
  save();
}

import fs from 'node:fs';
import path from 'node:path';
import type { Prefs, Quality } from '@tuna/shared';
import { lastfmUser, lbValidate } from '../clients/public';
import { lastfmKey } from '../connections';
import { config } from '../config';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';
import { HttpError } from '../lib/upstream';

/** Each person's own settings, kept by Tuna (Navidrome has nowhere for them). */

const QUALITIES: Quality[] = ['auto', 'low', 'normal', 'high', 'original'];

interface Stored {
  quality?: Quality;
  /** Before Quality: off, mobile or always. */
  dataSaver?: 'off' | 'mobile' | 'always';
  listenbrainzUser?: string;
  listenbrainzToken?: string;
  lastfmUser?: string;
}

const FILE = () => path.join(config.dataDir, 'people.json');
let people: Record<string, Stored> = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Record<string, Stored>;
  } catch {
    return {};
  }
})();

export function prefsOf(username: string): Prefs {
  const p = people[username] ?? {};
  const quality = p.quality ?? (p.dataSaver === 'off' ? 'original' : p.dataSaver === 'always' ? 'low' : 'auto');
  return { quality, listenbrainzUser: p.listenbrainzUser, listenbrainzToken: Boolean(p.listenbrainzToken), lastfmUser: p.lastfmUser };
}

export const listenbrainzOf = (username: string) => {
  const p = people[username];
  return { user: p?.listenbrainzUser, token: p?.listenbrainzToken };
};

/** Everyone who has settings, with where else they listen (for the weekly picks). */
export const everyone = () => Object.entries(people).map(([username, p]) => ({ username, listenbrainzUser: p.listenbrainzUser, lastfmUser: p.lastfmUser }));

export async function savePrefs(username: string, patch: { quality?: Quality; listenbrainzToken?: string; lastfmUser?: string }): Promise<Prefs> {
  const p = { ...(people[username] ?? {}) };
  if (patch.quality && QUALITIES.includes(patch.quality)) {
    p.quality = patch.quality;
    delete p.dataSaver;
  }
  if (patch.listenbrainzToken !== undefined) {
    const token = patch.listenbrainzToken.trim();
    if (!token) {
      delete p.listenbrainzToken;
      delete p.listenbrainzUser;
    } else {
      const user = await lbValidate(token).catch(() => undefined);
      if (!user) throw new HttpError(400, t("ListenBrainz didn't accept that token"));
      p.listenbrainzToken = token;
      p.listenbrainzUser = user;
      log.info('settings', `${username} linked ListenBrainz (${user})`);
    }
  }
  if (patch.lastfmUser !== undefined) {
    const name = patch.lastfmUser.trim();
    if (!name) delete p.lastfmUser;
    else {
      if (!lastfmKey()) throw new HttpError(409, t('Last.fm needs a key: an admin can add it in Settings → Connections'));
      const found = await lastfmUser(name);
      if (!found) throw new HttpError(400, t("Last.fm doesn't know that name"));
      p.lastfmUser = found;
      log.info('settings', `${username} linked Last.fm (${found})`);
    }
  }
  people = { ...people, [username]: p };
  writeJson(FILE(), people, 0o600);
  return prefsOf(username);
}

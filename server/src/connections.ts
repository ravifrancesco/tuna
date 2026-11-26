import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Connections } from '@tuna/shared';
import { config } from './config';
import { t } from './lib/i18n';
import { log } from './lib/log';
import { writeJson } from './lib/storage';
import { HttpError } from './lib/upstream';

/**
 * Where Navidrome, Lidarr, slskd and Last.fm are. The stack's environment wins; otherwise what an admin
 * saved (first in Setup, then in Settings → Connections), kept in the data folder.
 */

interface Saved {
  navidromeUrl?: string;
  lidarrUrl?: string;
  lidarrApiKey?: string;
  slskdUrl?: string;
  slskdApiKey?: string;
  lastfmApiKey?: string;
}

const FILE = () => path.join(config.dataDir, 'connections.json');

function load(): Saved {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Saved;
  } catch {
    return {};
  }
}

let saved = load();

/** Printed in the log at start: proves whoever sets Tuna up from a browser can see the server. */
export const SETUP_CODE = String(crypto.randomInt(100000, 1000000));

const clean = (u?: string) => u?.trim().replace(/\/+$/, '') || undefined;

export const navidromeUrl = () => config.env.navidromeUrl ?? saved.navidromeUrl;
export const lidarr = () => {
  const url = config.env.lidarrUrl ?? saved.lidarrUrl;
  const apiKey = config.env.lidarrApiKey ?? saved.lidarrApiKey;
  return url && apiKey ? { url, apiKey } : undefined;
};
/** slskd (Soulseek): single songs, which Lidarr then files. */
export const slskd = () => {
  const url = config.env.slskdUrl ?? saved.slskdUrl;
  const apiKey = config.env.slskdApiKey ?? saved.slskdApiKey;
  return url && apiKey ? { url, apiKey } : undefined;
};
export const lastfmKey = () => config.env.lastfmApiKey ?? saved.lastfmApiKey;

export const has = {
  navidrome: () => Boolean(navidromeUrl()),
  lidarr: () => Boolean(lidarr()),
  slskd: () => Boolean(slskd()),
  lastfm: () => Boolean(lastfmKey()),
};

export function connections(): Connections {
  return {
    navidrome: { url: navidromeUrl() },
    lidarr: { url: config.env.lidarrUrl ?? saved.lidarrUrl, apiKey: Boolean(config.env.lidarrApiKey ?? saved.lidarrApiKey) },
    slskd: { url: config.env.slskdUrl ?? saved.slskdUrl, apiKey: Boolean(config.env.slskdApiKey ?? saved.slskdApiKey) },
    lastfm: { apiKey: has.lastfm() },
  };
}

async function reachable(url: string, init?: RequestInit): Promise<Response | undefined> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  } catch {
    return undefined;
  }
}

export interface ConnectionsPatch {
  navidromeUrl?: string;
  lidarrUrl?: string;
  /** Empty string: forget it. Undefined: keep it. */
  lidarrApiKey?: string;
  slskdUrl?: string;
  slskdApiKey?: string;
  lastfmApiKey?: string;
}

/** Checks each address before keeping it, so a typo shows up here and not as a broken app later. */
export async function saveConnections(patch: ConnectionsPatch): Promise<Connections> {
  const next: Saved = { ...saved };
  if (patch.navidromeUrl !== undefined) {
    const url = clean(patch.navidromeUrl);
    if (url) {
      const res = await reachable(`${url}/rest/ping?f=json&v=1.16.1&c=tuna`);
      const body = res ? await res.text() : '';
      if (!body.includes('subsonic-response')) throw new HttpError(400, t("Couldn't reach Navidrome at that address"));
    }
    next.navidromeUrl = url;
  }
  if (patch.lidarrUrl !== undefined) next.lidarrUrl = clean(patch.lidarrUrl);
  if (patch.lidarrApiKey !== undefined) next.lidarrApiKey = patch.lidarrApiKey.trim() || undefined;
  if (next.lidarrUrl && next.lidarrApiKey && (patch.lidarrUrl !== undefined || patch.lidarrApiKey !== undefined)) {
    const res = await reachable(`${next.lidarrUrl}/api/v1/system/status`, { headers: { 'X-Api-Key': next.lidarrApiKey } });
    if (!res) throw new HttpError(400, t("Couldn't reach Lidarr at that address"));
    if (res.status === 401) throw new HttpError(400, t("Lidarr didn't accept that API key"));
    if (!res.ok) throw new HttpError(400, t("Couldn't reach Lidarr at that address"));
  }
  if (patch.slskdUrl !== undefined) next.slskdUrl = clean(patch.slskdUrl);
  if (patch.slskdApiKey !== undefined) next.slskdApiKey = patch.slskdApiKey.trim() || undefined;
  if (next.slskdUrl && next.slskdApiKey && (patch.slskdUrl !== undefined || patch.slskdApiKey !== undefined)) {
    const res = await reachable(`${next.slskdUrl}/api/v0/application`, { headers: { 'X-API-Key': next.slskdApiKey } });
    if (!res) throw new HttpError(400, t("Couldn't reach slskd at that address"));
    if (res.status === 401 || res.status === 403) throw new HttpError(400, t("slskd didn't accept that API key"));
    if (!res.ok) throw new HttpError(400, t("Couldn't reach slskd at that address"));
  }
  if (patch.lastfmApiKey !== undefined) next.lastfmApiKey = patch.lastfmApiKey.trim() || undefined;
  writeJson(FILE(), next, 0o600);
  const changed = (['navidromeUrl', 'lidarrUrl', 'lidarrApiKey', 'slskdUrl', 'slskdApiKey', 'lastfmApiKey'] as const).filter((k) => next[k] !== saved[k]);
  saved = next;
  if (changed.length) log.info('settings', `Connections changed: ${changed.map((k) => k.replace(/Url$|ApiKey$/, '')).join(', ')}`);
  return connections();
}

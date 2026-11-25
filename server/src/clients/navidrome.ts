import { navidromeUrl } from '../connections';
import { t } from '../lib/i18n';
import { NotConfiguredError, UpstreamError, buildQuery, request } from '../lib/upstream';

/**
 * Navidrome: the library, the music itself, and who can sign in. Tuna uses its Subsonic API
 * (as each person, with the token Navidrome gives at sign-in, never their password) and, for
 * admins' household settings, its own API.
 */

const SERVICE = 'Navidrome';
const API = { v: '1.16.1', c: 'tuna', f: 'json' };

export interface SubsonicAuth {
  username: string;
  token: string;
  salt: string;
}

const base = () => {
  const url = navidromeUrl();
  if (!url) throw new NotConfiguredError(SERVICE);
  return url;
};

const authQuery = (auth: SubsonicAuth) => ({ u: auth.username, t: auth.token, s: auth.salt, ...API });

type Query = Record<string, string | number | boolean | undefined | Array<string | number>>;

export async function subsonic<T = Record<string, unknown>>(auth: SubsonicAuth, method: string, query: Query = {}): Promise<T> {
  const data = await request<{ 'subsonic-response': SubsonicResponse }>(SERVICE, base(), `/rest/${method}`, {
    query: { ...authQuery(auth), ...query },
    timeoutMs: 20_000,
  });
  const res = data?.['subsonic-response'];
  if (!res) throw new UpstreamError(SERVICE, 502, t('{service} sent something unexpected', { service: SERVICE }));
  if (res.status !== 'ok') {
    const code = res.error?.code ?? 0;
    // 40/41/44: wrong or expired credentials; 50: not allowed; 70: not found.
    const status = code === 40 || code === 41 || code === 44 ? 401 : code === 50 ? 403 : code === 70 ? 404 : 502;
    throw new UpstreamError(SERVICE, status, res.error?.message ?? `${SERVICE} error ${code}`);
  }
  return res as unknown as T;
}

/** A Subsonic URL Tuna's server fetches itself (streams, covers). */
export const subsonicUrl = (auth: SubsonicAuth, method: string, query: Query = {}) =>
  `${base()}/rest/${method}${buildQuery({ ...authQuery(auth), ...query })}`;

interface SubsonicResponse {
  status: 'ok' | 'failed';
  error?: { code: number; message: string };
}

export interface Child {
  id: string;
  title: string;
  album?: string;
  artist?: string;
  albumId?: string;
  artistId?: string;
  track?: number;
  discNumber?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
  suffix?: string;
  starred?: string;
  playCount?: number;
  musicBrainzId?: string;
}

export interface AlbumID3 {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  created?: string;
  starred?: string;
  playCount?: number;
  played?: string;
  musicBrainzId?: string;
  song?: Child[];
}

export interface ArtistID3 {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  starred?: string;
  musicBrainzId?: string;
  artistImageUrl?: string;
  album?: AlbumID3[];
}

export interface PlaylistInfo {
  id: string;
  name: string;
  songCount?: number;
  duration?: number;
  owner?: string;
  coverArt?: string;
  created?: string;
  entry?: Child[];
}

// ---- Navidrome's own API ---------------------------------------------------------------------

export interface LoginResult {
  id: string;
  username: string;
  name: string;
  isAdmin: boolean;
  token: string;
  subsonicSalt: string;
  subsonicToken: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch(`${base()}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UpstreamError(SERVICE, 502, t('{service} is unreachable ({reason})', { service: SERVICE, reason: t('no answer') }));
  }
  if (res.status === 401) throw new UpstreamError(SERVICE, 401, t('Wrong username or password'));
  if (!res.ok) throw new UpstreamError(SERVICE, res.status, `${SERVICE}: ${res.status}`);
  return (await res.json()) as LoginResult;
}

export interface NdUser {
  id: string;
  userName: string;
  name: string;
  isAdmin: boolean;
  lastLoginAt?: string;
  lastAccessAt?: string;
}

/** Navidrome's own API, as an admin. `onToken` receives the refreshed sign-in Navidrome sends back. */
export async function native<T>(jwt: string, method: string, path: string, body?: unknown, onToken?: (jwt: string) => void): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}/api${path}`, {
      method,
      headers: { 'x-nd-authorization': `Bearer ${jwt}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UpstreamError(SERVICE, 502, t('{service} is unreachable ({reason})', { service: SERVICE, reason: t('no answer') }));
  }
  const fresh = res.headers.get('x-nd-authorization')?.replace(/^Bearer\s+/i, '');
  if (fresh && onToken) onToken(fresh);
  if (res.status === 401) throw new UpstreamError(SERVICE, 401, t('Please sign in again'));
  const text = await res.text();
  if (!res.ok) {
    let message = `${SERVICE}: ${res.status}`;
    try {
      const data = JSON.parse(text) as { error?: string; errors?: Record<string, string> };
      message = data.error ?? Object.values(data.errors ?? {})[0] ?? message;
    } catch {
      /* keep */
    }
    throw new UpstreamError(SERVICE, res.status, message);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

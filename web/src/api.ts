import type { Album, AlbumDetail, Artist, ArtistDetail, Connections, GetItem, GetState, Home, Listen, ListeningStats, Lyrics, Me, MissedAlbum, Mix, Person, Playlist, PlaylistDetail, Prefs, SearchResult, ServerInfo, SpotifyImport, StatsPeriod, Stocking, TogetherControl, TogetherRoom, TogetherSummary, Track, WaitingSong, WorldAlbum, WorldAlbumDetail, WorldArtistDetail, YearInReview } from '@tuna/shared';
import { language } from './i18n';
import { app } from './lib/native';

/** Measuring the library's waveforms at night (Settings, admins). */
export interface NightWaves {
  enabled: boolean;
  from: string;
  until: string;
  total?: number;
  measured?: number;
  running: boolean;
  needsAdmin: boolean;
  noFfmpeg: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The apps keep the session themselves and send it as a Bearer token (their players can't share the cookie). */
let bearer: string | undefined;
try {
  bearer = localStorage.getItem('tuna.session') ?? undefined;
} catch {
  /* storage blocked */
}
export function setBearer(session: string | undefined) {
  bearer = session;
  try {
    if (session) localStorage.setItem('tuna.session', session);
    else localStorage.removeItem('tuna.session');
  } catch {
    /* storage blocked */
  }
}

const listeners = new Set<() => void>();
/** Called when the server says the session is over (signed out elsewhere, password changed). */
export const onSignedOut = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

let unanswered = 0;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-tuna': '1', 'x-tuna-lang': language };
  // A file goes as it is; anything else as JSON.
  const file = body instanceof Blob;
  if (body !== undefined) headers['content-type'] = file ? 'application/octet-stream' : 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: file ? body : body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    unanswered = 0;
  } catch (err) {
    // The server's gone (no connection): after two tries, the app's page with what's downloaded.
    if (++unanswered >= 2 && app.downloads) app.downloads.offline();
    throw err;
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') listeners.forEach((fn) => fn());
    const message = (data as { error?: string } | undefined)?.error ?? `${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  server: () => call<ServerInfo>('GET', '/server'),
  setup: (body: { code: string; navidromeUrl: string; lidarrUrl?: string; lidarrApiKey?: string }) => call<Connections>('POST', '/setup', body),
  login: (username: string, password: string) => call<{ me: Me; session: string }>('POST', '/login', { username, password }),
  logout: () => call('POST', '/logout'),
  me: () => call<Me>('GET', '/me'),
  savePrefs: (patch: { quality?: Prefs['quality']; listenbrainzToken?: string; lastfmUser?: string }) => call<Prefs>('PUT', '/me/prefs', patch),
  stats: (period: StatsPeriod) => call<ListeningStats>('GET', `/me/stats${q({ period })}`),
  history: (offset: number, size: number) => call<Listen[]>('GET', `/me/history${q({ offset, size })}`),
  year: (year: number) => call<YearInReview>('GET', `/me/year${q({ year })}`),
  played: (id: string) => call('POST', '/me/played', { id }),
  importSpotify: (file: File) => call<SpotifyImport>('POST', `/me/import/spotify${q({ name: file.name })}`, file),

  home: () => call<Home>('GET', '/home'),
  albums: (sort: string, offset = 0, size = 60) => call<Album[]>('GET', `/albums${q({ sort, offset, size })}`),
  album: (id: string) => call<AlbumDetail>('GET', `/album/${encodeURIComponent(id)}`),
  artists: () => call<Artist[]>('GET', '/artists'),
  artist: (id: string) => call<ArtistDetail>('GET', `/artist/${encodeURIComponent(id)}`),
  song: (id: string) => call<Track>('GET', `/song/${encodeURIComponent(id)}`),
  playlists: () => call<Playlist[]>('GET', '/playlists'),
  playlist: (id: string) => call<PlaylistDetail>('GET', `/playlist/${encodeURIComponent(id)}`),
  createPlaylist: (name: string, tracks: string[] = []) => call<Playlist>('POST', '/playlists', { name, tracks }),
  updatePlaylist: (id: string, change: { name?: string; add?: string[]; remove?: number[]; order?: string[] }) =>
    call<PlaylistDetail>('PUT', `/playlist/${encodeURIComponent(id)}`, change),
  deletePlaylist: (id: string) => call('DELETE', `/playlist/${encodeURIComponent(id)}`),
  liked: () => call<{ tracks: Track[]; albums: Album[]; artists: Artist[]; waiting?: WaitingSong[] }>('GET', '/liked'),
  like: (kind: 'track' | 'album' | 'artist', id: string, on: boolean) => call('POST', '/like', { kind, id, on }),
  search: (query: string) => call<Omit<SearchResult, 'world'>>('GET', `/search${q({ q: query })}`),
  searchWorld: (query: string) => call<SearchResult['world']>('GET', `/search/world${q({ q: query })}`),
  mixes: () => call<Mix[]>('GET', '/mixes'),
  mix: (id: string) => call<Track[]>('GET', `/mix/${encodeURIComponent(id)}`),
  lyrics: (id: string) => call<Lyrics>('GET', `/lyrics/${encodeURIComponent(id)}`),
  wave: (id: string) => call<{ peaks: number[] }>('GET', `/wave/${encodeURIComponent(id)}`),

  worldArtist: (mbid: string) => call<WorldArtistDetail>('GET', `/world/artist/${encodeURIComponent(mbid)}`),
  worldAlbum: (mbid: string) => call<WorldAlbumDetail>('GET', `/world/album/${encodeURIComponent(mbid)}`),
  get: (album: Pick<WorldAlbum, 'mbid' | 'artistMbid' | 'title' | 'artist'>) => call<GetState>('POST', '/get', album),
  getting: () => call<GetItem[]>('GET', '/getting'),

  connections: () => call<Connections>('GET', '/connections'),
  saveConnections: (patch: { navidromeUrl?: string; lidarrUrl?: string; lidarrApiKey?: string; lastfmApiKey?: string }) =>
    call<Connections>('PUT', '/connections', patch),
  waves: () => call<NightWaves>('GET', '/waves'),
  stocking: () => call<Stocking>('GET', '/stocking'),
  saveStocking: (perWeek: number) => call<Stocking>('PUT', '/stocking', { perWeek }),
  getMany: (albums: Array<{ artist: string; album: string }>) => call<{ asked: number }>('POST', '/get/many', { albums }),
  missed: () => call<MissedAlbum[]>('GET', '/get/missed'),
  together: {
    list: () => call<TogetherSummary[]>('GET', '/together'),
    start: (body: { queue: Track[]; index: number; position: number; playing: boolean; title?: string }) => call<TogetherRoom>('POST', '/together', body),
    room: (id: string) => call<TogetherRoom>('GET', `/together/${encodeURIComponent(id)}`),
    control: (id: string, c: TogetherControl) => call<TogetherRoom>('POST', `/together/${encodeURIComponent(id)}/control`, c),
    leave: (id: string, clientId: string) => call('POST', `/together/${encodeURIComponent(id)}/leave`, { clientId }),
    end: (id: string) => call('DELETE', `/together/${encodeURIComponent(id)}`),
  },
  saveWaves: (patch: { enabled?: boolean; from?: string; until?: string }) => call<NightWaves>('PUT', '/waves', patch),
  household: () => call<Person[]>('GET', '/household'),
  addPerson: (p: { username: string; name?: string; password: string; admin?: boolean }) => call<Person>('POST', '/household', p),
  changePerson: (id: string, change: { name?: string; password?: string; admin?: boolean }) => call<Person>('PUT', `/household/${encodeURIComponent(id)}`, change),
  removePerson: (id: string) => call('DELETE', `/household/${encodeURIComponent(id)}`),
};

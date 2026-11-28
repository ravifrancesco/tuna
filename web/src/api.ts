import type { Album, AlbumDetail, AlbumWhole, Artist, ArtistDetail, Connections, DeviceCommand, GetItem, GetState, Home, Listen, ListeningStats, Lyrics, Me, MissedAlbum, Mix, Person, Playlist, PlaylistDetail, Prefs, SearchResult, ServerInfo, SoulseekFiles, SpotifyImport, StatsPeriod, Stocking, TogetherControl, TogetherRoom, TogetherSummary, Track, WaitingSong, WorldAlbum, WorldAlbumDetail, WorldArtistDetail, YearInReview } from '@tuna/shared';
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

/** A file sent, kept aside until it's put in: what it seems to be (by its tags, else its folders and name). */
export interface StagedFile {
  id: string;
  seconds?: number;
  guess: { title: string; artist?: string; albumArtist?: string; album?: string; year?: string; number?: number; disc?: number };
}

/** A file sent as it is, with how much of it has gone (0–1) as it goes. */
function send<T>(path: string, file: Blob, onProgress?: (part: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api${path}`);
    x.withCredentials = true;
    x.setRequestHeader('x-tuna', '1');
    x.setRequestHeader('x-tuna-lang', language);
    x.setRequestHeader('content-type', 'application/x-tuna-file');
    if (bearer) x.setRequestHeader('authorization', `Bearer ${bearer}`);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let data: unknown;
      try {
        data = x.responseText ? JSON.parse(x.responseText) : undefined;
      } catch {
        data = x.responseText;
      }
      if (x.status >= 200 && x.status < 300) return resolve(data as T);
      if (x.status === 401) listeners.forEach((fn) => fn());
      reject(new ApiError(x.status, (data as { error?: string } | undefined)?.error ?? `${x.status}`));
    };
    x.onerror = () => reject(new Error('network'));
    x.send(file);
  });
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  server: () => call<ServerInfo>('GET', '/server'),
  /** An album's kind and its songs that aren't in the library (a moment after the album: it may take a while). */
  albumWhole: (id: string) => call<AlbumWhole>('GET', `/album/${encodeURIComponent(id)}/whole`),
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
  liked: () => call<{ tracks: Track[]; albums: Album[]; artists: Artist[]; added?: (string | null)[]; waiting?: WaitingSong[] }>('GET', '/liked'),
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
  /** Only what's on its way (and what just got somewhere): small, for looking often. */
  moving: () => call<{ songs: Array<{ id: string; title: string; artist: string; get: GetState }>; albums: Array<{ mbid: string; get: GetState }> }>('GET', '/get/states'),
  /** On its way was opened: albums that were ready on the visit before go from it. */
  gettingOpened: () => call<GetItem[]>('POST', '/getting/opened'),

  connections: () => call<Connections>('GET', '/connections'),
  saveConnections: (patch: { navidromeUrl?: string; lidarrUrl?: string; lidarrApiKey?: string; slskdUrl?: string; slskdApiKey?: string; slskdFiles?: SoulseekFiles; lastfmApiKey?: string }) =>
    call<Connections>('PUT', '/connections', patch),
  waves: () => call<NightWaves>('GET', '/waves'),
  stocking: () => call<Stocking>('GET', '/stocking'),
  saveStocking: (perWeek: number) => call<Stocking>('PUT', '/stocking', { perWeek }),
  getMany: (albums: Array<{ artist: string; album: string; isrc?: string }>) => call<{ asked: number }>('POST', '/get/many', { albums }),
  /** Single songs (through slskd, filed by Lidarr); `songs: false`: the server got their albums instead. */
  getSongs: (songs: Array<{ artist: string; title: string; album?: string; isrc?: string }>) => call<{ asked: number; songs: boolean }>('POST', '/get/songs', { songs }),
  /** Files someone has, into the library: a cover for those that follow (the same `batch`), a file for one song, or one of an album's. */
  sendCover: (batch: string, file: Blob) => send<{ ok: boolean }>(`/get/files/cover${q({ batch })}`, file),
  stageFile: (f: { batch: string; name: string; path?: string }, file: File, onProgress?: (part: number) => void) => send<StagedFile>(`/get/files${q(f)}`, file, onProgress),
  checkFiles: (body: { artist: string; album: string; mbid?: string; files: Array<{ id: string; title: string; number?: number; disc?: number }> }) =>
    call<{ album?: { title: string; artist: string; year?: string; mbid: string }; files: Array<{ id: string; title?: string; number?: number; disc?: number; why?: string }> }>('POST', '/get/files/check', body),
  importFiles: (body: {
    batch: string;
    song?: { artist: string; title: string };
    album: { artist: string; title: string; year?: string; mbid?: string };
    files: Array<{ id: string; title: string; artist?: string; number?: number; disc?: number }>;
  }) => call<{ files: Array<{ id: string; why?: string }> }>('POST', '/get/files/import', body),
  discardFiles: (batch: string) => call('DELETE', `/get/files${q({ batch })}`),
  missed: () => call<MissedAlbum[]>('GET', '/get/missed'),
  /** Songs and albums people asked for that couldn't be found (an admin's), and looking for them again. */
  notFound: () => call<{ songs: number; albums: number }>('GET', '/get/again'),
  lookAgain: () => call<{ songs: number; albums: number }>('POST', '/get/again'),
  /** New songs for each person every week (an admin sets how many; needs slskd), and a radio's. */
  discovery: () => call<{ perWeek: number; available: boolean }>('GET', '/discovery'),
  saveDiscovery: (perWeek: number) => call<{ perWeek: number; available: boolean }>('PUT', '/discovery', { perWeek }),
  radioNew: (seed: string, heard = 0) => call<Track[]>('GET', `/radio/new?seed=${encodeURIComponent(seed)}&heard=${heard}`),
  autoplay: (seeds: string[], have: string[]) => call<Track[]>('POST', '/autoplay', { seeds, have }),
  /** Albums still to ask for (Get all), a few at a time: all of them, and how many are mine. */
  stillToAsk: () => call<{ count: number; mine: number; albums?: number; songs?: number }>('GET', '/get/waiting'),
  stopAsking: () => call<{ stopped: number }>('POST', '/get/stop'),
  /** This account's devices (as Spotify Connect): what this one plays, commands to another, handing the music on. */
  devices: {
    state: (body: { device: string; playing: boolean; index: number; position: number; queue?: Track[]; source?: unknown }) => call<{ ok: boolean }>('POST', '/devices/state', body),
    command: (to: string, command: DeviceCommand) => call<{ ok: boolean }>('POST', '/devices/command', { to, command }),
    transfer: (to: string) => call<{ ok: boolean }>('POST', '/devices/transfer', { to }),
  },
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

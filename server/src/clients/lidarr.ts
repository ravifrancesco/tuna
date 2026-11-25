import { lidarr as lidarrConnection } from '../connections';
import { NotConfiguredError, request, type RequestOptions } from '../lib/upstream';

/** Lidarr: finds albums (through Prowlarr) and downloads them (through qBittorrent) into the music folder. */

const SERVICE = 'Lidarr';

export function call<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const c = lidarrConnection();
  if (!c) throw new NotConfiguredError(SERVICE);
  return request<T>(SERVICE, c.url, `/api/v1${path}`, { ...opts, headers: { 'X-Api-Key': c.apiKey, ...opts.headers } });
}

export interface LArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  monitored?: boolean;
}

export interface LAlbum {
  id: number;
  title: string;
  foreignAlbumId: string;
  artistId: number;
  monitored: boolean;
  albumType?: string;
  releaseDate?: string;
  artist?: LArtist;
  images?: Array<{ coverType: string; url?: string; remoteUrl?: string }>;
  statistics?: { trackFileCount: number; trackCount: number; totalTrackCount: number; percentOfTracks: number };
}

export interface LQueueItem {
  id: number;
  albumId?: number;
  size: number;
  sizeleft: number;
  timeleft?: string;
  status: string;
  trackedDownloadState?: string;
  title?: string;
}

export interface LSearchResult {
  foreignId: string;
  artist?: { artistName: string; foreignArtistId: string; disambiguation?: string; images?: LAlbum['images'] };
  album?: { title: string; foreignAlbumId: string; releaseDate?: string; albumType?: string; artist?: { artistName: string; foreignArtistId: string }; images?: LAlbum['images'] };
}

export const artists = () => call<LArtist[]>('/artist');
export const albums = (artistId: number) => call<LAlbum[]>('/album', { query: { artistId } });
export const album = (id: number) => call<LAlbum>(`/album/${id}`);
export const queue = () =>
  call<{ records: LQueueItem[] }>('/queue', { query: { page: 1, pageSize: 200, includeUnknownArtistItems: false } }).then((q) => q.records ?? []);
export const search = (term: string) => call<LSearchResult[]>('/search', { query: { term } });
export const rootFolders = () => call<Array<{ id: number; path: string }>>('/rootfolder');
export const qualityProfiles = () => call<Array<{ id: number; name: string }>>('/qualityprofile');
export const metadataProfiles = () => call<Array<{ id: number; name: string }>>('/metadataprofile');

export const lookupArtist = (mbid: string) => call<LArtist[]>('/artist/lookup', { query: { term: `lidarr:${mbid}` } });

/** Lidarr's own search by name (its metadata server, not MusicBrainz directly), as its "Add new" page. */
export interface LFoundArtist {
  artistName: string;
  foreignArtistId: string;
  disambiguation?: string;
}
export interface LFoundAlbum {
  title: string;
  foreignAlbumId: string;
  albumType?: string;
  secondaryTypes?: Array<string | { name?: string }>;
  releaseDate?: string;
  artist?: { artistName: string; foreignArtistId: string };
}
export const findArtists = (term: string) => call<LFoundArtist[]>('/artist/lookup', { query: { term }, timeoutMs: 20_000 });
export const findAlbums = (term: string) => call<LFoundAlbum[]>('/album/lookup', { query: { term }, timeoutMs: 20_000 });

export const addArtist = (body: Record<string, unknown>) => call<LArtist>('/artist', { method: 'POST', body });
export const monitorAlbums = (albumIds: number[]) => call<unknown>('/album/monitor', { method: 'PUT', body: { albumIds, monitored: true } });
export const searchAlbums = (albumIds: number[]) => call<unknown>('/command', { method: 'POST', body: { name: 'AlbumSearch', albumIds } });

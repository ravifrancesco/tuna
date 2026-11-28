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
  /** Its editions; the monitored one is the one Lidarr files songs into. */
  releases?: Array<{ id: number; title?: string; trackCount?: number; monitored?: boolean }>;
}

export interface LTrack {
  id: number;
  albumId: number;
  albumReleaseId?: number;
  /** MusicBrainz's recording. */
  foreignRecordingId?: string;
  title: string;
  absoluteTrackNumber?: number;
  mediumNumber?: number;
  /** Milliseconds. */
  duration?: number;
  hasFile: boolean;
  trackFileId?: number;
}

export interface LQuality {
  quality: { id: number; name: string };
  revision: { version: number; real: number; isRepack?: boolean };
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

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** MusicBrainz's ids (Lidarr's own); other sources' (Tubifarry's, "1234@deezer", "a1234@discogs") aren't. */
export const isMbid = (id: string | undefined) => Boolean(id && MBID.test(id));

/**
 * An artist by its id: MusicBrainz's by the id itself; one Lidarr knows from another source (Deezer,
 * Discogs…) by its name, the one with that id, so Tuna needn't know how each source is asked.
 */
export async function lookupArtist(id: string, name?: string): Promise<LArtist[]> {
  if (isMbid(id)) return call<LArtist[]>('/artist/lookup', { query: { term: `lidarr:${id}` } });
  const found = name ? await call<LArtist[]>('/artist/lookup', { query: { term: name }, timeoutMs: 20_000 }) : [];
  return found.filter((a) => a.foreignArtistId === id);
}

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
export const albumByMbid = (mbid: string) => call<LAlbum[]>('/album', { query: { foreignAlbumId: mbid } }).then((a) => a[0]);
export const tracks = (albumId: number) => call<LTrack[]>('/track', { query: { albumId } });
export const deleteTrackFile = (id: number) => call<unknown>(`/trackfile/${id}`, { method: 'DELETE' });
export const remotePathMappings = () => call<Array<{ host: string; remotePath: string; localPath: string }>>('/remotepathmapping');

/** What Lidarr makes of the files in a folder (the quality, mainly), as its manual import page. */
export const importable = (folder: string) =>
  call<Array<{ path: string; quality: LQuality; rejections?: Array<{ reason: string }> }>>('/manualimport', { query: { folder, filterExistingFiles: false } });

/** Files one song into its album: renamed, tagged and kept track of, as everything Lidarr gets. */
export const importSong = (file: { path: string; artistId: number; albumId: number; albumReleaseId: number; trackId: number; quality: LQuality }) =>
  call<{ id: number }>('/command', {
    method: 'POST',
    body: {
      name: 'ManualImport',
      importMode: 'move',
      replaceExistingFiles: false,
      files: [{ path: file.path, artistId: file.artistId, albumId: file.albumId, albumReleaseId: file.albumReleaseId, trackIds: [file.trackId], quality: file.quality, disableReleaseSwitching: true }],
    },
  });
export const command = (id: number) => call<{ id: number; status: string; message?: string }>(`/command/${id}`);
export const monitorAlbums = (albumIds: number[]) => call<unknown>('/album/monitor', { method: 'PUT', body: { albumIds, monitored: true } });
export const searchAlbums = (albumIds: number[]) => call<unknown>('/command', { method: 'POST', body: { name: 'AlbumSearch', albumIds } });

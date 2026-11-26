import { config, userAgent } from '../config';
import { lastfmKey } from '../connections';
import { HOUR, TTLCache } from '../lib/cache';
import { request, UpstreamError } from '../lib/upstream';

/**
 * The public services: MusicBrainz (everything that exists), the Cover Art Archive (its covers),
 * LRCLIB (lyrics), ListenBrainz (what to discover) and Last.fm (similar artists, with a key).
 * Only music ids and names go to them, never who's listening.
 */

const headers = () => ({ 'user-agent': userAgent() });

// ---- MusicBrainz: one request a second, as it asks ------------------------------------------

let mbNext = 0;
async function mb<T>(path: string, query: Record<string, string | number>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, mbNext - Date.now());
    mbNext = Math.max(Date.now(), mbNext) + 1100;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await request<T>('MusicBrainz', config.musicbrainzUrl, path, { query: { ...query, fmt: 'json' }, headers: headers(), timeoutMs: 12_000 });
    } catch (err) {
      // "Currently busy" (503): MusicBrainz asks everyone to slow down and try again shortly.
      if (attempt >= 2 || !(err instanceof UpstreamError && err.status === 503)) throw err;
      mbNext = Math.max(mbNext, Date.now() + 2000 * (attempt + 1));
    }
  }
}

const mbCache = new TTLCache<unknown>(1000);
const cached = <T>(key: string, load: () => Promise<T>) => mbCache.wrap(key, 12 * HOUR, load) as Promise<T>;

export interface MbArtistCredit {
  name: string;
  artist: { id: string; name: string };
}

export interface MbReleaseGroup {
  id: string;
  title: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'first-release-date'?: string;
  'artist-credit'?: MbArtistCredit[];
  score?: number;
}

export interface MbArtist {
  id: string;
  name: string;
  disambiguation?: string;
  score?: number;
  type?: string;
}

export const mbSearchArtists = (q: string) =>
  cached(`sa:${q.toLowerCase()}`, () => mb<{ artists: MbArtist[] }>('/artist', { query: q, limit: 6 }).then((r) => r.artists ?? []));

export const mbSearchAlbums = (q: string) =>
  cached(`sg:${q.toLowerCase()}`, () =>
    mb<{ 'release-groups': MbReleaseGroup[] }>('/release-group', { query: q, limit: 10 }).then((r) => r['release-groups'] ?? []),
  );

export interface MbRecording {
  id: string;
  title: string;
  'artist-credit'?: MbArtistCredit[];
  releases?: Array<{ id: string; title: string; status?: string; 'release-group'?: { id: string; title: string; 'primary-type'?: string; 'secondary-types'?: string[] } }>;
  score?: number;
}
/** Songs by name (title, artist and album at once, as typed in a search box). */
export const mbFindSongs = (q: string) =>
  cached(`songs:${q.toLowerCase()}`, () => mb<{ recordings?: MbRecording[] }>('/recording', { query: q, limit: 25, dismax: 'true' }).then((r) => r.recordings ?? []));
export const mbSearchRecordings = (q: string) =>
  cached(`rec:${q.toLowerCase()}`, () => mb<{ recordings?: MbRecording[] }>('/recording', { query: q, limit: 10 }).then((r) => r.recordings ?? []));

export const mbArtist = (mbid: string) => cached(`a:${mbid}`, () => mb<MbArtist>(`/artist/${mbid}`, {}));

/** An artist's albums, EPs and singles (no compilations, live recordings or bootlegs). */
export const mbArtistAlbums = (mbid: string) =>
  cached(`ag:${mbid}`, () =>
    mb<{ 'release-groups': MbReleaseGroup[] }>('/release-group', { artist: mbid, type: 'album|ep|single', limit: 100 }).then((r) =>
      (r['release-groups'] ?? []).filter((g) => !(g['secondary-types'] ?? []).some((s) => /compilation|live|demo|mixtape|interview|spokenword/i.test(s))),
    ),
  );

export interface MbRelease {
  id: string;
  status?: string;
  date?: string;
  media?: { tracks?: { title: string; length?: number; recording?: { title: string } }[] }[];
}
export const mbReleases = (releaseGroupMbid: string) =>
  cached(`r:${releaseGroupMbid}`, () =>
    mb<{ releases?: MbRelease[] }>('/release', { 'release-group': releaseGroupMbid, inc: 'recordings', limit: 10 }).then((r) => r.releases ?? []),
  );

export const mbReleaseGroup = (mbid: string) =>
  cached(`g:${mbid}`, () => mb<MbReleaseGroup>(`/release-group/${mbid}`, { inc: 'artist-credits' }));

/** The front cover of an album that isn't in the library (small; Tuna keeps a copy). */
export const coverArtFor = (releaseGroupMbid: string) => `${config.coverArtUrl}/release-group/${releaseGroupMbid}/front-250`;

// ---- LRCLIB ------------------------------------------------------------------------------------

export interface LrclibTrack {
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export async function lrclib(q: { artist: string; track: string; album?: string; duration?: number }): Promise<LrclibTrack | undefined> {
  try {
    return await request<LrclibTrack>('LRCLIB', config.lrclibUrl, '/get', {
      query: { artist_name: q.artist, track_name: q.track, album_name: q.album, duration: q.duration ? Math.round(q.duration) : undefined },
      headers: headers(),
      timeoutMs: 8000,
    });
  } catch (err) {
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

// ---- ListenBrainz ------------------------------------------------------------------------------

export interface LbRecording {
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  release?: string;
  releaseGroupMbid?: string;
}

const lbCache = new TTLCache<LbRecording[]>(200);

/** What ListenBrainz suggests for someone (from what they've listened to), with names. */
export function lbRecommendations(user: string): Promise<LbRecording[]> {
  return lbCache.wrap(user.toLowerCase(), 6 * HOUR, async () => {
    const recs = await request<{ payload?: { mbids?: Array<{ recording_mbid: string }> } } | undefined>(
      'ListenBrainz',
      config.listenbrainzUrl,
      `/cf/recommendation/user/${encodeURIComponent(user)}/recording`,
      { query: { count: 60 }, headers: headers() },
    );
    const mbids = (recs?.payload?.mbids ?? []).map((m) => m.recording_mbid).slice(0, 60);
    if (!mbids.length) return [];
    const meta = await request<Record<string, LbMeta>>('ListenBrainz', config.listenbrainzUrl, '/metadata/recording/', {
      query: { recording_mbids: mbids.join(','), inc: 'artist release' },
      headers: headers(),
    });
    return mbids
      .map((mbid): LbRecording | undefined => {
        const m = meta?.[mbid];
        if (!m?.recording?.name) return undefined;
        return {
          mbid,
          title: m.recording.name,
          artist: m.artist?.name ?? '',
          artistMbid: m.artist?.artists?.[0]?.artist_mbid,
          release: m.release?.name,
          releaseGroupMbid: m.release?.release_group_mbid,
        };
      })
      .filter((r): r is LbRecording => Boolean(r));
  });
}

interface LbMeta {
  recording?: { name?: string };
  artist?: { name?: string; artists?: Array<{ artist_mbid?: string }> };
  release?: { name?: string; release_group_mbid?: string };
}

export async function lbValidate(token: string): Promise<string | undefined> {
  const res = await request<{ valid?: boolean; user_name?: string }>('ListenBrainz', config.listenbrainzUrl, '/validate-token', {
    headers: { ...headers(), authorization: `Token ${token}` },
  });
  return res?.valid ? res.user_name : undefined;
}

export interface Listen {
  artist: string;
  track: string;
  album?: string;
  duration?: number;
  at?: number;
}

export function lbSubmit(token: string, kind: 'single' | 'playing_now', listen: Listen) {
  return request('ListenBrainz', config.listenbrainzUrl, '/submit-listens', {
    method: 'POST',
    headers: { ...headers(), authorization: `Token ${token}` },
    body: {
      listen_type: kind,
      payload: [
        {
          ...(kind === 'single' ? { listened_at: Math.floor((listen.at ?? Date.now()) / 1000) } : {}),
          track_metadata: {
            artist_name: listen.artist,
            track_name: listen.track,
            release_name: listen.album,
            additional_info: { duration_ms: listen.duration ? Math.round(listen.duration * 1000) : undefined, media_player: 'Tuna', submission_client: 'Tuna' },
          },
        },
      ],
    },
  });
}

// ---- Last.fm -----------------------------------------------------------------------------------

export interface LfmSimilar {
  name: string;
  mbid?: string;
}

const lfmCache = new TTLCache<LfmSimilar[]>(500);

export function lastfmSimilar(artist: string, mbid?: string): Promise<LfmSimilar[]> {
  const key = lastfmKey();
  if (!key) return Promise.resolve([]);
  return lfmCache.wrap(`${mbid ?? artist}`.toLowerCase(), 24 * HOUR, async () => {
    const res = await request<{ similarartists?: { artist?: Array<{ name: string; mbid?: string }> } }>('Last.fm', config.lastfmUrl, '/', {
      query: { method: 'artist.getsimilar', api_key: key, format: 'json', limit: 16, ...(mbid ? { mbid } : { artist }) },
      headers: headers(),
    });
    return (res?.similarartists?.artist ?? []).map((a) => ({ name: a.name, mbid: a.mbid || undefined }));
  });
}

/** Someone's Last.fm account, by name (nothing to sign in to: their listening is public). */
const lfmTracks = new TTLCache<Array<{ title: string; artist: string }>>(500);

/** Songs like a song, as Last.fm's listeners hear it. */
export function lastfmSimilarTracks(artist: string, title: string): Promise<Array<{ title: string; artist: string }>> {
  const key = lastfmKey();
  if (!key) return Promise.resolve([]);
  return lfmTracks.wrap(`${artist}|${title}`.toLowerCase(), 24 * HOUR, async () => {
    const res = await request<{ similartracks?: { track?: Array<{ name: string; artist?: { name?: string } }> } }>('Last.fm', config.lastfmUrl, '/', {
      query: { method: 'track.getsimilar', api_key: key, format: 'json', limit: 30, autocorrect: 1, artist, track: title },
      headers: headers(),
      timeoutMs: 8000,
    });
    return (res.similartracks?.track ?? []).flatMap((t) => (t.name && t.artist?.name ? [{ title: t.name, artist: t.artist.name }] : []));
  });
}

export async function lastfmUser(user: string): Promise<string | undefined> {
  const key = lastfmKey();
  if (!key) return undefined;
  const res = await request<{ user?: { name?: string } }>('Last.fm', config.lastfmUrl, '/', {
    query: { method: 'user.getinfo', user, api_key: key, format: 'json' },
    headers: headers(),
  }).catch(() => undefined);
  return res?.user?.name;
}

/** What someone played lately, wherever they scrobble from (newest first). */
export async function lastfmRecent(user: string, since: number): Promise<OutsideListen[]> {
  const key = lastfmKey();
  if (!key) return [];
  const out: OutsideListen[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await request<{
      recenttracks?: { track?: Array<{ name: string; artist?: { '#text'?: string }; album?: { '#text'?: string }; date?: { uts?: string } }>; '@attr'?: { totalPages?: string } };
    }>('Last.fm', config.lastfmUrl, '/', {
      query: { method: 'user.getrecenttracks', user, from: Math.floor(since / 1000), limit: 200, page, api_key: key, format: 'json' },
      headers: headers(),
    });
    for (const x of res?.recenttracks?.track ?? []) {
      const at = Number(x.date?.uts) * 1000;
      if (at && x.artist?.['#text']) out.push({ at, artist: x.artist['#text'], title: x.name, album: x.album?.['#text'] || undefined });
    }
    if (page >= Number(res?.recenttracks?.['@attr']?.totalPages ?? 1)) break;
  }
  return out;
}

/** The artists someone plays most on Last.fm, lately. */
export async function lastfmTopArtists(user: string): Promise<LfmSimilar[]> {
  const key = lastfmKey();
  if (!key) return [];
  const res = await request<{ topartists?: { artist?: Array<{ name: string; mbid?: string }> } }>('Last.fm', config.lastfmUrl, '/', {
    query: { method: 'user.gettopartists', user, period: '3month', limit: 30, api_key: key, format: 'json' },
    headers: headers(),
  }).catch(() => undefined);
  return (res?.topartists?.artist ?? []).map((a) => ({ name: a.name, mbid: a.mbid || undefined }));
}

/** An artist's most listened-to albums on Last.fm. */
export async function lastfmTopAlbums(artist: string, mbid?: string): Promise<string[]> {
  const key = lastfmKey();
  if (!key) return [];
  const res = await request<{ topalbums?: { album?: Array<{ name: string }> } }>('Last.fm', config.lastfmUrl, '/', {
    query: { method: 'artist.gettopalbums', limit: 8, api_key: key, format: 'json', ...(mbid ? { mbid } : { artist }) },
    headers: headers(),
  }).catch(() => undefined);
  return (res?.topalbums?.album ?? []).map((a) => a.name).filter((n) => n && n !== '(null)');
}

// ---- What people play outside Tuna ---------------------------------------------------------------

export interface OutsideListen {
  at: number;
  artist: string;
  title: string;
  album?: string;
}

/** Someone's ListenBrainz listens since a moment, leaving out the ones Tuna sent itself. */
export async function lbListens(user: string, since: number): Promise<OutsideListen[]> {
  const out: OutsideListen[] = [];
  let max: number | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await request<{
      payload?: { listens?: Array<{ listened_at: number; track_metadata?: { artist_name?: string; track_name?: string; release_name?: string; additional_info?: { submission_client?: string } } }> };
    }>('ListenBrainz', config.listenbrainzUrl, `/user/${encodeURIComponent(user)}/listens`, {
      query: { min_ts: Math.floor(since / 1000), count: 1000, ...(max ? { max_ts: max } : {}) },
      headers: headers(),
    });
    const listens = res?.payload?.listens ?? [];
    for (const l of listens) {
      const m = l.track_metadata;
      if (!m?.artist_name || !m.track_name || m.additional_info?.submission_client === 'Tuna') continue;
      out.push({ at: l.listened_at * 1000, artist: m.artist_name, title: m.track_name, album: m.release_name });
    }
    if (listens.length < 1000) break;
    max = listens[listens.length - 1].listened_at;
  }
  return out;
}

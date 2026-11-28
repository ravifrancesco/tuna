/**
 * What the Tuna server sends the web interface (and, through it, the apps). Ids are Navidrome's
 * for music in the library; `mbid`s are MusicBrainz ids, for music that isn't in it yet.
 */

export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album: string;
  albumId?: string;
  /** Seconds. */
  duration: number;
  track?: number;
  disc?: number;
  year?: number;
  /** Navidrome cover id: /api/cover/{cover}. */
  cover?: string;
  liked?: boolean;
  plays?: number;
  /** The file's own format ("flac", "mp3"…), to decide whether a player needs another one. */
  suffix?: string;
  bitRate?: number;
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  artistId?: string;
  year?: number;
  cover?: string;
  songCount: number;
  duration: number;
  genre?: string;
  liked?: boolean;
  /** When it came into the library (ISO). */
  added?: string;
  mbid?: string;
}

export interface AlbumDetail extends Album {
  tracks: Track[];
  moreBy: Album[];
}

export interface Artist {
  id: string;
  name: string;
  cover?: string;
  albumCount?: number;
  liked?: boolean;
  mbid?: string;
}

export interface ArtistDetail extends Artist {
  bio?: string;
  top: Track[];
  albums: Album[];
  /** Albums this artist made that aren't in the library (MusicBrainz), with Get. */
  elsewhere: WorldAlbum[];
  similar: Artist[];
  /** Artists like this one that aren't in the library. */
  similarElsewhere: WorldArtist[];
}

export interface Playlist {
  id: string;
  name: string;
  songCount: number;
  duration: number;
  cover?: string;
  owner?: string;
  mine: boolean;
  /** ISO. */
  created?: string;
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[];
  /** When each of `tracks` went in (ISO), where it's known. */
  added?: (string | null)[];
  /** Imported from Spotify but not in the library yet: each shows after track `after` (-1: first). */
  waiting?: WaitingSong[];
}

export interface WaitingSong {
  title: string;
  artist: string;
  album?: string;
  /** Asked for already: where it's at. */
  get?: GetState;
  /** When it went into the playlist on Spotify (ISO). */
  added?: string;
  /** Its code, where Spotify's files had it. */
  isrc?: string;
  after: number;
  /** Its number on its album (an album's songs that aren't here). */
  track?: number;
}

/** The rest of an album in the library, where it's known: its kind, and its songs that aren't here. */
export interface AlbumWhole {
  kind?: 'Album' | 'EP' | 'Single' | 'Other';
  missing: WaitingSong[];
}

/** A mix: tracks Tuna puts together (from the library) when it's played. */
export interface Mix {
  /** What /api/mix/{id} plays: "artist:{id}", "song:{id}", "album:{id}", "daily:{n}", "liked", "discover". */
  id: string;
  title: string;
  subtitle?: string;
  covers: string[];
}

export type GetState =
  | { state: 'none' }
  | { state: 'looking'; /** Waiting its turn (a few songs are looked for at a time). */ queued?: boolean }
  | { state: 'downloading'; progress: number; left?: string }
  | { state: 'ready'; albumId?: string; /** A song got on its own: it, in the library (to download onto a device). */ track?: Track }
  | { state: 'notFound' };

export interface WorldAlbum {
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  year?: number;
  /** An image URL (Cover Art Archive), through /api/art. */
  cover?: string;
  type?: 'Album' | 'Single' | 'EP' | 'Other';
  /** In the library already: its id there. */
  albumId?: string;
  get: GetState;
}

export interface WorldArtist {
  mbid: string;
  name: string;
  /** In the library already: its id there. */
  artistId?: string;
  disambiguation?: string;
  cover?: string;
}

/** An album that isn't in the library: its songs, as MusicBrainz lists them. */
export interface WorldAlbumDetail extends WorldAlbum {
  /** `get`: each song asked for on its own, where it's at. */
  tracks: { title: string; duration?: number; get?: GetState }[];
}

export interface WorldArtistDetail extends WorldArtist {
  albums: WorldAlbum[];
}

export type Row =
  | { id: string; title: string; kind: 'albums'; items: Album[] }
  | { id: string; title: string; kind: 'artists'; items: Artist[] }
  | { id: string; title: string; kind: 'tracks'; items: Track[] }
  | { id: string; title: string; kind: 'playlists'; items: Playlist[] }
  | { id: string; title: string; kind: 'mixes'; items: Mix[] }
  | { id: string; title: string; kind: 'world'; items: WorldAlbum[] }
  | { id: string; title: string; kind: 'worldArtists'; items: WorldArtist[] };

export type StatsPeriod = 'week' | 'month' | 'year' | 'all';

/** What someone listened to, from the plays Tuna counted (the last 7, 30 or 365 days, or ever). */
export interface ListeningStats {
  period: StatsPeriod;
  /** Seconds listened. */
  seconds: number;
  plays: number;
  songs: number;
  artists: number;
  topArtists: (Artist & { plays: number })[];
  topSongs: (Track & { plays: number })[];
  topAlbums: (Album & { plays: number })[];
  /** The first play Tuna counted (ISO). */
  since?: string;
}

/** An album asked for by its names (Get all, a playlist's missing songs) that couldn't be found. */
export interface MissedAlbum {
  artist: string;
  album: string;
  by: string;
  /** When (ms since 1970). */
  at: number;
  /** One of its songs' codes, where Spotify's files had it. */
  isrc?: string;
}

/** Someone's year in music, from the plays Tuna counted. */
export interface YearInReview {
  year: number;
  seconds: number;
  plays: number;
  /** Days with at least one play. */
  days: number;
  artists: number;
  /** Artists first heard this year. */
  newArtists: number;
  topArtists: (Artist & { plays: number })[];
  topSongs: (Track & { plays: number })[];
  topAlbum?: Album & { plays: number };
  /** The month (0 = January) with the most listening. */
  busiestMonth?: { month: number; seconds: number };
  firstSong?: Track & { at: string };
}

/** What came in from Spotify, and the albums of the songs that aren't in the library. */
export interface SpotifyImport {
  playlists: number;
  liked: number;
  albums: number;
  artists: number;
  plays: number;
  /** Songs that aren't in the library. */
  missing: number;
  /** The albums of the songs that aren't here, most played first. */
  missingAlbums: { artist: string; album: string; songs: number; plays: number; isrc?: string }[];
  /** The songs that aren't here, most played first. */
  missingSongs?: { artist: string; title: string; album?: string; plays: number; isrc?: string }[];
}

/** Why the weekly picks chose an album. */
export type StockingWhy = 'elsewhere' | 'new' | 'listenbrainz' | 'more';

/** Of what the household played in the last 30 days (here, and elsewhere through ListenBrainz or Last.fm), how much is here. */
export interface Coverage {
  percent: number;
  plays: number;
  /** The plays from elsewhere. */
  elsewhere: number;
  /** The albums played most that aren't here. */
  missing: { artist: string; album: string; plays: number }[];
}

/** Keeping the library stocked (Settings, admins). */
export interface Stocking {
  /** Albums a week; 0 is off. */
  perWeek: number;
  thisWeek: number;
  picks: { title: string; artist: string; why: StockingWhy; at: string; cover?: string }[];
  coverage?: Coverage;
  needsLidarr: boolean;
}

/** One play, newest first. */
export interface Listen {
  /** ISO. */
  at: string;
  track: Track;
}

export interface Home {
  greeting: string;
  rows: Row[];
}

export interface SearchResult {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  /** Not in the library: from MusicBrainz (or Lidarr's search); songs from MusicBrainz, to get one by one. */
  world: { artists: WorldArtist[]; albums: WorldAlbum[]; songs?: WaitingSong[] };
}

export interface Lyrics {
  synced: boolean;
  lines: Array<{ time?: number; text: string }>;
  source: 'library' | 'lrclib';
}

export interface GetItem {
  /** An album's MusicBrainz id; a song's own id. */
  mbid: string;
  /** A whole album (the default), or one song. */
  kind?: 'album' | 'song';
  title: string;
  artist: string;
  /** A song's album. */
  album?: string;
  cover?: string;
  get: GetState;
  by: string;
  at: string;
}

export interface Me {
  id: string;
  username: string;
  name: string;
  admin: boolean;
  /** Lets the apps' players and the lock screen fetch music and covers without the cookie. */
  mediaKey: string;
  prefs: Prefs;
}

/** How good the music is (and how big): Automatic is Original on Wi-Fi and Normal on mobile data. */
export type Quality = 'auto' | 'low' | 'normal' | 'high' | 'original';

export interface Prefs {
  quality: Quality;
  /** ListenBrainz account, for what you play to count towards Discover. */
  listenbrainzUser?: string;
  /** True once a ListenBrainz token is saved (it's never sent back). */
  listenbrainzToken?: boolean;
  /** Their Last.fm name, if linked. */
  lastfmUser?: string;
}

export interface ServerInfo {
  version: string;
  /** Navidrome is set up: people can sign in. */
  ready: boolean;
  services: { navidrome: boolean; lidarr: boolean; slskd: boolean; lastfm: boolean; /** Tuna has Lidarr's music folder: people can send files of their own. */ music: boolean };
}

/** Which copies of a song to get from Soulseek: lossless up to CD quality, any lossless (hi-res too), or MP3 320. */
export type SoulseekFiles = 'cd' | 'lossless' | 'mp3';

export interface Connections {
  navidrome: { url?: string };
  /** `folder`: Lidarr's music folder; `reachable`: Tuna has it too, at the same path. */
  lidarr: { url?: string; apiKey?: boolean; folder?: string; reachable?: boolean };
  slskd: { url?: string; apiKey?: boolean; files: SoulseekFiles };
  lastfm: { apiKey?: boolean };
}

export interface Person {
  id: string;
  username: string;
  name: string;
  admin: boolean;
  lastSeen?: string;
}

/**
 * One track as the apps' own players get it (the queue lives in the app, so music keeps playing
 * with the screen off). `url` already carries what's needed to play without the page.
 */
export interface NativeTrack {
  id: string;
  url: string;
  /** Automatic: the address on mobile data, when it isn't `url` (the app follows the network while the page sleeps). */
  mobileUrl?: string;
  title: string;
  artist: string;
  album: string;
  artwork?: string;
  duration: number;
  /** In the person's liked songs (the Android lock screen's heart). */
  liked?: boolean;
}

/** What the apps' players say back, whenever it changes (and about once a second while playing). */
export interface NativeAudioState {
  /** Which track of the queue (as last loaded) is playing. */
  index: number;
  /** That track's id: when it isn't the page's, the queue was set from elsewhere (the car). */
  id?: string;
  playing: boolean;
  buffering?: boolean;
  /** Seconds. */
  time: number;
  duration: number;
  /** The whole queue has played (repeat off). */
  ended?: boolean;
  error?: string;
  repeat?: 'off' | 'all' | 'one';
  /** Where the sound comes out (apps with the "outputs" feature). */
  output?: NativeOutput;
  /** The song plays from a file on the device (a download, or the queue kept ahead): the page counts the play. */
  local?: boolean;
  /** The sleep timer: stops at `at` (ms since 1970) or when the song ends. Absent when off. */
  sleep?: { at?: number; endOfSong?: boolean };
}

export interface NativeOutput {
  /** As the system names it: "AirPods Pro", "Kitchen", "Speaker". */
  name: string;
  kind: 'phone' | 'headphones' | 'bluetooth' | 'airplay' | 'cast' | 'car' | 'tv' | 'speaker';
}

// ---- Play together -------------------------------------------------------------------------------

/** What a room is playing: everyone's player follows it, and anyone can change it. */
export interface TogetherPlayback {
  queue: Track[];
  index: number;
  playing: boolean;
  /** Seconds into the song at `at`. */
  position: number;
  /** The server's clock (ms) when this was true. */
  at: number;
  action: 'start' | 'play' | 'pause' | 'seek' | 'index' | 'queue';
  /** Who did it (a name). */
  by: string;
  /** Goes up with every change. */
  rev: number;
}

export interface TogetherMember {
  clientId: string;
  username: string;
  name: string;
  /** Connected now. */
  here: boolean;
}

export interface TogetherRoom {
  id: string;
  host: string;
  hostName: string;
  title?: string;
  members: TogetherMember[];
  playback: TogetherPlayback;
}

/** The room's live line: the room as it is now, or that it has ended; `now` keeps the clocks together. */
export interface TogetherEvent {
  room?: TogetherRoom;
  ended?: boolean;
  now: number;
}

/** A room someone could join (Home). */
export interface TogetherSummary {
  id: string;
  hostName: string;
  title?: string;
  cover?: string;
  names: string[];
}

export interface TogetherControl {
  clientId: string;
  action: 'play' | 'pause' | 'seek' | 'index' | 'queue';
  position?: number;
  index?: number;
  queue?: Track[];
  playing?: boolean;
}

// ---- Downloads (the apps) -------------------------------------------------------------------------

/** Something kept on the device to play without the server: an album, a playlist, Liked songs or a song. */
export interface NativeDownload {
  /** `album:<id>`, `playlist:<id>`, `song:<id>` or `liked`. */
  id: string;
  kind: 'album' | 'playlist' | 'song' | 'liked';
  title: string;
  subtitle?: string;
  /** The cover's address on the server (with `?k=`). */
  cover?: string;
  tracks: NativeTrack[];
  /** The songs already on the device (ids). */
  ready: string[];
  /** Bytes on the device. */
  bytes: number;
  state: 'downloading' | 'waiting' | 'done' | 'failed';
  /** Offline page only: an address the app serves the cover from. */
  localCover?: string;
}

/** One of someone's devices with Tuna open, as the others see it. */
export interface Device {
  id: string;
  /** "iPhone", "Mac", "Chrome"… */
  name: string;
  kind: 'phone' | 'tablet' | 'computer' | 'tv' | 'browser';
  playing: boolean;
  track?: Track;
  /** Seconds into `track`, at `at` (server time, ms). */
  position: number;
  at: number;
  /** When it last played (server time, ms): playing now, or until it was paused. */
  played?: number;
  /** The next few songs in its queue, and what it's playing from ("Road trip"). */
  next?: Track[];
  from?: string;
}

export type DeviceCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; position: number }
  /** The music moves here: this queue, from this song and moment. */
  | { type: 'take'; queue: Track[]; index: number; position: number; playing: boolean; source?: unknown };

export interface DevicesEvent {
  now: number;
  devices?: Device[];
  command?: DeviceCommand;
}

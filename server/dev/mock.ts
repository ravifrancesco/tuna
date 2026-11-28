/**
 * A fake Navidrome, Lidarr, slskd, MusicBrainz, Cover Art Archive, LRCLIB, ListenBrainz and
 * Last.fm on port 7701, for developing Tuna without a real server or the internet. Made-up artists
 * and albums; the music is a soft tune made up on the spot from each song's id (a WAV, so every
 * player plays it); covers are gradients drawn the same way.
 *
 *   Users: demo/demo (admin), sam/sam, admin/admin (admin). Lidarr key: mock-lidarr-key.
 *   slskd (at /slskd) key: mock-slskd-key.
 *   MOCK_GET_SECONDS (default 40): how long a Get takes to "download" (a song from slskd: 8).
 *   MOCK_EMPTY_LIBRARY=1: nothing in the library yet, as a new install.
 *   MOCK_SLSKD_EMPTY=1: Soulseek finds nothing. MOCK_SLSKD_FAIL=<user>: that peer's downloads fail.
 *   MOCK_SLSKD_REFUSE=<user,…>: those peers refuse to send. MOCK_SLSKD_STUCK=<user,…>: their queues never move.
 *   MOCK_MUSIC_DIR (default tuna-mock-music in the temp folder): Lidarr's music folder, a real one: files
 *   people import go there (through Lidarr's manual import, or straight in), and Navidrome finds them.
 *   MOCK_LIDARR_ARTIST_LOOKUP_FAIL=<word,…>: only looking those artists up fails (Lidarr's album search finds them).
 *   MOCK_SLSKD_DIR (default tuna-mock-slskd in the temp folder): slskd's downloads folder, a real one.
 *   MOCK_LIDARR_ALBUMS_ONLY=1: Lidarr keeps no singles or EPs (its Standard metadata profile, as it comes).
 *   MOCK_SLSKD_BLOCK=<phrase,…>: nobody answers searches with those phrases (Soulseek's server drops some).
 *   MOCK_SLSKD_SAVE_MS (default 1500): how long after a search says it's complete its results are saved
 *   (slskd saves them last; slower on a Raspberry Pi).
 *   MOCK_SLSKD_MOVE_SECONDS (default 2): how long after a download succeeds its file is in slskd's
 *   downloads folder (taken off slskd's list before then, it never gets there, as in slskd).
 *   MOCK_LIDARR_LOOKUP_FAIL=<word,…>: Lidarr's search fails for names with those words ("Invalid response
 *   received from LidarrAPI", as its metadata server does for some), and so does looking up those artists.
 *   MOCK_MB_CROWDED=<word,…>: songs with those words are famous in MusicBrainz: 150 recordings on
 *   compilations, live albums and DJ mixes come before the one on their album, and their artists have
 *   a greatest hits ("The Hits") that Lidarr doesn't keep.
 *   MOCK_DEEZER=1: Lidarr also knows albums from Deezer, as with Tubifarry's Deezer metadata source:
 *   "Canzoni Sparse" by Valle Nera only there ("900001@deezer"; Lidarr finds Deezer artists by
 *   "deezer:<id>", or by name), and a Deezer copy of Coral Avenue's first album beside MusicBrainz's.
 *   MOCK_COVER_MS (default 0): how long each cover takes, as Navidrome resizing pictures on a Raspberry Pi.
 *   ListenBrainz token for Settings: mock-lb.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import nodePath from 'node:path';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT ?? 7701);
const GET_SECONDS = Number(process.env.MOCK_GET_SECONDS ?? 40);
const EMPTY_LIBRARY = process.env.MOCK_EMPTY_LIBRARY === '1';
const SONG_SECONDS = Number(process.env.MOCK_GET_SECONDS ?? 8);
const SLSKD_EMPTY = process.env.MOCK_SLSKD_EMPTY === '1';
const SLSKD_FAIL = process.env.MOCK_SLSKD_FAIL;
const SLSKD_REFUSE = (process.env.MOCK_SLSKD_REFUSE ?? '').split(',').filter(Boolean);
const SLSKD_STUCK = (process.env.MOCK_SLSKD_STUCK ?? '').split(',').filter(Boolean);
const SLSKD_MOVE_SECONDS = Number(process.env.MOCK_SLSKD_MOVE_SECONDS ?? 2);
const SLSKD_SAVE_MS = Number(process.env.MOCK_SLSKD_SAVE_MS ?? 1500);
const SLSKD_BLOCK = (process.env.MOCK_SLSKD_BLOCK ?? '').split(',').filter(Boolean);
const MUSIC_DIR = process.env.MOCK_MUSIC_DIR ?? nodePath.join(os.tmpdir(), 'tuna-mock-music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });
const SONG_FILE = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|wma)$/i;
const FILE_TYPES: Record<string, string> = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const COVER_MS = Number(process.env.MOCK_COVER_MS ?? 0);
const LOOKUP_FAIL = (process.env.MOCK_LIDARR_LOOKUP_FAIL ?? '').toLowerCase().split(',').filter(Boolean);
const CROWDED = (process.env.MOCK_MB_CROWDED ?? '').toLowerCase().split(',').filter(Boolean);
const crowded = (title: string) => CROWDED.some((w) => title.toLowerCase().includes(w));
const DEEZER = process.env.MOCK_DEEZER === '1';
const fromDeezer = (id: string) => id.endsWith('@deezer');
const lookupFails = (name: string) => LOOKUP_FAIL.some((w) => name.toLowerCase().includes(w));
/** MOCK_LIDARR_ARTIST_LOOKUP_FAIL=<word,…>: only looking up those artists fails (by id or by name); Lidarr's album search still finds them. */
const ARTIST_LOOKUP_FAIL = (process.env.MOCK_LIDARR_ARTIST_LOOKUP_FAIL ?? '').toLowerCase().split(',').filter(Boolean);
const artistLookupFails = (name: string) => lookupFails(name) || ARTIST_LOOKUP_FAIL.some((w) => name.toLowerCase().includes(w));

// ---- A made-up world, the same every time ------------------------------------------------------

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: string) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uuid = (s: string) => {
  const h = crypto.createHash('md5').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

const ARTISTS: Array<{ name: string; genre: string; inLibrary: boolean }> = [
  { name: 'Velvet Harbor', genre: 'Indie Rock', inLibrary: true },
  { name: 'Mira Solenne', genre: 'Pop', inLibrary: true },
  { name: 'The Paper Lanterns', genre: 'Folk', inLibrary: true },
  { name: 'Kōji Arata', genre: 'Jazz', inLibrary: true },
  { name: 'Neon Tidal', genre: 'Electronic', inLibrary: true },
  { name: 'Sable & Rye', genre: 'Soul', inLibrary: true },
  { name: 'Northbound Static', genre: 'Rock', inLibrary: true },
  { name: 'Lua Marè', genre: 'Bossa Nova', inLibrary: true },
  { name: 'Orchid Pilot', genre: 'Dream Pop', inLibrary: true },
  { name: 'Brassline Collective', genre: 'Funk', inLibrary: true },
  { name: 'Ada Wren', genre: 'Singer-Songwriter', inLibrary: true },
  { name: 'Glass Atlas', genre: 'Ambient', inLibrary: true },
  { name: 'Coral Avenue', genre: 'Indie Rock', inLibrary: false },
  { name: 'Hollow Pines', genre: 'Folk', inLibrary: false },
  { name: 'Pulse Meridian', genre: 'Electronic', inLibrary: false },
  { name: 'June Calloway', genre: 'Pop', inLibrary: false },
];

const WORDS_A = ['Midnight', 'Golden', 'Paper', 'Silver', 'Quiet', 'Electric', 'Distant', 'Velvet', 'Hidden', 'Northern', 'Summer', 'Glass', 'Wild', 'Slow', 'Blue', 'Neon', 'Salt', 'Lunar', 'Hollow', 'Bright'];
const WORDS_B = ['Rivers', 'Hours', 'Lights', 'Tides', 'Letters', 'Gardens', 'Highways', 'Echoes', 'Windows', 'Satellites', 'Harbors', 'Mornings', 'Shadows', 'Fields', 'Signals', 'Oceans', 'Rooms', 'Waves', 'Skies', 'Stories'];
const SONG_A = ['Hold', 'Find', 'Carry', 'Follow', 'Leave', 'Call', 'Dance', 'Run', 'Wait', 'Fall', 'Breathe', 'Drive', 'Remember', 'Forget', 'Wake', 'Sing'];
const SONG_B = ['Me Home', 'the Light', 'Your Name', 'the Water', 'It Slow', 'All Night', 'the Line', 'Back', 'Through', 'With Me', 'Away', 'On', 'the Fire', 'Me Down', 'Again', 'Forever'];
const LYRIC = [
  'I left the window open for the night',
  'the city hums a song I used to know',
  'we were running out of summer',
  'every light along the river',
  'hold on, hold on',
  'say it like you mean it',
  'the radio is playing something new',
  'and I still feel the tide',
  'carry me home tonight',
  'we never learned to wait',
  'paper boats and silver rain',
  'call my name across the water',
];

interface MTrack {
  id: string;
  title: string;
  albumId: string;
  album: string;
  artistId: string;
  artist: string;
  track: number;
  disc: number;
  year: number;
  genre: string;
  duration: number;
  mbid: string;
  hasLyrics: boolean;
  /** Lidarr's ids for the song and, when it has one, its file. */
  lidarrId: number;
  fileId?: number;
  /** In an album not wholly in the library: Navidrome has scanned this song's file. */
  scanned?: boolean;
  /** Lidarr added or removed its file; Navidrome hasn't scanned since. */
  changed?: number;
  /** A real file in the music folder (one someone imported): played as it is. */
  file?: string;
}
interface MAlbum {
  id: string;
  name: string;
  artistId: string;
  artist: string;
  year: number;
  genre: string;
  mbid: string;
  type: 'Album' | 'EP' | 'Single';
  inLibrary: boolean;
  /** Lidarr has filed it in the music folder; Navidrome hasn't scanned it yet. */
  filed?: number;
  created: string;
  tracks: MTrack[];
  lidarrId: number;
  /** A real cover next to its files (cover.jpg). */
  cover?: string;
}
interface MArtist {
  id: string;
  name: string;
  genre: string;
  mbid: string;
  inLibrary: boolean;
  albums: MAlbum[];
  lidarrId?: number;
}

const artists: MArtist[] = [];
const albums = new Map<string, MAlbum>();
const tracks = new Map<string, MTrack>();
const [everyArtist, everyAlbum, everyTrack] = [artists, albums, tracks];
// Lidarr's ids are kept apart (albums from 1, releases from 1001, songs from 10001, files from
// 50001), so mixing them up shows.
let nextLidarrAlbum = 1;
let nextLidarrTrack = 10001;
let nextTrackFile = 50001;
const releaseId = (a: MAlbum) => 1000 + a.lidarrId;

for (const [ai, a] of ARTISTS.entries()) {
  const r = rng(a.name);
  const artist: MArtist = { id: `ar${ai + 1}`, name: a.name, genre: a.genre, mbid: uuid(`artist:${a.name}`), inLibrary: a.inLibrary, albums: [] };
  const count = 3 + Math.floor(r() * 3);
  for (let n = 0; n < count; n++) {
    const type: MAlbum['type'] = n === count - 1 ? 'Single' : n === count - 2 && r() < 0.5 ? 'EP' : 'Album';
    const name = type === 'Single' ? `${pick(r, SONG_A)} ${pick(r, SONG_B)}` : `${pick(r, WORDS_A)} ${pick(r, WORDS_B)}`;
    const id = `al${ai + 1}-${n + 1}`;
    // In the library: most albums of library artists; the newest one or two are only "out there".
    const inLibrary = a.inLibrary && (n < count - 2 || (n === count - 2 && r() < 0.4)) && !EMPTY_LIBRARY;
    const year = 2008 + n * 3 + Math.floor(r() * 3);
    const album: MAlbum = {
      id,
      name,
      artistId: artist.id,
      artist: a.name,
      year,
      genre: a.genre,
      mbid: uuid(`album:${a.name}:${name}`),
      type,
      inLibrary,
      created: new Date(Date.now() - (count - n) * 9 * 86400_000 - Math.floor(r() * 5) * 86400_000).toISOString(),
      tracks: [],
      lidarrId: nextLidarrAlbum++,
    };
    const songs = type === 'Single' ? 2 : type === 'EP' ? 4 + Math.floor(r() * 2) : 8 + Math.floor(r() * 5);
    for (let s = 0; s < songs; s++) {
      const title = s === 0 && type === 'Single' ? name : `${pick(r, SONG_A)} ${pick(r, SONG_B)}`;
      const t: MTrack = {
        id: `${id}-t${s + 1}`,
        title,
        albumId: id,
        album: name,
        artistId: artist.id,
        artist: a.name,
        track: s + 1,
        disc: 1,
        year,
        genre: a.genre,
        duration: 140 + Math.floor(r() * 160),
        mbid: uuid(`rec:${a.name}:${name}:${s}`),
        hasLyrics: s % 3 === 0,
        lidarrId: nextLidarrTrack++,
        fileId: inLibrary ? nextTrackFile++ : undefined,
      };
      album.tracks.push(t);
      tracks.set(t.id, t);
    }
    artist.albums.push(album);
    albums.set(id, album);
  }
  artists.push(artist);
}

// Albums only Deezer has (MOCK_DEEZER): Lidarr knows them, MusicBrainz doesn't.
if (DEEZER) {
  const deezerAlbum = (artist: MArtist, name: string, n: number, songs: string[]) => {
    const id = `dz${n}`;
    const album: MAlbum = { id, name, artistId: artist.id, artist: artist.name, year: 2024, genre: artist.genre, mbid: `${900000 + n}@deezer`, type: 'Album', inLibrary: false, created: new Date().toISOString(), tracks: [], lidarrId: nextLidarrAlbum++ };
    songs.forEach((title, i) => {
      const t: MTrack = { id: `${id}-t${i + 1}`, title, albumId: id, album: name, artistId: artist.id, artist: artist.name, track: i + 1, disc: 1, year: 2024, genre: artist.genre, duration: 150 + i * 17, mbid: `${910000 + n * 100 + i}@deezer`, hasLyrics: false, lidarrId: nextLidarrTrack++ };
      album.tracks.push(t);
      tracks.set(t.id, t);
    });
    artist.albums.push(album);
    albums.set(id, album);
  };
  const valle: MArtist = { id: 'ardz1', name: 'Valle Nera', genre: 'Indie', mbid: '700001@deezer', inLibrary: false, albums: [] };
  deezerAlbum(valle, 'Canzoni Sparse', 1, ['Luce di Marzo', 'Strade Vuote', 'Il Mare Dentro', 'Ancora Qui', 'Notte Lunga']);
  artists.push(valle);
  const coral = artists.find((a) => a.name === 'Coral Avenue');
  if (coral) {
    const twin: MArtist = { id: 'ardz2', name: coral.name, genre: coral.genre, mbid: '700002@deezer', inLibrary: false, albums: [] };
    deezerAlbum(twin, coral.albums[0].name, 2, coral.albums[0].tracks.map((t) => t.title));
    artists.push(twin);
  }
}

/** What Navidrome has of an album: all of it, or the songs got one at a time that it has scanned. */
const isPresent = (t: MTrack) => albums.get(t.albumId)!.inLibrary || Boolean(t.scanned);
const present = (a: MAlbum) => a.tracks.filter(isPresent);
const libArtists = () => artists.filter((a) => a.albums.some((al) => present(al).length));
const libAlbums = () => [...albums.values()].filter((a) => present(a).length);
const libTracks = () => libAlbums().flatMap(present);

// ---- People and their listening ----------------------------------------------------------------

interface User {
  id: string;
  userName: string;
  name: string;
  password: string;
  isAdmin: boolean;
  starred: Map<string, string>;
  plays: Map<string, number>;
  played: Map<string, string>;
}
const users: User[] = [
  { id: 'u1', userName: 'demo', name: 'Demo', password: 'demo', isAdmin: true, starred: new Map(), plays: new Map(), played: new Map() },
  { id: 'u2', userName: 'sam', name: 'Sam', password: 'sam', isAdmin: false, starred: new Map(), plays: new Map(), played: new Map() },
  { id: 'u3', userName: 'admin', name: 'Admin', password: 'admin', isAdmin: true, starred: new Map(), plays: new Map(), played: new Map() },
];
const jwts = new Map<string, User>();

for (const u of EMPTY_LIBRARY ? [] : users.slice(0, 2)) {
  const r = rng(`listens:${u.userName}`);
  const lib = libTracks();
  for (let i = 0; i < 260; i++) {
    const t = pick(r, lib.slice(0, Math.floor(lib.length * (0.3 + r() * 0.7))));
    u.plays.set(t.id, (u.plays.get(t.id) ?? 0) + 1);
    u.played.set(t.albumId, new Date(Date.now() - Math.floor(r() * 30) * 86400_000).toISOString());
  }
  for (let i = 0; i < 24; i++) u.starred.set(pick(r, lib).id, new Date(Date.now() - i * 3600_000).toISOString());
  u.starred.set(pick(r, libAlbums()).id, new Date().toISOString());
  u.starred.set(pick(r, libArtists()).id, new Date().toISOString());
}

interface MPlaylist {
  id: string;
  name: string;
  owner: string;
  songs: string[];
  created: string;
}
const playlists: MPlaylist[] = [];
if (!EMPTY_LIBRARY) {
  const r = rng('playlists');
  const lib = libTracks();
  for (const [owner, name, n] of [
    ['demo', 'Road trip', 18],
    ['demo', 'Focus', 14],
    ['sam', 'Sunday morning', 12],
  ] as const) {
    playlists.push({ id: `pl${playlists.length + 1}`, name, owner, songs: Array.from({ length: n }, () => pick(r, lib).id), created: new Date().toISOString() });
  }
}

// ---- Subsonic shapes ---------------------------------------------------------------------------

const albumPlays = (u: User, a: MAlbum) => a.tracks.reduce((n, t) => n + (u.plays.get(t.id) ?? 0), 0);

const child = (u: User, t: MTrack) => ({
  id: t.id,
  parent: t.albumId,
  isDir: false,
  title: t.title,
  album: t.album,
  artist: t.artist,
  albumId: t.albumId,
  artistId: t.artistId,
  track: t.track,
  discNumber: t.disc,
  year: t.year,
  genre: t.genre,
  coverArt: `al-${t.albumId}`,
  duration: t.duration,
  bitRate: t.file ? Math.round((fs.statSync(t.file, { throwIfNoEntry: false })?.size ?? 0) / Math.max(1, t.duration) / 125) : 352,
  suffix: t.file ? nodePath.extname(t.file).slice(1) : 'wav',
  contentType: t.file ? (FILE_TYPES[nodePath.extname(t.file).toLowerCase()] ?? 'application/octet-stream') : 'audio/wav',
  size: t.file ? (fs.statSync(t.file, { throwIfNoEntry: false })?.size ?? 0) : 44 + t.duration * RATE * 2,
  playCount: u.plays.get(t.id) ?? 0,
  starred: u.starred.get(t.id),
  musicBrainzId: t.mbid,
  type: 'music',
});

const albumId3 = (u: User, a: MAlbum, withSongs = false) => {
  const songs = present(a);
  return {
    id: a.id,
    name: a.name,
    artist: a.artist,
    artistId: a.artistId,
    coverArt: `al-${a.id}`,
    songCount: songs.length,
    duration: songs.reduce((n, t) => n + t.duration, 0),
    year: a.year,
    genre: a.genre,
    created: a.created,
    playCount: albumPlays(u, a),
    played: u.played.get(a.id),
    starred: u.starred.get(a.id),
    musicBrainzId: a.mbid,
    ...(withSongs ? { song: songs.map((t) => child(u, t)) } : {}),
  };
};

const artistId3 = (u: User, a: MArtist, withAlbums = false) => {
  const own = a.albums.filter((x) => present(x).length);
  return {
    id: a.id,
    name: a.name,
    coverArt: `ar-${a.id}`,
    albumCount: own.length,
    starred: u.starred.get(a.id),
    musicBrainzId: a.mbid,
    ...(withAlbums ? { album: own.map((x) => albumId3(u, x)) } : {}),
  };
};

const playlistInfo = (u: User, p: MPlaylist, withEntries = false) => {
  const entries = p.songs.map((id) => tracks.get(id)).filter((t): t is MTrack => Boolean(t));
  return {
    id: p.id,
    name: p.name,
    owner: p.owner,
    public: true,
    songCount: entries.length,
    duration: entries.reduce((n, t) => n + t.duration, 0),
    created: p.created,
    changed: p.created,
    coverArt: `pl-${p.id}`,
    ...(withEntries ? { entry: entries.map((t) => child(u, t)) } : {}),
  };
};

// ---- Sound: a soft tune for each song, any byte range ------------------------------------------

const RATE = 22050;
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];

function wavHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

function tune(t: MTrack) {
  const r = rng(`tune:${t.id}`);
  const base = 196 * 2 ** (Math.floor(r() * 7) / 12);
  const noteLen = Math.floor(RATE * (0.28 + r() * 0.25));
  const melody = Array.from({ length: 16 }, () => pick(r, SCALE));
  // Like a real song, it gets louder and softer: a quiet start, verses and choruses, a fade-out.
  const section = 18 + Math.floor(r() * 16);
  const shape = Array.from({ length: 16 }, (_, k) => (k === 0 ? 0.35 : 0.45 + r() * 0.55));
  return (i: number) => {
    const n = Math.floor(i / noteLen);
    const pos = (i % noteLen) / noteLen;
    const f = base * 2 ** (melody[n % 16] / 12);
    const env = Math.min(1, pos * 20) * (1 - pos) ** 1.5;
    const sec = i / RATE;
    const song = shape[Math.floor(sec / section) % 16] * Math.min(1, sec / 6) * Math.min(1, (t.duration - sec) / 10);
    const x = (2 * Math.PI * f * i) / RATE;
    return 0.22 * song * env * (Math.sin(x) + 0.3 * Math.sin(2 * x));
  };
}

/** A real file, as it is (with ranges, as Navidrome). */
function streamFile(file: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const total = fs.statSync(file).size;
  const type = FILE_TYPES[nodePath.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const m = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  const start = m ? (m[1] ? Number(m[1]) : total - Number(m[2])) : 0;
  const end = m && m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  res.writeHead(m ? 206 : 200, { 'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}) });
  fs.createReadStream(file, { start, end }).pipe(res);
}

function streamSong(t: MTrack, req: http.IncomingMessage, res: http.ServerResponse) {
  if (t.file && fs.existsSync(t.file)) return streamFile(t.file, req, res);
  const dataBytes = t.duration * RATE * 2;
  const total = 44 + dataBytes;
  const m = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  let start = 0;
  let end = total - 1;
  if (m) {
    start = m[1] ? Number(m[1]) : total - Number(m[2]);
    end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    res.writeHead(206, { 'content-type': 'audio/wav', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${total}`, 'accept-ranges': 'bytes' });
  } else {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': total, 'accept-ranges': 'bytes' });
  }
  const header = wavHeader(dataBytes);
  const sample = tune(t);
  let pos = start;
  const pump = () => {
    while (pos <= end) {
      const chunkEnd = Math.min(end, pos + 64 * 1024 - 1);
      const buf = Buffer.alloc(chunkEnd - pos + 1);
      for (let off = pos; off <= chunkEnd; off++) {
        if (off < 44) buf[off - pos] = header[off];
        else {
          const i = (off - 44) >> 1;
          const v = Math.max(-32768, Math.min(32767, Math.round(sample(i) * 32767)));
          buf[off - pos] = (off - 44) & 1 ? (v >> 8) & 0xff : v & 0xff;
        }
      }
      pos = chunkEnd + 1;
      if (!res.write(buf)) return res.once('drain', pump);
    }
    res.end();
  };
  pump();
}

// ---- Covers: gradients as PNGs --------------------------------------------------------------------

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

const covers = new Map<string, Buffer>();
function coverPng(key: string, size: number, round = false): Buffer {
  const id = `${key}:${size}:${round}`;
  const hit = covers.get(id);
  if (hit) return hit;
  const r = rng(`cover:${key}`);
  const hsl = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const h1 = r() * 360;
  const c1 = hsl(h1, 0.55, 0.55);
  const c2 = hsl((h1 + 40 + r() * 120) % 360, 0.6, 0.25);
  const cx = 0.3 + r() * 0.4;
  const cy = 0.3 + r() * 0.4;
  const rad = 0.18 + r() * 0.2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const t = (u + v) / 2;
      let col = [0, 1, 2].map((i) => c1[i] * (1 - t) + c2[i] * t);
      const d = Math.hypot(u - cx, v - cy);
      if (d < rad) col = col.map((c) => c + (255 - c) * 0.22);
      else if (d < rad + 0.012) col = col.map((c) => c + (255 - c) * 0.4);
      if (round && Math.hypot(u - 0.5, v - 0.5) > 0.5) col = [24, 20, 32];
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  covers.set(id, png);
  return png;
}

// ---- Lidarr's side ---------------------------------------------------------------------------------

interface Download {
  albumId: string;
  started: number;
  size: number;
}
const downloads: Download[] = [];
const monitored = new Set<string>();

function tickDownloads() {
  // Finished downloads land in slskd's downloads folder: a few seconds of the song's tune.
  for (const x of onDisk()) {
    if (x.landed) continue;
    x.landed = true;
    fs.mkdirSync(nodePath.dirname(localPath(x)), { recursive: true });
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + (x.n % 9) * 40}:duration=5`, localPath(x)]);
    } catch {
      fs.writeFileSync(localPath(x), Buffer.concat([wavHeader(5 * RATE * 2), Buffer.alloc(5 * RATE * 2)]));
    }
  }
  for (const d of [...downloads]) {
    if (Date.now() - d.started >= GET_SECONDS * 1000) {
      const a = albums.get(d.albumId)!;
      a.filed = Date.now();
      for (const t of a.tracks) t.fileId ??= nextTrackFile++;
      downloads.splice(downloads.indexOf(d), 1);
      console.log(`mock lidarr: "${a.name}" by ${a.artist} is in the music folder; Navidrome sees it when it scans`);
    }
  }
  // As Navidrome's own scheduled scan, for when nobody asks for one.
  for (const a of albums.values()) if (a.filed && Date.now() - a.filed > 5 * 60_000) scanned(a);
  for (const t of tracks.values()) if (t.changed && Date.now() - t.changed > 5 * 60_000) scannedSong(t);
}
function scanned(a: MAlbum) {
  a.filed = undefined;
  a.inLibrary = true;
  a.created = new Date().toISOString();
  console.log(`mock navidrome: "${a.name}" by ${a.artist} is in the library now`);
}
/** One song whose file came or went, in an album Navidrome sees song by song. */
function scannedSong(t: MTrack) {
  const a = albums.get(t.albumId)!;
  t.changed = undefined;
  if (a.inLibrary || Boolean(t.scanned) === (t.fileId !== undefined)) return;
  if (!present(a).length) a.created = new Date().toISOString();
  t.scanned = t.fileId !== undefined;
  console.log(`mock navidrome: "${t.title}" by ${t.artist} is ${t.scanned ? 'in' : 'out of'} the library now`);
}
function scan() {
  for (const a of albums.values()) if (a.filed) scanned(a);
  for (const t of tracks.values()) if (t.changed) scannedSong(t);
  scanFolder();
}

/** Files put straight into the music folder (not through Lidarr): Navidrome finds them by their tags. */
function scanFolder() {
  const known = new Set([...tracks.values()].map((t) => t.file).filter(Boolean));
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name.startsWith('.') ? [] : d.isDirectory() ? walk(nodePath.join(dir, d.name)) : SONG_FILE.test(d.name) ? [nodePath.join(dir, d.name)] : []));
  for (const file of walk(MUSIC_DIR)) {
    if (known.has(file)) continue;
    let tags: Record<string, string> = {};
    let duration = 0;
    try {
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', file], { encoding: 'utf8' })) as { format?: { duration?: string; tags?: Record<string, string> } };
      tags = Object.fromEntries(Object.entries(probe.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      duration = Math.round(Number(probe.format?.duration) || 0);
    } catch {
      /* no ffprobe: by its folders */
    }
    const parts = nodePath.relative(MUSIC_DIR, file).split(nodePath.sep);
    const title = tags.title ?? nodePath.basename(file).replace(/\.[^.]+$/, '');
    const artistName = tags.album_artist ?? tags.artist ?? parts.at(-3) ?? 'Unknown artist';
    const albumName = tags.album ?? parts.at(-2) ?? title;
    let artist = artists.find((x) => x.name.toLowerCase() === artistName.toLowerCase());
    if (!artist) artists.push((artist = { id: `arf${artists.length + 1}`, name: artistName, genre: 'Other', mbid: uuid(`artist:${artistName}`), inLibrary: true, albums: [] }));
    let album = artist.albums.find((x) => x.name.toLowerCase() === albumName.toLowerCase());
    if (!album) {
      album = { id: `alf${albums.size + 1}`, name: albumName, artistId: artist.id, artist: artist.name, year: new Date().getFullYear(), genre: artist.genre, mbid: uuid(`album:${artist.name}:${albumName}`), type: 'Album', inLibrary: false, created: new Date().toISOString(), tracks: [], lidarrId: nextLidarrAlbum++ };
      artist.albums.push(album);
      albums.set(album.id, album);
    }
    const cover = fs.readdirSync(nodePath.dirname(file)).find((f) => /^(cover|folder)\.(jpe?g|png|webp)$/i.test(f));
    if (cover) album.cover = nodePath.join(nodePath.dirname(file), cover);
    let t = album.tracks.find((x) => x.title.toLowerCase() === title.toLowerCase());
    if (!t) {
      t = { id: `${album.id}-t${album.tracks.length + 1}`, title, albumId: album.id, album: album.name, artistId: artist.id, artist: tags.artist ?? artist.name, track: album.tracks.length + 1, disc: 1, year: album.year, genre: album.genre, duration: duration || 180, mbid: uuid(`rec:${file}`), hasLyrics: false, lidarrId: nextLidarrTrack++ };
      album.tracks.push(t);
      tracks.set(t.id, t);
    }
    Object.assign(t, { file, fileId: t.fileId ?? nextTrackFile++, scanned: true, changed: undefined, duration: duration || t.duration });
    console.log(`mock navidrome: "${t.title}" by ${t.artist} (a file in the music folder) is in the library now`);
  }
}
/** Lidarr deletes one song's file: from then on Navidrome sees its album song by song. */
function unfile(t: MTrack) {
  const a = albums.get(t.albumId)!;
  if (a.inLibrary || a.filed) {
    for (const x of a.tracks) Object.assign(x, { scanned: a.inLibrary, changed: a.filed });
    a.inLibrary = false;
    a.filed = undefined;
  }
  t.fileId = undefined;
  t.changed = Date.now();
  console.log(`mock lidarr: deleted the file of "${t.title}" by ${t.artist}; Navidrome drops it when it scans`);
}
setInterval(tickDownloads, 1000);

const lidarrAlbum = (a: MAlbum) => {
  const artist = artists.find((x) => x.id === a.artistId)!;
  const files = a.tracks.filter((t) => t.fileId !== undefined).length;
  return {
    id: a.lidarrId,
    title: a.name,
    foreignAlbumId: a.mbid,
    artistId: artist.lidarrId ?? 0,
    monitored: monitored.has(a.id),
    albumType: a.type,
    releaseDate: `${a.year}-05-01T00:00:00Z`,
    artist: { id: artist.lidarrId ?? 0, artistName: artist.name, foreignArtistId: artist.mbid },
    // Its cover from its source, as Lidarr has it (Deezer's albums: Deezer's picture).
    images: fromDeezer(a.mbid) ? [{ coverType: 'cover', remoteUrl: `http://127.0.0.1:${PORT}/deezer/album/${a.mbid.replace('@deezer', '')}/image` }] : [],
    releases: [
      {
        id: releaseId(a),
        albumId: a.lidarrId,
        foreignReleaseId: uuid(`release:${a.mbid}`),
        title: a.name,
        trackCount: a.tracks.length,
        duration: a.tracks.reduce((n, t) => n + t.duration * 1000, 0),
        monitored: true,
      },
    ],
    statistics: {
      trackFileCount: files,
      trackCount: a.tracks.length,
      totalTrackCount: a.tracks.length,
      percentOfTracks: Math.round((100 * files) / a.tracks.length),
    },
  };
};
const lidarrTrack = (t: MTrack) => {
  const a = albums.get(t.albumId)!;
  return {
    id: t.lidarrId,
    artistId: artists.find((x) => x.id === t.artistId)!.lidarrId ?? 0,
    albumId: a.lidarrId,
    albumReleaseId: releaseId(a),
    foreignTrackId: uuid(`track:${t.mbid}`),
    foreignRecordingId: t.mbid,
    title: t.title,
    trackNumber: String(t.track),
    absoluteTrackNumber: t.track,
    mediumNumber: t.disc,
    duration: t.duration * 1000,
    hasFile: t.fileId !== undefined,
    trackFileId: t.fileId ?? 0,
  };
};
interface Command {
  id: number;
  name: string;
  status: 'queued' | 'completed' | 'failed';
  message?: string;
  queued: string;
  ended?: string;
  body: Record<string, unknown>;
}
const commands = new Map<number, Command>();
let nextCommand = 1;

/** Lidarr's ManualImport: each file into the album and songs it's told. Says what went wrong, if anything. */
function manualImport(files: Array<{ path?: string; artistId?: number; albumId?: number; albumReleaseId?: number; trackIds?: number[] }>) {
  const problems: string[] = files.length ? [] : ['No files to import'];
  for (const f of files) {
    const a = [...albums.values()].find((x) => x.lidarrId === f.albumId);
    const artist = a && artists.find((x) => x.id === a.artistId);
    const songs = (f.trackIds ?? []).map((id) => a?.tracks.find((t) => t.lidarrId === id));
    const real = Boolean(f.path?.startsWith(`${MUSIC_DIR}/`) && fs.existsSync(f.path));
    if (!real && !onDisk().some((x) => localPath(x) === f.path)) problems.push(`Not a finished download: ${f.path}`);
    else if (!a || !artist) problems.push(`Album ${f.albumId} not found`);
    else if (!artist.lidarrId || artist.lidarrId !== f.artistId) problems.push(`Artist ${f.artistId} not found (add ${artist.name} to Lidarr first)`);
    else if (f.albumReleaseId !== releaseId(a)) problems.push(`Release ${f.albumReleaseId} is not one of "${a.name}"`);
    else if (!songs.length || songs.some((t) => !t)) problems.push(`Tracks ${f.trackIds} are not all on "${a.name}"`);
    else {
      for (const x of transfers) if (localPath(x) === f.path) x.imported = true;
      // A real file: moved into the artist's folder, as Lidarr does.
      let file: string | undefined;
      if (real) {
        const dir = nodePath.join(MUSIC_DIR, artist.name, `${a.name} (${a.year})`);
        fs.mkdirSync(dir, { recursive: true });
        file = nodePath.join(dir, `${String(songs[0]!.track).padStart(2, '0')} - ${songs[0]!.title}${nodePath.extname(f.path!)}`);
        fs.renameSync(f.path!, file);
      }
      for (const t of songs as MTrack[]) Object.assign(t, { fileId: nextTrackFile++, changed: Date.now(), file });
      console.log(`mock lidarr: imported ${f.path} into "${a.name}" by ${a.artist}; Navidrome sees it when it scans`);
    }
  }
  return problems.join('; ') || undefined;
}
const lidarrArtist = (a: MArtist) => ({ id: a.lidarrId ?? 0, artistName: a.name, foreignArtistId: a.mbid, monitored: true, disambiguation: '' });
let nextLidarrArtist = 1;

// ---- slskd's side: Soulseek searches and downloads -------------------------------------------------

/** slskd's downloads folder, a real one: finished downloads land there as (short) sound files. */
const DOWNLOADS = process.env.MOCK_SLSKD_DIR ?? nodePath.join(os.tmpdir(), 'tuna-mock-slskd');
fs.mkdirSync(DOWNLOADS, { recursive: true });
/** MOCK_LIDARR_ALBUMS_ONLY=1: Lidarr keeps no singles or EPs (its Standard metadata profile, as it comes). */
const ALBUMS_ONLY = process.env.MOCK_LIDARR_ALBUMS_ONLY === '1';
const kept = (a: MAlbum) => !ALBUMS_ONLY || a.type === 'Album';
const PEERS = ['vinyl_ghost', 'flacmeister', 'nightbus', 'tapehiss', 'cratedigger77', 'lunar.kev', 'oddsocks', 'basement_tapes', 'mp3owl', 'soulseeker'];
const ROOTS = ['Music', 'Shared\\Music', 'Downloads\\Soulseek'];

interface Search {
  id: string;
  searchText: string;
  token: number;
  started: number;
}
const searches = new Map<string, Search>();
let nextSearch = 1;

interface Transfer {
  id: string;
  n: number;
  username: string;
  filename: string;
  size: number;
  requested: number;
  cancelled?: number;
  /** When it was taken off slskd's list. */
  removed?: number;
  imported?: boolean;
  /** Its file is in the downloads folder. */
  landed?: boolean;
}
const transfers: Transfer[] = [];

const words = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Who on Soulseek has the songs a search names: 2–4 people for each song with every word asked for in its path, as Soulseek. */
function peersFor(text: string) {
  const asked = words(text);
  const blocked = SLSKD_BLOCK.some((p) => ` ${asked.join(' ')} `.includes(` ${words(p).join(' ')} `));
  const found = SLSKD_EMPTY || blocked || !asked.length ? [] : [...tracks.values()].filter((t) => asked.every((w) => words(`${t.artist} ${t.album} ${t.title}`).includes(w)));
  const byUser = new Map<string, Array<Record<string, unknown>>>();
  for (const t of found) {
    const r = rng(`peers:${t.id}`);
    const a = albums.get(t.albumId)!;
    const count = 2 + Math.floor(r() * 3);
    const first = Math.floor(r() * PEERS.length);
    // Sometimes one of them has another version (an edit, a live take).
    const other = r() < 0.5 ? Math.floor(r() * count) : -1;
    for (let k = 0; k < count; k++) {
      const flac = r() < 0.6;
      // Some FLACs are hi-res (24-bit, 96 kHz: about 25 MB a minute), as vinyl rips often are.
      const hires = flac && rng(`hires:${t.id}:${k}`)() < 0.4;
      const length = t.duration + (k === other ? (r() < 0.5 ? -1 : 1) * (25 + Math.floor(r() * 60)) : 0);
      const folder = `${pick(r, ROOTS)}\\${t.artist}\\${a.name} (${a.year}) [${hires ? '24-96 FLAC' : flac ? 'FLAC' : 'MP3 320'}]`;
      const username = PEERS[(first + k * 3) % PEERS.length];
      const cd = flac ? 100_000 + Math.floor(r() * 40_000) : 0;
      byUser.set(username, [
        ...(byUser.get(username) ?? []),
        {
          filename: `${folder}\\${String(t.track).padStart(2, '0')} - ${t.title}.${flac ? 'flac' : 'mp3'}`,
          size: hires ? length * 420_000 : flac ? length * cd : length * 40_000 + 4096,
          ...(hires ? { bitDepth: 24, sampleRate: 96000 } : flac ? { bitDepth: 16, sampleRate: 44100 } : { bitRate: 320 }),
          length,
          extension: flac ? 'flac' : 'mp3',
          isLocked: false,
        },
      ]);
    }
  }
  return [...byUser].map(([username, files]) => {
    const r = rng(`peer:${username}`);
    const free = r() < 0.6;
    return { username, fileCount: files.length, files, hasFreeUploadSlot: free, queueLength: free ? 0 : 1 + Math.floor(r() * 40), uploadSpeed: 60_000 + Math.floor(r() * 4_000_000), lockedFileCount: 0, lockedFiles: [] };
  });
}

/**
 * A search is "in progress" for a moment and then has found what it found. As slskd: it says it's
 * complete (with its counts) a moment before what came back is saved; `endedAt` marks that.
 */
function searchView(s: Search, withResponses = false) {
  const done = Date.now() - s.started >= 1500;
  const saved = Date.now() - s.started >= 1500 + SLSKD_SAVE_MS;
  const responses = done ? peersFor(s.searchText) : [];
  return {
    id: s.id,
    searchText: s.searchText,
    token: s.token,
    state: done ? 'Completed, TimedOut' : 'InProgress',
    isComplete: done,
    startedAt: new Date(s.started).toISOString(),
    endedAt: saved ? new Date(s.started + 1500 + SLSKD_SAVE_MS).toISOString() : undefined,
    responseCount: responses.length,
    fileCount: responses.reduce((n, x) => n + x.fileCount, 0),
    lockedFileCount: 0,
    responses: withResponses && saved ? responses : [],
  };
}

/**
 * When a download stops: queued by the other side for 2 seconds, then SONG_SECONDS of downloading (a
 * failing peer gives up halfway; one that refuses says so after a second; a stuck queue never moves).
 */
const ends = (x: Transfer) =>
  SLSKD_STUCK.includes(x.username) ? Infinity : SLSKD_REFUSE.includes(x.username) ? x.requested + 1000 : x.requested + 2000 + (x.username === SLSKD_FAIL ? 500 : 1000) * SONG_SECONDS;

function transferView(x: Transfer) {
  const whole = SONG_SECONDS * 1000;
  const start = x.requested + 2000;
  const end = ends(x);
  const refuses = SLSKD_REFUSE.includes(x.username);
  const waits = refuses || SLSKD_STUCK.includes(x.username);
  const stopped = x.cancelled !== undefined && x.cancelled < end && Date.now() >= x.cancelled;
  const now = stopped ? x.cancelled! : Date.now();
  const done = waits ? 0 : Math.max(0, Math.min(now, end) - start) / whole;
  const bytes = Math.round(x.size * done);
  const state = stopped
    ? 'Completed, Cancelled'
    : refuses && now >= end
      ? 'Completed, Rejected'
      : now < start || waits
        ? 'Queued, Remotely'
        : now < end
          ? 'InProgress'
          : x.username === SLSKD_FAIL
            ? 'Completed, Errored'
            : 'Completed, Succeeded';
  return {
    id: x.id,
    username: x.username,
    direction: 'Download',
    filename: x.filename,
    size: x.size,
    state,
    requestedAt: new Date(x.requested).toISOString(),
    enqueuedAt: new Date(x.requested + 200).toISOString(),
    startedAt: now >= start && !waits ? new Date(start).toISOString() : undefined,
    endedAt: state.startsWith('Completed') ? new Date(Math.min(now, end)).toISOString() : undefined,
    bytesTransferred: bytes,
    averageSpeed: now >= start ? x.size / SONG_SECONDS : 0,
    bytesRemaining: x.size - bytes,
    percentComplete: 100 * done,
    ...(state === 'Completed, Errored' ? { exception: 'Remote connection closed' } : {}),
    ...(state === 'Completed, Rejected' ? { exception: 'Overwhelmed with requests; try again later' } : {}),
  };
}

/** Where slskd puts a download: its folder (the last one of the remote path) in the downloads folder. */
const localPath = (x: Transfer) => [DOWNLOADS, ...x.filename.split(/[\\/]/).slice(-2)].join('/');
/**
 * Files slskd has finished and Lidarr hasn't imported yet: in the downloads folder SLSKD_MOVE_SECONDS
 * after the download succeeded (slskd forgetting a transfer after that leaves its file; before, the
 * file stays in its incomplete folder).
 */
const onDisk = () =>
  transfers.filter((x) => {
    const lands = ends(x) + SLSKD_MOVE_SECONDS * 1000;
    return !x.imported && transferView(x).state === 'Completed, Succeeded' && Date.now() >= lands && !(x.removed !== undefined && x.removed < lands);
  });

// ---- MusicBrainz shapes ----------------------------------------------------------------------------

const mbGroup = (a: MAlbum, score?: number) => ({
  id: a.mbid,
  title: a.name,
  'primary-type': a.type,
  'secondary-types': [],
  'first-release-date': `${a.year}-05-01`,
  'artist-credit': [{ name: a.artist, artist: { id: artists.find((x) => x.id === a.artistId)!.mbid, name: a.artist } }],
  ...(score !== undefined ? { score } : {}),
});

/** A song's code (ISRC), made up from its id: what Exportify's files and MusicBrainz have. */
const isrcOf = (t: MTrack) => `QZMCK${String(parseInt(crypto.createHash('md5').update(t.mbid).digest('hex').slice(0, 8), 16) % 10_000_000).padStart(7, '0')}`;

/** A famous artist's greatest hits (MOCK_MB_CROWDED): in MusicBrainz, not in Lidarr. */
const theHits = (a: MAlbum) => ({ id: uuid(`hits:${a.artist}`), title: 'The Hits', 'primary-type': 'Album', 'secondary-types': ['Compilation'] });

const cleanQuery = (q: string) =>
  q
    .replace(/\\(.)/g, '$1')
    .replace(/^\w+:/, '')
    .replace(/"/g, '')
    .trim()
    .toLowerCase();

const score = (name: string, q: string) => {
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 90;
  if (n.includes(q)) return 75;
  return q.split(/\s+/).every((w) => n.includes(w)) ? 65 : 0;
};

// ---- The server ------------------------------------------------------------------------------------

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const ok = (res: http.ServerResponse, body: Record<string, unknown> = {}) =>
  json(res, 200, { 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.58.0 (mock)', openSubsonic: true, ...body } });
const fail = (res: http.ServerResponse, code: number, message: string) =>
  json(res, 200, { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } });

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}

function subsonicUser(q: URLSearchParams): User | undefined {
  const u = users.find((x) => x.userName === q.get('u'));
  if (!u) return undefined;
  const t = q.get('t');
  const s = q.get('s') ?? '';
  if (t) return crypto.createHash('md5').update(u.password + s).digest('hex') === t ? u : undefined;
  const p = q.get('p')?.replace(/^enc:/, '');
  return p === u.password || (p && Buffer.from(p, 'hex').toString() === u.password) ? u : undefined;
}

const shuffled = <T>(xs: T[]) => [...xs].sort(() => Math.random() - 0.5);

function navidrome(method: string, q: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) {
  if (method === 'ping' && !q.get('u')) return fail(res, 10, 'Required parameter is missing: u');
  const u = subsonicUser(q);
  if (!u) return fail(res, 40, 'Wrong username or password');
  const all = q.getAll.bind(q);
  const size = Number(q.get('size') ?? 10);
  const offset = Number(q.get('offset') ?? 0);
  switch (method) {
    case 'ping':
      return ok(res);
    case 'getArtists': {
      // As Navidrome: an empty library is an error, not an empty list.
      if (!libArtists().length) return fail(res, 70, 'Library not found or empty');
      const groups = new Map<string, MArtist[]>();
      for (const a of libArtists()) {
        const letter = a.name.replace(/^the /i, '')[0].toUpperCase();
        groups.set(letter, [...(groups.get(letter) ?? []), a]);
      }
      return ok(res, {
        artists: {
          ignoredArticles: 'The',
          index: [...groups.entries()].sort().map(([name, xs]) => ({ name, artist: xs.map((a) => artistId3(u, a)) })),
        },
      });
    }
    case 'getArtist': {
      const a = artists.find((x) => x.id === q.get('id'));
      return a ? ok(res, { artist: artistId3(u, a, true) }) : fail(res, 70, 'Artist not found');
    }
    case 'getArtistInfo2': {
      const a = artists.find((x) => x.id === q.get('id'));
      if (!a) return fail(res, 70, 'Artist not found');
      const similar = libArtists().filter((x) => x.genre === a.genre && x.id !== a.id).concat(shuffled(libArtists()).slice(0, 3));
      return ok(res, {
        artistInfo2: {
          biography: `${a.name} make ${a.genre.toLowerCase()} that sounds like ${pick(rng(a.name), WORDS_A).toLowerCase()} ${pick(rng(a.genre), WORDS_B).toLowerCase()}. Formed in ${2000 + (hash(a.name) % 15)}, they have released ${a.albums.length} records. <a href="https://www.last.fm/music/x">Read more on Last.fm</a>`,
          musicBrainzId: a.mbid,
          similarArtist: [...new Set(similar)].filter((x) => x.id !== a.id).slice(0, 6).map((x) => artistId3(u, x)),
        },
      });
    }
    case 'getTopSongs': {
      const a = artists.find((x) => x.name === q.get('artist'));
      if (!a) return ok(res, { topSongs: {} });
      const songs = a.albums.flatMap(present);
      return ok(res, { topSongs: { song: songs.sort((x, y) => (hash(y.id) % 100) - (hash(x.id) % 100)).slice(0, Number(q.get('count') ?? 10)).map((t) => child(u, t)) } });
    }
    case 'getAlbum': {
      const a = albums.get(q.get('id') ?? '');
      return a && present(a).length ? ok(res, { album: albumId3(u, a, true) }) : fail(res, 70, 'Album not found');
    }
    case 'getAlbumList2': {
      let list = libAlbums();
      const type = q.get('type');
      if (type === 'newest') list.sort((a, b) => b.created.localeCompare(a.created));
      else if (type === 'recent') list = list.filter((a) => u.played.has(a.id)).sort((a, b) => u.played.get(b.id)!.localeCompare(u.played.get(a.id)!));
      else if (type === 'frequent') list = list.filter((a) => albumPlays(u, a) > 0).sort((a, b) => albumPlays(u, b) - albumPlays(u, a));
      else if (type === 'random') list = shuffled(list);
      else if (type === 'starred') list = list.filter((a) => u.starred.has(a.id));
      else if (type === 'alphabeticalByArtist') list.sort((a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name));
      else list.sort((a, b) => a.name.localeCompare(b.name));
      return ok(res, { albumList2: { album: list.slice(offset, offset + size).map((a) => albumId3(u, a)) } });
    }
    case 'getSong': {
      const t = tracks.get(q.get('id') ?? '');
      return t && isPresent(t) ? ok(res, { song: child(u, t) }) : fail(res, 70, 'Song not found');
    }
    case 'getStarred2': {
      const lib = libTracks();
      return ok(res, {
        starred2: {
          song: lib.filter((t) => u.starred.has(t.id)).map((t) => child(u, t)),
          album: libAlbums().filter((a) => u.starred.has(a.id)).map((a) => albumId3(u, a)),
          artist: libArtists().filter((a) => u.starred.has(a.id)).map((a) => artistId3(u, a)),
        },
      });
    }
    case 'star':
    case 'unstar':
      for (const id of [...all('id'), ...all('albumId'), ...all('artistId')]) {
        if (method === 'star') u.starred.set(id, new Date().toISOString());
        else u.starred.delete(id);
      }
      return ok(res);
    case 'search3': {
      const query = (q.get('query') ?? '').replace(/"/g, '').toLowerCase().trim();
      const match = (s: string) => query && s.toLowerCase().includes(query);
      return ok(res, {
        searchResult3: {
          artist: libArtists().filter((a) => match(a.name)).slice(0, Number(q.get('artistCount') ?? 20)).map((a) => artistId3(u, a)),
          album: libAlbums().filter((a) => match(a.name) || match(a.artist)).slice(0, Number(q.get('albumCount') ?? 20)).map((a) => albumId3(u, a)),
          song: (query ? libTracks().filter((t) => match(t.title) || match(t.artist)) : libTracks())
            .slice(Number(q.get('songOffset') ?? 0))
            .slice(0, Number(q.get('songCount') ?? 20))
            .map((t) => child(u, t)),
        },
      });
    }
    case 'getPlaylists':
      return ok(res, { playlists: { playlist: playlists.filter((p) => p.owner === u.userName || p.owner === 'sam').map((p) => playlistInfo(u, p)) } });
    case 'getPlaylist': {
      const p = playlists.find((x) => x.id === q.get('id'));
      return p ? ok(res, { playlist: playlistInfo(u, p, true) }) : fail(res, 70, 'Playlist not found');
    }
    case 'createPlaylist': {
      const existing = playlists.find((x) => x.id === q.get('playlistId'));
      if (existing) {
        existing.songs = all('songId');
        return ok(res, { playlist: playlistInfo(u, existing, true) });
      }
      const p: MPlaylist = { id: `pl${Date.now()}`, name: q.get('name') ?? 'Playlist', owner: u.userName, songs: all('songId'), created: new Date().toISOString() };
      playlists.push(p);
      return ok(res, { playlist: playlistInfo(u, p, true) });
    }
    case 'updatePlaylist': {
      const p = playlists.find((x) => x.id === q.get('playlistId'));
      if (!p) return fail(res, 70, 'Playlist not found');
      if (q.get('name')) p.name = q.get('name')!;
      const remove = new Set(all('songIndexToRemove').map(Number));
      p.songs = p.songs.filter((_, i) => !remove.has(i)).concat(all('songIdToAdd'));
      return ok(res);
    }
    case 'deletePlaylist': {
      const i = playlists.findIndex((x) => x.id === q.get('id'));
      if (i >= 0) playlists.splice(i, 1);
      return ok(res);
    }
    case 'getSimilarSongs2': {
      const id = q.get('id') ?? '';
      const seed = tracks.get(id) ?? albums.get(id)?.tracks[0] ?? artists.find((a) => a.id === id)?.albums.flatMap(present)[0];
      if (!seed) return ok(res, { similarSongs2: {} });
      const same = libTracks().filter((t) => t.genre === seed.genre && t.id !== seed.id);
      const others = shuffled(libTracks()).slice(0, 12);
      return ok(res, { similarSongs2: { song: shuffled([...same, ...others]).slice(0, Number(q.get('count') ?? 50)).map((t) => child(u, t)) } });
    }
    case 'getRandomSongs': {
      const genre = q.get('genre');
      const list = libTracks().filter((t) => !genre || t.genre === genre);
      return ok(res, { randomSongs: { song: shuffled(list).slice(0, size).map((t) => child(u, t)) } });
    }
    case 'getGenres':
      return ok(res, { genres: { genre: [...new Set(libTracks().map((t) => t.genre))].map((g) => ({ value: g, songCount: 1, albumCount: 1 })) } });
    case 'getLyricsBySongId': {
      const t = tracks.get(q.get('id') ?? '');
      if (!t?.hasLyrics) return ok(res, { lyricsList: { structuredLyrics: [] } });
      return ok(res, { lyricsList: { structuredLyrics: [{ lang: 'eng', synced: true, displayArtist: t.artist, displayTitle: t.title, line: lyricLines(t).map((l) => ({ start: l.time * 1000, value: l.text })) }] } });
    }
    case 'scrobble': {
      if (q.get('submission') !== 'false') {
        for (const id of all('id')) {
          const t = tracks.get(id);
          if (!t) continue;
          u.plays.set(id, (u.plays.get(id) ?? 0) + 1);
          u.played.set(t.albumId, new Date().toISOString());
        }
      }
      return ok(res);
    }
    case 'startScan':
      scan();
      return ok(res, { scanStatus: { scanning: false, count: libTracks().length } });
    case 'getScanStatus':
      return ok(res, { scanStatus: { scanning: false, count: libTracks().length } });
    case 'stream':
    case 'download': {
      const t = tracks.get(q.get('id') ?? '');
      if (!t) return fail(res, 70, 'Song not found');
      return streamSong(t, req, res);
    }
    case 'getCoverArt': {
      const id = (q.get('id') ?? '').replace(/_[0-9a-f]+$/, '');
      const s = Math.min(600, Math.max(32, Number(q.get('size') ?? 300)));
      const albumOf = id.startsWith('al-') ? id.slice(3) : id.startsWith('mf-') ? tracks.get(id.slice(3))?.albumId : albums.has(id) ? id : tracks.get(id)?.albumId;
      const real = albumOf ? albums.get(albumOf)?.cover : undefined;
      if (real && fs.existsSync(real)) return streamFile(real, req, res);
      const image =
        albumOf && albums.has(albumOf)
          ? coverPng(albums.get(albumOf)!.mbid, s)
          : id.startsWith('ar-')
            ? coverPng(`artist:${id}`, s, true)
            : id.startsWith('pl-')
              ? coverPng(`playlist:${id}`, s)
              : coverPng(id, s);
      if (COVER_MS) return void setTimeout(() => png(res, image), COVER_MS);
      return png(res, image);
    }
    default:
      return fail(res, 0, `Not in the mock: ${method}`);
  }
}

function lyricLines(t: MTrack) {
  const r = rng(`lyrics:${t.id}`);
  const lines: Array<{ time: number; text: string }> = [];
  for (let at = 8; at < t.duration - 5; at += 4 + Math.floor(r() * 4)) lines.push({ time: at, text: pick(r, LYRIC) });
  return lines;
}

const png = (res: http.ServerResponse, buf: Buffer) => {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'max-age=3600' });
  res.end(buf);
};

async function navidromeApi(path: string, req: http.IncomingMessage, res: http.ServerResponse) {
  if (path === '/auth/login' && req.method === 'POST') {
    const b = await body(req);
    const u = users.find((x) => x.userName === b.username && x.password === b.password);
    if (!u) return json(res, 401, { error: 'Invalid username or password' });
    const salt = crypto.randomBytes(3).toString('hex');
    const token = `jwt-${crypto.randomBytes(12).toString('hex')}`;
    jwts.set(token, u);
    return json(res, 200, {
      id: u.id,
      name: u.name,
      username: u.userName,
      isAdmin: u.isAdmin,
      token,
      subsonicSalt: salt,
      subsonicToken: crypto.createHash('md5').update(u.password + salt).digest('hex'),
    });
  }
  const jwt = (req.headers['x-nd-authorization'] as string | undefined)?.replace(/^Bearer\s+/i, '') ?? '';
  const caller = jwts.get(jwt);
  if (!caller) return json(res, 401, { error: 'Not authenticated' });
  const refreshed = { 'x-nd-authorization': `Bearer ${jwt}` };
  const m = path.match(/^\/api\/user(?:\/([^/?]+))?/);
  if (!m) return json(res, 404, { error: 'Not in the mock' }, refreshed);
  if (!caller.isAdmin) return json(res, 403, { error: 'Not allowed' }, refreshed);
  const view = (u: User) => ({ id: u.id, userName: u.userName, name: u.name, isAdmin: u.isAdmin, lastAccessAt: undefined });
  if (req.method === 'GET') return json(res, 200, users.map(view), refreshed);
  if (req.method === 'POST') {
    const b = await body(req);
    if (users.some((u) => u.userName === b.userName)) return json(res, 400, { errors: { userName: 'ra.validation.unique' } }, refreshed);
    const u: User = { id: `u${Date.now()}`, userName: String(b.userName), name: String(b.name ?? b.userName), password: String(b.password), isAdmin: Boolean(b.isAdmin), starred: new Map(), plays: new Map(), played: new Map() };
    users.push(u);
    return json(res, 200, view(u), refreshed);
  }
  const target = users.find((u) => u.id === m[1]);
  if (!target) return json(res, 404, { error: 'Not found' }, refreshed);
  if (req.method === 'PUT') {
    const b = await body(req);
    target.name = String(b.name ?? target.name);
    target.isAdmin = Boolean(b.isAdmin ?? target.isAdmin);
    if (b.password) target.password = String(b.password);
    return json(res, 200, view(target), refreshed);
  }
  if (req.method === 'DELETE') {
    users.splice(users.indexOf(target), 1);
    return json(res, 200, {}, refreshed);
  }
  return json(res, 405, {}, refreshed);
}

async function lidarr(path: string, q: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers['x-api-key'] !== 'mock-lidarr-key') return json(res, 401, { message: 'Unauthorized' });
  const p = path.replace(/^\/api\/v1/, '');
  if (p === '/system/status') return json(res, 200, { version: '2.9.0.0 (mock)', appName: 'Lidarr' });
  if (p === '/rootfolder') return json(res, 200, [{ id: 1, path: MUSIC_DIR }]);
  if (p === '/qualityprofile') return json(res, 200, [{ id: 1, name: 'Any' }, { id: 2, name: 'Lossless' }]);
  if (p === '/metadataprofile') return json(res, 200, [{ id: 1, name: 'Standard' }]);
  if (p === '/artist' && req.method === 'GET') return json(res, 200, artists.filter((a) => a.lidarrId).map(lidarrArtist));
  const lookupFailed = (term: string) => json(res, 500, { message: `Search for '${term}' failed. Invalid response received from LidarrAPI.` });
  if (p === '/artist/lookup') {
    const term = q.get('term') ?? '';
    // Deezer's artists by "deezer:<id>" (Tubifarry); "lidarr:" goes to Lidarr's own server, which doesn't know them.
    if (term.startsWith('deezer:')) {
      const a = artists.find((x) => x.mbid === `${term.slice(7)}@deezer`);
      if (a && artistLookupFails(a.name)) return lookupFailed(term);
      return json(res, 200, a ? [{ ...lidarrArtist(a), id: undefined }] : []);
    }
    if (term.startsWith('lidarr:')) {
      if (fromDeezer(term)) return json(res, 200, []);
      const a = artists.find((x) => x.mbid === term.slice(7));
      if (a && lookupFails(a.name)) return lookupFailed(term);
      return json(res, 200, a ? [{ ...lidarrArtist(a), id: undefined }] : []);
    }
    // A name, as Lidarr's "Add new" search.
    if (artistLookupFails(term)) return lookupFailed(term);
    const query = cleanQuery(term);
    const found = artists.filter((a) => score(a.name, query) > 0).sort((x, y) => score(y.name, query) - score(x.name, query));
    return json(res, 200, found.slice(0, 10).map((a) => ({ ...lidarrArtist(a), id: undefined })));
  }
  if (p === '/album/lookup') {
    if (lookupFails(q.get('term') ?? '')) return lookupFailed(q.get('term') ?? '');
    const byId = (q.get('term') ?? '').match(/^deezer:(\d+)$/);
    if (byId) return json(res, 200, [...albums.values()].filter((a) => a.mbid === `${byId[1]}@deezer`).map((a) => ({ ...lidarrAlbum(a), id: undefined, secondaryTypes: [] })));
    const query = cleanQuery(q.get('term') ?? '');
    // By its name, its artist's, or both ("Coral Avenue Paper Oceans"), as Lidarr's search.
    const rank = (a: MAlbum) => Math.max(score(a.name, query), score(a.artist, query), score(`${a.artist} ${a.name}`, query));
    const found = [...albums.values()].filter((a) => rank(a) > 0).sort((x, y) => rank(y) - rank(x) || y.year - x.year);
    return json(res, 200, found.slice(0, 20).map((a) => ({ ...lidarrAlbum(a), id: undefined, secondaryTypes: [] })));
  }
  if (p === '/artist' && req.method === 'POST') {
    const b = await body(req);
    const a = artists.find((x) => x.mbid === b.foreignArtistId);
    if (!a) return json(res, 400, [{ errorMessage: 'Unknown artist' }]);
    a.lidarrId ??= nextLidarrArtist++;
    return json(res, 201, lidarrArtist(a));
  }
  if (p === '/album' && req.method === 'GET') {
    const artist = artists.find((x) => x.lidarrId === Number(q.get('artistId')));
    // Only albums of artists in Lidarr, as Lidarr.
    if (q.get('foreignAlbumId')) return json(res, 200, [...albums.values()].filter((a) => a.mbid === q.get('foreignAlbumId') && kept(a) && artists.find((x) => x.id === a.artistId)?.lidarrId).map(lidarrAlbum));
    return json(res, 200, artist ? artist.albums.filter(kept).map(lidarrAlbum) : []);
  }
  const one = p.match(/^\/album\/(\d+)$/);
  if (one) {
    const a = [...albums.values()].find((x) => x.lidarrId === Number(one[1]));
    return a ? json(res, 200, lidarrAlbum(a)) : json(res, 404, { message: 'Not found' });
  }
  if (p === '/album/monitor' && req.method === 'PUT') {
    const b = await body(req);
    for (const id of (b.albumIds as number[]) ?? []) {
      const a = [...albums.values()].find((x) => x.lidarrId === id);
      if (a) monitored.add(a.id);
    }
    return json(res, 202, {});
  }
  if (p === '/track') {
    const a = [...albums.values()].find((x) => x.lidarrId === Number(q.get('albumId')) || releaseId(x) === Number(q.get('albumReleaseId')));
    return json(res, 200, a ? a.tracks.map(lidarrTrack) : []);
  }
  const file = p.match(/^\/trackfile\/(\d+)$/);
  if (file && req.method === 'DELETE') {
    const t = [...tracks.values()].find((x) => x.fileId === Number(file[1]));
    if (!t) return json(res, 404, { message: 'Not found' });
    unfile(t);
    return json(res, 200, {});
  }
  if (p === '/remotepathmapping') return json(res, 200, []);
  if (p === '/manualimport') {
    const folder = (q.get('folder') ?? '').replace(/\/+$/, '');
    const found = new Map(onDisk().map((x) => [localPath(x), { n: x.n, size: x.size }]));
    // Real files in the music folder (ones someone imported).
    if (folder.startsWith(`${MUSIC_DIR}/`) && fs.existsSync(folder))
      fs.readdirSync(folder)
        .filter((f) => SONG_FILE.test(f))
        .forEach((f, i) => found.set(nodePath.join(folder, f), { n: 900_000 + i, size: fs.statSync(nodePath.join(folder, f)).size }));
    return json(
      res,
      200,
      [...found]
        .filter(([path]) => folder && path.startsWith(`${folder}/`))
        .map(([path, x]) => ({
          id: x.n,
          path,
          name: path.split('/').pop()!.replace(/\.[^.]+$/, ''),
          size: x.size,
          quality: { quality: /\.flac$/i.test(path) ? { id: 6, name: 'FLAC' } : { id: 4, name: 'MP3-320' }, revision: { version: 1, real: 0, isRepack: false } },
          rejections: [],
        })),
    );
  }
  if (p === '/command' && req.method === 'POST') {
    const b = await body(req);
    if (b.name === 'AlbumSearch') {
      for (const id of (b.albumIds as number[]) ?? []) {
        const a = [...albums.values()].find((x) => x.lidarrId === id);
        // A little while "looking", then "downloading".
        if (a && !a.inLibrary && !downloads.some((d) => d.albumId === a.id)) setTimeout(() => downloads.push({ albumId: a.id, started: Date.now(), size: a.tracks.length * 42_000_000 }), 4000);
      }
    }
    const c: Command = { id: nextCommand++, name: String(b.name), status: 'queued', queued: new Date().toISOString(), body: b };
    commands.set(c.id, c);
    // It runs a moment later.
    setTimeout(() => {
      const problem = b.name === 'ManualImport' ? manualImport(Array.isArray(b.files) ? b.files : []) : undefined;
      Object.assign(c, { status: problem ? 'failed' : 'completed', message: problem ?? 'Completed', ended: new Date().toISOString() });
    }, 1000);
    return json(res, 201, c);
  }
  const command = p.match(/^\/command\/(\d+)$/);
  if (command) {
    const c = commands.get(Number(command[1]));
    return c ? json(res, 200, c) : json(res, 404, { message: 'Not found' });
  }
  if (p === '/queue') {
    return json(res, 200, {
      page: 1,
      totalRecords: downloads.length,
      records: downloads.map((d, i) => {
        const a = albums.get(d.albumId)!;
        const done = Math.min(1, (Date.now() - d.started) / (GET_SECONDS * 1000));
        const left = Math.max(0, Math.round(GET_SECONDS * (1 - done)));
        return {
          id: i + 1,
          albumId: a.lidarrId,
          title: `${a.artist} - ${a.name} (${a.year}) [FLAC]`,
          size: d.size,
          sizeleft: Math.round(d.size * (1 - done)),
          timeleft: `00:${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`,
          status: 'downloading',
          trackedDownloadState: 'downloading',
        };
      }),
    });
  }
  if (p === '/search') {
    const term = (q.get('term') ?? '').toLowerCase();
    const out = [
      ...artists.filter((a) => a.name.toLowerCase().includes(term)).map((a) => ({ foreignId: a.mbid, artist: { artistName: a.name, foreignArtistId: a.mbid } })),
      ...[...albums.values()]
        .filter((a) => a.name.toLowerCase().includes(term))
        .map((a) => ({ foreignId: a.mbid, album: { title: a.name, foreignAlbumId: a.mbid, artist: { artistName: a.artist, foreignArtistId: artists.find((x) => x.id === a.artistId)!.mbid } } })),
    ];
    return json(res, 200, out);
  }
  return json(res, 404, { message: `Not in the mock: ${p}` });
}

async function slskd(path: string, q: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers['x-api-key'] !== 'mock-slskd-key') return json(res, 401, {});
  const p = path.replace(/^\/api\/v0/, '');
  const none = () => res.writeHead(204).end();
  if (p === '/application') return json(res, 200, { version: { current: '0.22.0', full: '0.22.0 (mock)' }, server: { state: 'Connected, LoggedIn', isConnected: true, isLoggedIn: true } });
  if (p === '/options') return json(res, 200, { directories: { downloads: DOWNLOADS, incomplete: `${DOWNLOADS}/incomplete` } });
  if (p === '/searches' && req.method === 'POST') {
    const b = await body(req);
    const s: Search = { id: typeof b.id === 'string' && b.id ? b.id : uuid(`search:${nextSearch}`), searchText: String(b.searchText ?? ''), token: nextSearch++, started: Date.now() };
    searches.set(s.id, s);
    console.log(`mock slskd: "${s.searchText}" (${peersFor(s.searchText).length} answered)`);
    return json(res, 200, searchView(s));
  }
  const search = p.match(/^\/searches\/([^/]+)(\/responses)?$/);
  if (search) {
    const s = searches.get(decodeURIComponent(search[1]));
    if (!s) return json(res, 404, {});
    if (req.method === 'DELETE') {
      searches.delete(s.id);
      return none();
    }
    return json(res, 200, search[2] ? searchView(s, true).responses : searchView(s, q.get('includeResponses') === 'true'));
  }
  if (p === '/transfers/downloads' && req.method === 'GET') {
    // Grouped as slskd does: by person, then by remote folder.
    const groups = new Map<string, Map<string, Array<ReturnType<typeof transferView>>>>();
    for (const x of transfers.filter((t) => t.removed === undefined)) {
      const dir = x.filename.split('\\').slice(0, -1).join('\\');
      const user = groups.get(x.username) ?? new Map();
      groups.set(x.username, user.set(dir, [...(user.get(dir) ?? []), transferView(x)]));
    }
    return json(res, 200, [...groups].map(([username, dirs]) => ({ username, directories: [...dirs].map(([directory, files]) => ({ directory, fileCount: files.length, files })) })));
  }
  const from = p.match(/^\/transfers\/downloads\/([^/]+)$/);
  if (from && req.method === 'POST') {
    const files = (await body(req)) as unknown as Array<{ filename?: string; size?: number }>;
    if (!Array.isArray(files) || !files.length) return json(res, 400, 'At least one file is required');
    const username = decodeURIComponent(from[1]);
    const added = files.map((f) => {
      const x: Transfer = { id: uuid(`transfer:${transfers.length + 1}`), n: transfers.length + 1, username, filename: String(f.filename ?? ''), size: Number(f.size) || 0, requested: Date.now() };
      transfers.push(x);
      return x;
    });
    console.log(`mock slskd: getting ${added.map((x) => x.filename.split('\\').pop()).join(', ')} from ${username}`);
    return json(res, 201, { enqueued: added.map(transferView), failed: [] });
  }
  const one = p.match(/^\/transfers\/downloads\/([^/]+)\/([^/]+)$/);
  if (one && req.method === 'DELETE') {
    const x = transfers.find((t) => t.removed === undefined && t.id === one[2] && t.username === decodeURIComponent(one[1]));
    if (!x) return json(res, 404, {});
    // As slskd: a download is cancelled a moment after it's asked, and only one that has ended can be taken off the list.
    const ended = transferView(x).state.startsWith('Completed');
    if (!ended) x.cancelled = Date.now() + 500;
    if (q.get('remove') === 'true' && ended) x.removed = Date.now();
    return none();
  }
  return json(res, 404, { message: `Not in the mock: ${p}` });
}

function musicbrainz(path: string, q: URLSearchParams, res: http.ServerResponse) {
  // MusicBrainz doesn't know what only Deezer has (MOCK_DEEZER).
  const artists = everyArtist.filter((a) => !fromDeezer(a.mbid));
  const albums = new Map([...everyAlbum].filter(([, a]) => !fromDeezer(a.mbid)));
  const tracks = new Map([...everyTrack].filter(([, t]) => !fromDeezer(t.mbid)));
  const p = path.replace(/^\/ws\/2/, '');
  if (p === '/artist') {
    // `artist:"…" OR alias:"…"` as Tuna asks, or any words.
    const named = (q.get('query') ?? '').match(/^artist:"((?:[^"\\]|\\.)*)"/)?.[1];
    const query = named ? named.replace(/\\(.)/g, '$1').toLowerCase() : cleanQuery(q.get('query') ?? '');
    const found = artists
      .map((a) => ({ a, s: score(a.name, query) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, Number(q.get('limit') ?? 10));
    return json(res, 200, { artists: found.map(({ a, s }) => ({ id: a.mbid, name: a.name, score: s, type: 'Group', disambiguation: '' })) });
  }
  if (p === '/release-group' && q.get('artist')) {
    const a = artists.find((x) => x.mbid === q.get('artist'));
    return json(res, 200, { 'release-groups': a ? a.albums.map((x) => mbGroup(x)) : [] });
  }
  const exact = (q.get('query') ?? '').match(/releasegroup:"((?:[^"\\]|\\.)*)"\s+AND\s+artist:"((?:[^"\\]|\\.)*)"/);
  if (p === '/release-group' && exact) {
    const [title, artist] = [exact[1], exact[2]].map((x) => x.replace(/\\(.)/g, '$1').toLowerCase());
    const found = [...albums.values()].filter((a) => a.name.toLowerCase() === title && a.artist.toLowerCase() === artist);
    const famous = [...albums.values()].find((a) => title === 'the hits' && a.artist.toLowerCase() === artist && a.tracks.some((t) => crowded(t.title)));
    if (famous) return json(res, 200, { 'release-groups': [{ ...theHits(famous), 'artist-credit': mbGroup(famous)['artist-credit'], score: 100 }] });
    return json(res, 200, { 'release-groups': found.map((a) => mbGroup(a, 100)) });
  }
  if (p === '/release-group') {
    const query = cleanQuery(q.get('query') ?? '');
    const found = [...albums.values()]
      .map((a) => ({ a, s: Math.max(score(a.name, query), score(a.artist, query) - 10) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, Number(q.get('limit') ?? 10));
    return json(res, 200, { 'release-groups': found.map(({ a, s }) => mbGroup(a, s)) });
  }
  if (p === '/release' && q.get('release-group')) {
    const a = [...albums.values()].find((x) => x.mbid === q.get('release-group'));
    const release = a && {
      id: uuid(`release:${a.mbid}`),
      status: 'Official',
      date: `${a.year}-05-01`,
      media: [{ tracks: a.tracks.map((tr) => ({ title: tr.title, length: tr.duration * 1000, recording: { title: tr.title } })) }],
    };
    return json(res, 200, { releases: release ? [release] : [] });
  }
  if (p === '/recording') {
    // A song by name, `recording:"…" AND artist:"…"` as Tuna asks, or any words of its title.
    // Or by its code: `isrc:…`.
    const exact = (q.get('query') ?? '').match(/recording:"((?:[^"\\]|\\.)*)"(?:\s+AND\s+artist:"((?:[^"\\]|\\.)*)")?/);
    const code = (q.get('query') ?? '').match(/^isrc:(\w+)$/i)?.[1]?.toUpperCase();
    const same = (a: string, b = '') => words(a).join(' ') === words(b.replace(/\\(.)/g, '$1')).join(' ');
    const query = cleanQuery(q.get('query') ?? '');
    const rank = (t: MTrack) => (code ? (isrcOf(t) === code ? 100 : 0) : exact ? (same(t.title, exact[1]) && (!exact[2] || same(t.artist, exact[2])) ? 100 : 0) : score(t.title, query));
    const found = [...tracks.values()].filter((t) => rank(t) > 0).sort((x, y) => rank(y) - rank(x));
    const recording = (t: MTrack, group: { id: string; title: string; 'primary-type': string; 'secondary-types': string[] }, id = t.mbid) => ({
      id,
      title: t.title,
      length: t.duration * 1000,
      score: rank(t),
      'artist-credit': mbGroup(albums.get(t.albumId)!)['artist-credit'],
      isrcs: [isrcOf(t)],
      releases: [{ id: uuid(`release:${group.id}`), title: group.title, status: 'Official', 'artist-credit': mbGroup(albums.get(t.albumId)!)['artist-credit'], 'release-group': group }],
    });
    const all = found.flatMap((t) => {
      const a = albums.get(t.albumId)!;
      const own = recording(t, { id: a.mbid, title: a.name, 'primary-type': a.type, 'secondary-types': [] });
      if (!exact || !crowded(t.title)) return [own];
      // Famous: its other recordings first (MusicBrainz gives equal matches in no particular order).
      const kinds = [['Compilation'], ['Live'], ['DJ-mix'], ['Compilation', 'Live']];
      const others = Array.from({ length: 150 }, (_, i) =>
        recording(t, i % 4 ? { id: uuid(`crowd:${t.mbid}:${i}`), title: `${a.artist} ${kinds[i % 4].join(' ')} ${i}`, 'primary-type': 'Album', 'secondary-types': kinds[i % 4] } : theHits(a), uuid(`crowdrec:${t.mbid}:${i}`)),
      );
      return [...others, own];
    });
    const offset = Number(q.get('offset') ?? 0);
    return json(res, 200, { count: all.length, offset, recordings: all.slice(offset, offset + Number(q.get('limit') ?? 10)) });
  }
  const artist = p.match(/^\/artist\/([\w-]+)$/);
  if (artist) {
    const a = artists.find((x) => x.mbid === artist[1]);
    return a ? json(res, 200, { id: a.mbid, name: a.name, disambiguation: '', type: 'Group' }) : json(res, 404, { error: 'Not Found' });
  }
  const group = p.match(/^\/release-group\/([\w-]+)$/);
  if (group) {
    const a = [...albums.values()].find((x) => x.mbid === group[1]);
    return a ? json(res, 200, mbGroup(a)) : json(res, 404, { error: 'Not Found' });
  }
  return json(res, 404, { error: 'Not in the mock' });
}

function listenbrainz(path: string, q: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) {
  if (path === '/validate-token') {
    const valid = req.headers.authorization === 'Token mock-lb';
    return json(res, 200, valid ? { code: 200, valid: true, user_name: 'demo-lb' } : { code: 200, valid: false });
  }
  if (path === '/submit-listens') return json(res, 200, { status: 'ok' });
  const listensOf = path.match(/^\/user\/([^/]+)\/listens$/);
  if (listensOf) {
    const since = Number(q.get('min_ts') ?? 0);
    const listens = outsidePlays(`lb:${listensOf[1]}`)
      .filter((p) => p.at / 1000 >= since)
      .map((p, i) => ({ listened_at: Math.floor(p.at / 1000), track_metadata: { artist_name: p.t.artist, track_name: p.t.title, release_name: p.t.album, additional_info: i % 7 === 0 ? { submission_client: 'Tuna' } : {} } }));
    return json(res, 200, { payload: { count: listens.length, listens } });
  }
  const recsFor = path.match(/^\/cf\/recommendation\/user\/([^/]+)\/recording$/);
  if (recsFor) {
    // Songs from albums not in the library (some by artists not in it at all), and some that are.
    const r = rng('recommendations');
    const pool = [...albums.values()].filter((a) => !a.inLibrary || r() < 0.3).flatMap((a) => a.tracks.slice(0, 2));
    pool.sort((x, y) => hash(recsFor[1] + x.mbid) - hash(recsFor[1] + y.mbid));
    return json(res, 200, { payload: { mbids: pool.slice(0, Number(q.get('count') ?? 50)).map((t) => ({ recording_mbid: t.mbid, score: r() })), count: 50 } });
  }
  if (path === '/metadata/recording/' || path === '/metadata/recording') {
    const out: Record<string, unknown> = {};
    for (const mbid of (q.get('recording_mbids') ?? '').split(',')) {
      const t = [...tracks.values()].find((x) => x.mbid === mbid);
      if (!t) continue;
      const a = albums.get(t.albumId)!;
      const artist = artists.find((x) => x.id === t.artistId)!;
      out[mbid] = { recording: { name: t.title }, artist: { name: t.artist, artists: [{ artist_mbid: artist.mbid, name: artist.name }] }, release: { name: a.name, release_group_mbid: a.mbid } };
    }
    return json(res, 200, out);
  }
  return json(res, 404, { error: 'Not in the mock' });
}

/** Plays "elsewhere" (Spotify, scrobbled), for ListenBrainz's and Last.fm's listens: some here, some not. */
function outsidePlays(who: string) {
  const r = rng(`outside:${who}`);
  const out = [...albums.values()].filter((a) => !a.inLibrary).slice(0, 6);
  const here = [...albums.values()].filter((a) => a.inLibrary);
  return Array.from({ length: 160 }, () => {
    const a = r() < 0.3 ? out[Math.floor(r() * out.length)] : here[Math.floor(r() * here.length)];
    return { at: Date.now() - Math.floor(r() * 28 * 86_400_000), t: a.tracks[Math.floor(r() * a.tracks.length)] };
  }).sort((x, y) => y.at - x.at);
}

function lastfm(q: URLSearchParams, res: http.ServerResponse) {
  const method = q.get('method')?.toLowerCase();
  const user = q.get('user') ?? '';
  if (method === 'user.getinfo') return user === 'nobody' ? json(res, 200, { error: 6, message: 'User not found' }) : json(res, 200, { user: { name: user } });
  if (method === 'user.getrecenttracks') {
    const from = Number(q.get('from') ?? 0) * 1000;
    const track = outsidePlays(`lfm:${user}`)
      .filter((p) => p.at >= from)
      .map((p) => ({ name: p.t.title, artist: { '#text': p.t.artist }, album: { '#text': p.t.album }, date: { uts: String(Math.floor(p.at / 1000)) } }));
    return json(res, 200, { recenttracks: { track, '@attr': { totalPages: '1' } } });
  }
  if (method === 'user.gettopartists') {
    const top = [...artists].sort((x, y) => hash(user + x.name) - hash(user + y.name)).slice(0, 10);
    return json(res, 200, { topartists: { artist: top.map((a) => ({ name: a.name, mbid: a.mbid })) } });
  }
  if (method === 'artist.gettopalbums') {
    const a = artists.find((x) => x.mbid === q.get('mbid') || x.name.toLowerCase() === (q.get('artist') ?? '').toLowerCase());
    return json(res, 200, { topalbums: { album: (a?.albums ?? []).filter((x) => x.type === 'Album').map((x) => ({ name: x.name })) } });
  }
  if (method === 'track.getsimilar') {
    const named = (s: string, p: string) => s.toLowerCase() === (q.get(p) ?? '').toLowerCase();
    const seed = [...tracks.values()].find((t) => t.mbid === q.get('mbid') || (named(t.artist, 'artist') && named(t.title, 'track')));
    if (!seed) return json(res, 200, { error: 6, message: 'Track not found', links: [] });
    // Three songs from each artist: the same genre first, then the seed's own artist, then the rest.
    // Some aren't in the library, some have no mbid.
    const rank = (a: MArtist) => (a.id === seed.artistId ? 1 : a.genre === seed.genre ? 0 : 2);
    const similar = [...artists]
      .sort((x, y) => rank(x) - rank(y) || hash(seed.id + x.name) - hash(seed.id + y.name))
      .flatMap((a) =>
        a.albums
          .flatMap((x) => x.tracks)
          .filter((t) => t.title !== seed.title)
          .sort((x, y) => hash(seed.id + x.id) - hash(seed.id + y.id))
          .slice(0, 3),
      );
    return json(res, 200, {
      similartracks: {
        track: similar.slice(0, Number(q.get('limit') ?? 50)).map((t, i) => ({
          name: t.title,
          mbid: hash(t.id) % 5 ? t.mbid : '',
          match: Number((1 - i / similar.length).toFixed(3)),
          duration: t.duration,
          artist: { name: t.artist, mbid: artists.find((x) => x.id === t.artistId)!.mbid },
        })),
        '@attr': { artist: seed.artist },
      },
    });
  }
  if (method !== 'artist.getsimilar') return json(res, 200, { error: 3, message: 'Invalid method' });
  const a = artists.find((x) => x.mbid === q.get('mbid') || x.name.toLowerCase() === (q.get('artist') ?? '').toLowerCase());
  if (!a) return json(res, 200, { similarartists: { artist: [] } });
  const similar = artists.filter((x) => x.id !== a.id).sort((x, y) => Number(y.genre === a.genre) - Number(x.genre === a.genre) || hash(x.name + a.name) - hash(y.name + a.name));
  return json(res, 200, { similarartists: { artist: similar.slice(0, Number(q.get('limit') ?? 10)).map((x) => ({ name: x.name, mbid: x.mbid, match: '0.8' })) } });
}

function lrclib(q: URLSearchParams, res: http.ServerResponse) {
  const t = [...tracks.values()].find((x) => x.title === q.get('track_name') && x.artist === q.get('artist_name'));
  if (!t || hash(t.id) % 2) return json(res, 404, { code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' });
  const lrc = lyricLines(t)
    .map((l) => `[${String(Math.floor(l.time / 60)).padStart(2, '0')}:${(l.time % 60).toFixed(2).padStart(5, '0')}] ${l.text}`)
    .join('\n');
  return json(res, 200, { id: hash(t.id), trackName: t.title, artistName: t.artist, instrumental: false, plainLyrics: lyricLines(t).map((l) => l.text).join('\n'), syncedLyrics: lrc });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const q = url.searchParams;
    void (async () => {
      try {
        if (path.startsWith('/nd/rest/')) return navidrome(path.slice(9).replace(/\.view$/, ''), q, req, res);
        if (path.startsWith('/nd/')) return await navidromeApi(path.slice(3), req, res);
        if (path.startsWith('/lidarr/')) return await lidarr(path.slice(7), q, req, res);
        if (path.startsWith('/slskd/')) return await slskd(path.slice(6), q, req, res);
        if (path.startsWith('/mb/')) return musicbrainz(path.slice(3), q, res);
        const deezerCover = path.match(/^\/deezer\/album\/(\d+)\/image$/);
        if (deezerCover) {
          if (![...albums.values()].some((a) => a.mbid === `${deezerCover[1]}@deezer`)) return json(res, 404, {});
          return png(res, coverPng(`${deezerCover[1]}@deezer`, 500));
        }
        const caa = path.match(/^\/caa\/release-group\/([\w-]+)\/front/);
        if (caa) {
          if (![...albums.values()].some((a) => a.mbid === caa[1])) return json(res, 404, {});
          return png(res, coverPng(caa[1], 250));
        }
        if (path.startsWith('/lrclib/api/get')) return lrclib(q, res);
        if (path.startsWith('/lb/1')) return listenbrainz(path.slice(5), q, req, res);
        if (path.startsWith('/lastfm/')) return lastfm(q, res);
        json(res, 404, { error: 'Not in the mock' });
      } catch (err) {
        console.error(err);
        if (!res.headersSent) json(res, 500, { error: String(err) });
      }
    })();
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Tuna mock on http://127.0.0.1:${PORT}: ${libArtists().length} artists, ${libAlbums().length} albums and ${libTracks().length} songs in the library; ${[...albums.values()].length - libAlbums().length} more albums out there`);
  });

/**
 * A fake Navidrome, Lidarr, MusicBrainz, Cover Art Archive, LRCLIB, ListenBrainz and Last.fm on
 * port 7701, for developing Tuna without a real server or the internet. Made-up artists and
 * albums; the music is a soft tune made up on the spot from each song's id (a WAV, so every
 * player plays it); covers are gradients drawn the same way.
 *
 *   Users: demo/demo (admin), sam/sam, admin/admin (admin). Lidarr key: mock-lidarr-key.
 *   MOCK_GET_SECONDS (default 40): how long a Get takes to "download".
 *   ListenBrainz token for Settings: mock-lb.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT ?? 7701);
const GET_SECONDS = Number(process.env.MOCK_GET_SECONDS ?? 40);

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
  created: string;
  tracks: MTrack[];
  lidarrId: number;
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
let nextLidarrAlbum = 1;

for (const [ai, a] of ARTISTS.entries()) {
  const r = rng(a.name);
  const artist: MArtist = { id: `ar${ai + 1}`, name: a.name, genre: a.genre, mbid: uuid(`artist:${a.name}`), inLibrary: a.inLibrary, albums: [] };
  const count = 3 + Math.floor(r() * 3);
  for (let n = 0; n < count; n++) {
    const type: MAlbum['type'] = n === count - 1 ? 'Single' : n === count - 2 && r() < 0.5 ? 'EP' : 'Album';
    const name = type === 'Single' ? `${pick(r, SONG_A)} ${pick(r, SONG_B)}` : `${pick(r, WORDS_A)} ${pick(r, WORDS_B)}`;
    const id = `al${ai + 1}-${n + 1}`;
    // In the library: most albums of library artists; the newest one or two are only "out there".
    const inLibrary = a.inLibrary && (n < count - 2 || (n === count - 2 && r() < 0.4));
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
      };
      album.tracks.push(t);
      tracks.set(t.id, t);
    }
    artist.albums.push(album);
    albums.set(id, album);
  }
  artists.push(artist);
}

const libArtists = () => artists.filter((a) => a.albums.some((al) => al.inLibrary));
const libAlbums = () => [...albums.values()].filter((a) => a.inLibrary);
const libTracks = () => libAlbums().flatMap((a) => a.tracks);

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

for (const u of users.slice(0, 2)) {
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
{
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
  bitRate: 352,
  suffix: 'wav',
  contentType: 'audio/wav',
  size: 44 + t.duration * RATE * 2,
  playCount: u.plays.get(t.id) ?? 0,
  starred: u.starred.get(t.id),
  musicBrainzId: t.mbid,
  type: 'music',
});

const albumId3 = (u: User, a: MAlbum, withSongs = false) => ({
  id: a.id,
  name: a.name,
  artist: a.artist,
  artistId: a.artistId,
  coverArt: `al-${a.id}`,
  songCount: a.tracks.length,
  duration: a.tracks.reduce((n, t) => n + t.duration, 0),
  year: a.year,
  genre: a.genre,
  created: a.created,
  playCount: albumPlays(u, a),
  played: u.played.get(a.id),
  starred: u.starred.get(a.id),
  musicBrainzId: a.mbid,
  ...(withSongs ? { song: a.tracks.map((t) => child(u, t)) } : {}),
});

const artistId3 = (u: User, a: MArtist, withAlbums = false) => {
  const own = a.albums.filter((x) => x.inLibrary);
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

function streamSong(t: MTrack, req: http.IncomingMessage, res: http.ServerResponse) {
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
  for (const d of [...downloads]) {
    if (Date.now() - d.started >= GET_SECONDS * 1000) {
      const a = albums.get(d.albumId)!;
      a.inLibrary = true;
      a.created = new Date().toISOString();
      downloads.splice(downloads.indexOf(d), 1);
      console.log(`mock lidarr: "${a.name}" by ${a.artist} is in the library now`);
    }
  }
}
setInterval(tickDownloads, 1000);

const lidarrAlbum = (a: MAlbum) => {
  const artist = artists.find((x) => x.id === a.artistId)!;
  return {
    id: a.lidarrId,
    title: a.name,
    foreignAlbumId: a.mbid,
    artistId: artist.lidarrId ?? 0,
    monitored: monitored.has(a.id),
    albumType: a.type,
    releaseDate: `${a.year}-05-01T00:00:00Z`,
    artist: { id: artist.lidarrId ?? 0, artistName: artist.name, foreignArtistId: artist.mbid },
    statistics: { trackFileCount: a.inLibrary ? a.tracks.length : 0, trackCount: a.tracks.length, totalTrackCount: a.tracks.length, percentOfTracks: a.inLibrary ? 100 : 0 },
  };
};
const lidarrArtist = (a: MArtist) => ({ id: a.lidarrId ?? 0, artistName: a.name, foreignArtistId: a.mbid, monitored: true, disambiguation: '' });
let nextLidarrArtist = 1;

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
      const songs = a.albums.filter((x) => x.inLibrary).flatMap((x) => x.tracks);
      return ok(res, { topSongs: { song: songs.sort((x, y) => (hash(y.id) % 100) - (hash(x.id) % 100)).slice(0, Number(q.get('count') ?? 10)).map((t) => child(u, t)) } });
    }
    case 'getAlbum': {
      const a = albums.get(q.get('id') ?? '');
      return a && a.inLibrary ? ok(res, { album: albumId3(u, a, true) }) : fail(res, 70, 'Album not found');
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
      return t ? ok(res, { song: child(u, t) }) : fail(res, 70, 'Song not found');
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
      const seed = tracks.get(id) ?? albums.get(id)?.tracks[0] ?? artists.find((a) => a.id === id)?.albums.find((x) => x.inLibrary)?.tracks[0];
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
      if (albumOf && albums.has(albumOf)) return png(res, coverPng(albums.get(albumOf)!.mbid, s));
      if (id.startsWith('ar-')) return png(res, coverPng(`artist:${id}`, s, true));
      if (id.startsWith('pl-')) return png(res, coverPng(`playlist:${id}`, s));
      return png(res, coverPng(id, s));
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
  if (p === '/rootfolder') return json(res, 200, [{ id: 1, path: '/music' }]);
  if (p === '/qualityprofile') return json(res, 200, [{ id: 1, name: 'Any' }, { id: 2, name: 'Lossless' }]);
  if (p === '/metadataprofile') return json(res, 200, [{ id: 1, name: 'Standard' }]);
  if (p === '/artist' && req.method === 'GET') return json(res, 200, artists.filter((a) => a.lidarrId).map(lidarrArtist));
  if (p === '/artist/lookup') {
    const mbid = (q.get('term') ?? '').replace(/^lidarr:/, '');
    const a = artists.find((x) => x.mbid === mbid || x.name.toLowerCase() === mbid.toLowerCase());
    return json(res, 200, a ? [{ ...lidarrArtist(a), id: undefined }] : []);
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
    if (q.get('foreignAlbumId')) return json(res, 200, [...albums.values()].filter((a) => a.mbid === q.get('foreignAlbumId')).map(lidarrAlbum));
    return json(res, 200, artist ? artist.albums.map(lidarrAlbum) : []);
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
  if (p === '/command' && req.method === 'POST') {
    const b = await body(req);
    if (b.name === 'AlbumSearch') {
      for (const id of (b.albumIds as number[]) ?? []) {
        const a = [...albums.values()].find((x) => x.lidarrId === id);
        // A little while "looking", then "downloading".
        if (a && !a.inLibrary && !downloads.some((d) => d.albumId === a.id)) setTimeout(() => downloads.push({ albumId: a.id, started: Date.now(), size: a.tracks.length * 42_000_000 }), 4000);
      }
    }
    return json(res, 201, { id: Date.now(), name: b.name, status: 'queued' });
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

function musicbrainz(path: string, q: URLSearchParams, res: http.ServerResponse) {
  const p = path.replace(/^\/ws\/2/, '');
  if (p === '/artist') {
    const query = cleanQuery(q.get('query') ?? '');
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
  if (/^\/cf\/recommendation\/user\/[^/]+\/recording$/.test(path)) {
    const r = rng('recommendations');
    const pool = [...albums.values()].filter((a) => !a.inLibrary || r() < 0.3).flatMap((a) => a.tracks.slice(0, 2));
    return json(res, 200, { payload: { mbids: shuffled(pool).slice(0, Number(q.get('count') ?? 50)).map((t) => ({ recording_mbid: t.mbid, score: r() })), count: 50 } });
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
  const method = q.get('method');
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
        if (path.startsWith('/mb/')) return musicbrainz(path.slice(3), q, res);
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

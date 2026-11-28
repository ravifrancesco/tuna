import fs from 'node:fs';
import path from 'node:path';

declare const __TUNA_VERSION__: string | undefined;

// In Docker the env comes from the stack; locally we read a .env file.
const envFile = process.env.TUNA_ENV_FILE ?? path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key: string): string | undefined => process.env[key]?.trim() || undefined;
const url = (key: string): string | undefined => env(key)?.replace(/\/+$/, '');

function resolvePublicDir(): string | undefined {
  const candidates = [
    env('TUNA_PUBLIC_DIR'),
    path.join(__dirname, 'public'), // Docker: /app/server.cjs + /app/public
    path.resolve(__dirname, '../../web/dist'), // `npm start` after `npm run build`
  ];
  return candidates.find((dir) => dir && fs.existsSync(path.join(dir, 'index.html')));
}

export const config = {
  version: typeof __TUNA_VERSION__ === 'string' ? __TUNA_VERSION__ : (env('TUNA_VERSION') ?? 'dev'),
  port: Number(env('TUNA_PORT') ?? env('PORT') ?? 7778),
  host: env('TUNA_HOST') ?? '0.0.0.0',
  publicDir: resolvePublicDir(),
  logLevel: env('LOG_LEVEL') ?? 'info',
  /** Where Tuna keeps its own small state (settings, sessions, requests). A Docker volume in production. */
  dataDir: env('TUNA_DATA_DIR') ?? path.resolve(process.cwd(), 'data'),
  trustProxy: env('TRUST_PROXY') === 'true',
  timeZone: env('TZ'),

  /** From the stack; when unset, what an admin saved in Settings → Connections. */
  env: {
    navidromeUrl: url('NAVIDROME_URL'),
    lidarrUrl: url('LIDARR_URL'),
    lidarrApiKey: env('LIDARR_API_KEY'),
    slskdUrl: url('SLSKD_URL'),
    slskdApiKey: env('SLSKD_API_KEY'),
    lastfmApiKey: env('LASTFM_API_KEY'),
  },

  /** Public services. Changeable so development never touches the real ones (dev/mock.env). */
  musicbrainzUrl: url('MUSICBRAINZ_URL') ?? 'https://musicbrainz.org/ws/2',
  coverArtUrl: url('COVERART_URL') ?? 'https://coverartarchive.org',
  lrclibUrl: url('LRCLIB_URL') ?? 'https://lrclib.net/api',
  listenbrainzUrl: url('LISTENBRAINZ_URL') ?? 'https://api.listenbrainz.org/1',
  lastfmUrl: url('LASTFM_URL') ?? 'https://ws.audioscrobbler.com/2.0',
  /** Look up lyrics on LRCLIB when the file has none (off: LYRICS_ONLINE=false). */
  lyricsOnline: env('LYRICS_ONLINE') !== 'false',
};

/** How Tuna introduces itself to public services (MusicBrainz asks for a name and a link). */
export const userAgent = () => `Tuna/${config.version} ( https://github.com/ravifrancesco/tuna )`;

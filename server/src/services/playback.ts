import fs from 'node:fs';
import { Readable, Transform, pipeline } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { subsonic, subsonicUrl } from '../clients/navidrome';
import { lbSubmit } from '../clients/public';
import { config } from '../config';
import { cachedImage } from '../lib/imageCache';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { HttpError } from '../lib/upstream';
import { authOf, mediaSessionOf, type Session } from '../sessions';
import { song } from './library';
import { keepListen } from './listens';
import { listenbrainzOf } from './prefs';
import { waveOf } from './waveform';

/**
 * Music and covers, through Tuna. Every player (the browser's and the apps' own, playing with the
 * screen off) fetches the music from here, so this is also where plays are counted: "now playing"
 * when a song starts, a play in Navidrome (and on ListenBrainz, if linked, and in the person's own
 * listening history) once half of it has been sent, the way scrobbling usually counts.
 */

const FORMATS = new Set(['raw', 'mp3', 'opus', 'aac']);

interface Listening {
  total?: number;
  furthest: number;
  counted: boolean;
  at: number;
  duration?: number;
  bitRate?: number;
}

const listening = new Map<string, Listening>();
setInterval(() => {
  for (const [key, l] of listening) if (Date.now() - l.at > 30 * 60_000) listening.delete(key);
}, 5 * 60_000).unref();

async function nowPlaying(session: Session, songId: string) {
  const auth = authOf(session);
  await subsonic(auth, 'scrobble', { id: songId, submission: false }).catch(() => undefined);
  const lb = listenbrainzOf(session.username);
  if (lb.token) {
    const tr = await song(auth, songId).catch(() => undefined);
    if (tr) await lbSubmit(lb.token, 'playing_now', { artist: tr.artist, track: tr.title, album: tr.album, duration: tr.duration }).catch(() => undefined);
  }
}

/** A play (half a song or more): Navidrome, ListenBrainz if linked, and the person's own history. */
export async function countPlay(session: Session, songId: string) {
  const auth = authOf(session);
  await subsonic(auth, 'scrobble', { id: songId, submission: true, time: Date.now() }).catch((err) => log.debug('playing', String(err)));
  const tr = await song(auth, songId).catch(() => undefined);
  log.debug('playing', `${session.name} played ${tr ? `"${tr.title}" by ${tr.artist}` : songId}`);
  if (tr) keepListen(session.username, tr);
  const lb = listenbrainzOf(session.username);
  if (lb.token && tr) {
    await lbSubmit(lb.token, 'single', { artist: tr.artist, track: tr.title, album: tr.album, duration: tr.duration }).catch((err) =>
      log.warn('playing', `ListenBrainz didn't take ${session.name}'s play`, err),
    );
  }
}

export async function stream(req: FastifyRequest<{ Params: { id: string }; Querystring: { f?: string; br?: string; dl?: string } }>, reply: FastifyReply) {
  const session = mediaSessionOf(req);
  if (!session) throw new HttpError(401, t('Please sign in'));
  const id = req.params.id;
  const format = FORMATS.has(req.query.f ?? '') ? req.query.f! : 'raw';
  const maxBitRate = Math.max(0, Math.min(320, Number(req.query.br) || 0));
  // A download is kept whole: no estimated length, which a converted song can turn out longer than.
  const downloading = req.query.dl === '1';
  const url = subsonicUrl(authOf(session), 'stream', { id, format, maxBitRate: maxBitRate || undefined, estimateContentLength: format !== 'raw' && !downloading });

  // A player that skips or seeks hangs up mid-song: stop fetching from Navidrome too.
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  const range = req.headers.range;
  const upstream = await fetch(url, { headers: range ? { range } : {}, signal: abort.signal }).catch(() => undefined);
  if (!upstream || !upstream.body || (!upstream.ok && upstream.status !== 206)) {
    throw new HttpError(upstream?.status === 404 ? 404 : 502, t("Couldn't play this song"));
  }
  // Subsonic says "no such song" as a 200 with an error inside, not as music.
  if (/json|xml/.test(upstream.headers.get('content-type') ?? '')) {
    const text = await upstream.text().catch(() => '');
    throw new HttpError(/"code"\s*:\s*70|code="70"/.test(text) ? 404 : 502, t("Couldn't play this song"));
  }

  const key = `${session.id}:${id}`;
  const start = Number(range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
  const total = Number(upstream.headers.get('content-range')?.split('/')[1]) || Number(upstream.headers.get('content-length')) || undefined;
  // A download (the apps keep the file): not a play. The apps say when they play it.
  let l = listening.get(key);
  if (downloading) l = { total, furthest: 0, counted: true, at: Date.now() };
  else if (!l || (start === 0 && Date.now() - l.at > 60_000 && l.counted)) {
    l = { total, furthest: 0, counted: false, at: Date.now() };
    listening.set(key, l);
    void nowPlaying(session, id);
    // Measured now, so Now Playing's waveform is usually ready by the time it's opened.
    void waveOf(authOf(session), id);
  }
  l.total ??= total;
  l.at = Date.now();

  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!upstream.headers.get('accept-ranges') && format === 'raw') reply.header('accept-ranges', 'bytes');
  reply.header('cache-control', 'private, max-age=3600');

  let sent = 0;
  const entry = l;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      sent += chunk.length;
      entry.furthest = Math.max(entry.furthest, start + sent);
      if (!entry.counted && entry.total && entry.furthest >= entry.total * 0.5) {
        entry.counted = true;
        void countPlay(session, id);
      }
      done(null, chunk);
    },
  });
  reply.code(upstream.status);
  // pipeline: a hang-up on either side ends both quietly, instead of an unhandled error.
  pipeline(Readable.fromWeb(upstream.body as never), counter, () => undefined);
  return reply.send(counter);
}

export async function cover(req: FastifyRequest<{ Params: { id: string }; Querystring: { s?: string } }>, reply: FastifyReply) {
  const session = mediaSessionOf(req);
  if (!session) throw new HttpError(401, t('Please sign in'));
  const size = [64, 150, 300, 600, 1200].find((s) => s >= (Number(req.query.s) || 300)) ?? 600;
  const id = req.params.id;
  const image = await cachedImage(`nd:${id}:${size}`, subsonicUrl(authOf(session), 'getCoverArt', { id, size }));
  if (!image) return reply.code(404).send();
  reply.header('content-type', image.type).header('cache-control', 'private, max-age=604800');
  return reply.send(fs.createReadStream(image.file));
}

/** Covers of music that isn't here yet: only from the services Tuna uses. */
function allowedArt(u: URL): boolean {
  if (u.href.startsWith(`${config.coverArtUrl}/`)) return true;
  return u.protocol === 'https:' && /(^|\.)(coverartarchive\.org|archive\.org|lastfm\.freetls\.fastly\.net|fastly\.net)$/.test(u.hostname);
}

export async function art(req: FastifyRequest<{ Querystring: { u?: string } }>, reply: FastifyReply) {
  if (!mediaSessionOf(req)) throw new HttpError(401, t('Please sign in'));
  let u: URL;
  try {
    u = new URL(req.query.u ?? '');
  } catch {
    throw new HttpError(400, 'Bad address');
  }
  if (!allowedArt(u)) throw new HttpError(400, 'Not an image Tuna fetches');
  const image = await cachedImage(`art:${u.href}`, u.href);
  if (!image) return reply.code(404).header('cache-control', 'public, max-age=86400').send();
  reply.header('content-type', image.type).header('cache-control', 'public, max-age=2592000');
  return reply.send(fs.createReadStream(image.file));
}

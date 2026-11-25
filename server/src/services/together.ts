import type { ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import type { Track, TogetherControl, TogetherEvent, TogetherPlayback, TogetherRoom, TogetherSummary } from '@tuna/shared';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { ping, send } from '../lib/sse';
import { HttpError } from '../lib/upstream';
import type { Session } from '../sessions';

/**
 * Play together, as Netfish's watch together: a room keeps only what's playing (the queue, which
 * song, playing or not, where). Everyone's own player plays it, fetching the music itself, and
 * follows the room; anyone in it can play, pause, skip or seek for everyone. Rooms live in memory:
 * a restart ends them.
 */

const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 30;
const MAX_PLAYERS = 12;
const MAX_QUEUE = 500;
/** Someone whose line has been closed this long has left. */
const GONE_AFTER = 2 * 60_000;
/** A room nobody has open ends after this. */
const EMPTY_FOR = 10 * 60_000;
const MAX_AGE = 12 * 60 * 60_000;

interface Player {
  clientId: string;
  username: string;
  name: string;
  streams: Set<ServerResponse>;
  lastSeen: number;
}

interface Room {
  id: string;
  host: string;
  hostName: string;
  title?: string;
  playback: TogetherPlayback;
  players: Map<string, Player>;
  createdAt: number;
  emptySince?: number;
}

const rooms = new Map<string, Room>();

const newCode = () => Array.from({ length: 6 }, () => CODE[randomInt(CODE.length)]).join('');

/** Only what a player needs of each song, and not too many. */
const slim = (queue: Track[] | undefined): Track[] =>
  (queue ?? []).slice(0, MAX_QUEUE).map((x) => ({
    id: String(x.id),
    title: String(x.title ?? ''),
    artist: String(x.artist ?? ''),
    artistId: x.artistId,
    album: String(x.album ?? ''),
    albumId: x.albumId,
    duration: Number(x.duration) || 0,
    cover: x.cover,
    suffix: x.suffix,
    bitRate: x.bitRate,
  }));

/** Where the room is now, in seconds. */
const here = (r: Room) => r.playback.position + (r.playback.playing ? (Date.now() - r.playback.at) / 1000 : 0);

function view(r: Room): TogetherRoom {
  return {
    id: r.id,
    host: r.host,
    hostName: r.hostName,
    title: r.title,
    members: [...r.players.values()].map((p) => ({ clientId: p.clientId, username: p.username, name: p.name, here: p.streams.size > 0 })),
    playback: r.playback,
  };
}

function broadcast(r: Room, event: Omit<TogetherEvent, 'now'>) {
  const e = { ...event, now: Date.now() };
  for (const p of r.players.values()) for (const s of p.streams) send(s, e);
}
const changed = (r: Room) => broadcast(r, { room: view(r) });

function setPlayback(r: Room, by: string, patch: Partial<TogetherPlayback> & Pick<TogetherPlayback, 'action'>) {
  r.playback = { ...r.playback, ...patch, by, at: Date.now(), rev: r.playback.rev + 1 };
  changed(r);
}

const roomOf = (id: string) => {
  const r = rooms.get(id.toUpperCase());
  if (!r) throw new HttpError(404, t('That room has ended'));
  return r;
};

export function listRooms(): TogetherSummary[] {
  return [...rooms.values()]
    .filter((r) => [...r.players.values()].some((p) => p.streams.size))
    .map((r) => ({
      id: r.id,
      hostName: r.hostName,
      title: r.title,
      cover: r.playback.queue[r.playback.index]?.cover,
      names: [...new Set([...r.players.values()].filter((p) => p.streams.size).map((p) => p.name))],
    }));
}

/** Someone starts a room with what they're playing; a person has one room at a time. */
export function createRoom(s: Session, body: { queue?: Track[]; index?: number; position?: number; playing?: boolean; title?: string }): TogetherRoom {
  const queue = slim(body.queue);
  if (!queue.length) throw new HttpError(400, t('Play something first'));
  for (const r of rooms.values()) if (r.host === s.username) endRoom(r, s.name);
  if (rooms.size >= MAX_ROOMS) throw new HttpError(429, t('Too many rooms are open right now'));
  let id = newCode();
  while (rooms.has(id)) id = newCode();
  const index = Math.max(0, Math.min(Number(body.index) || 0, queue.length - 1));
  const room: Room = {
    id,
    host: s.username,
    hostName: s.name,
    title: body.title ? String(body.title).slice(0, 120) : undefined,
    playback: { queue, index, playing: Boolean(body.playing), position: Math.max(0, Number(body.position) || 0), at: Date.now(), action: 'start', by: s.name, rev: 1 },
    players: new Map(),
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  log.info('together', `${s.name} started a room (${id})`);
  return view(room);
}

export const getRoom = (id: string) => view(roomOf(id));

/** The room's live line; being connected is what "here" means. */
export function openStream(s: Session, id: string, clientId: string, stream: ServerResponse) {
  const r = roomOf(id);
  let p = r.players.get(clientId);
  if (!p) {
    if (r.players.size >= MAX_PLAYERS) throw new HttpError(409, t('This room is full'));
    p = { clientId, username: s.username, name: s.name, streams: new Set(), lastSeen: Date.now() };
    r.players.set(clientId, p);
    log.info('together', `${s.name} joined ${r.hostName}'s room`);
  }
  p.streams.add(stream);
  p.lastSeen = Date.now();
  r.emptySince = undefined;
  send(stream, { room: view(r), now: Date.now() } satisfies TogetherEvent);
  changed(r);
  stream.on('close', () => {
    p!.streams.delete(stream);
    p!.lastSeen = Date.now();
    if (rooms.has(r.id)) changed(r);
  });
}

export function control(s: Session, id: string, c: TogetherControl): TogetherRoom {
  const r = roomOf(id);
  const p = r.players.get(c.clientId);
  if (!p || p.username !== s.username) throw new HttpError(403, t('Join the room first'));
  const pb = r.playback;
  const position = c.position !== undefined ? Math.max(0, Number(c.position) || 0) : here(r);
  switch (c.action) {
    case 'play':
      if (!pb.playing) setPlayback(r, s.name, { action: 'play', playing: true, position });
      break;
    case 'pause':
      if (pb.playing) setPlayback(r, s.name, { action: 'pause', playing: false, position });
      break;
    case 'seek':
      setPlayback(r, s.name, { action: 'seek', position });
      break;
    case 'index': {
      // Everyone's player moves on at the end of a song: the first to say so moves the room.
      const index = Number(c.index);
      if (Number.isInteger(index) && index !== pb.index && index >= 0 && index < pb.queue.length) setPlayback(r, s.name, { action: 'index', index, position: c.position ?? 0 });
      break;
    }
    case 'queue': {
      const queue = slim(c.queue);
      if (!queue.length) break;
      const index = Math.max(0, Math.min(Number(c.index) || 0, queue.length - 1));
      setPlayback(r, s.name, { action: 'queue', queue, index, position, playing: c.playing ?? pb.playing });
      break;
    }
  }
  return view(r);
}

export function leave(s: Session, id: string, clientId: string) {
  const r = rooms.get(id.toUpperCase());
  const p = r?.players.get(clientId);
  if (!r || !p || p.username !== s.username) return;
  for (const stream of p.streams) stream.end();
  r.players.delete(clientId);
  if (!r.players.size) return endRoom(r, s.name);
  changed(r);
}

function endRoom(r: Room, by: string) {
  broadcast(r, { ended: true });
  for (const p of r.players.values()) for (const stream of p.streams) stream.end();
  rooms.delete(r.id);
  log.info('together', `${by} ended ${r.hostName}'s room`);
}

/** Only who started it, or an admin, ends it for everyone. */
export function endForEveryone(s: Session, id: string) {
  const r = roomOf(id);
  if (r.host !== s.username && !s.admin) throw new HttpError(403, t('Only {name} can end this room', { name: r.hostName }));
  endRoom(r, s.name);
}

// Every 15 seconds: the time (to keep clocks together, and lines open), and tidying up.
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    for (const p of r.players.values()) {
      for (const stream of p.streams) ping(stream);
      if (!p.streams.size && now - p.lastSeen > GONE_AFTER) {
        r.players.delete(p.clientId);
        changed(r);
      }
    }
    broadcast(r, {});
    const open = [...r.players.values()].some((p) => p.streams.size);
    if (open) r.emptySince = undefined;
    else r.emptySince ??= now;
    if ((r.emptySince && now - r.emptySince > EMPTY_FOR) || now - r.createdAt > MAX_AGE) endRoom(r, 'Tuna');
  }
}, 15_000).unref();

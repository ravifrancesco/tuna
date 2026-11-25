import { useSyncExternalStore } from 'react';
import type { TogetherControl, TogetherEvent, TogetherRoom, Track } from '@tuna/shared';
import { api, ApiError } from '../api';
import { toast } from '../components/ui';
import { t } from '../i18n';
import { clock } from './format';
import { follow, getPlayer, onPlayer, onSeek, pause, play, seek } from './player';
import { getMe } from './session';

/**
 * Play together, this device's side (as Netfish's watch together): which room it's in, following
 * the room (the queue, the song, playing or not, where), and telling the room what happens here.
 */

let room: TogetherRoom | undefined;
let clientId: string | undefined;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

export const useTogether = () =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => room,
  );
export const myClient = () => clientId;

// The server's clock: the largest gap seen lately (messages only ever arrive late).
const gaps: number[] = [];
const serverNow = () => Date.now() + (gaps.length ? Math.max(...gaps) : 0);

/** Changes made here to follow the room aren't sent back to it. */
let quietUntil = 0;
let lastRev = 0;
let lastJump = 0;
let line: EventSource | undefined;

/** One id per room for this tab, so reloading doesn't count it twice. */
function clientFor(id: string) {
  const key = `tuna.together.${id}`;
  try {
    const kept = sessionStorage.getItem(key);
    if (kept) return kept;
    const made = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(key, made);
    return made;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

const ids = (q: Track[]) => q.map((x) => x.id).join(',');
const sourceOf = (r: TogetherRoom) => ({ kind: 'queue' as const, title: r.title || t('Playing together') });

/** Lines the player up with the room: right after someone acts closely, otherwise loosely. */
function followRoom(justChanged: boolean) {
  const r = room;
  if (!r) return;
  const p = r.playback;
  const s = getPlayer();
  const want = Math.max(0, p.position + (p.playing ? (serverNow() - p.at) / 1000 : 0));
  if (s.index < 0 || s.index !== p.index || ids(s.queue) !== ids(p.queue)) {
    quietUntil = Date.now() + 2500;
    lastJump = Date.now();
    follow(p.queue, p.index, want, p.playing, sourceOf(r));
    return;
  }
  if (s.playing !== p.playing) {
    quietUntil = Date.now() + 1500;
    if (p.playing) play();
    else pause();
  }
  const duration = p.queue[p.index]?.duration ?? 0;
  const slack = justChanged ? (p.playing ? 0.75 : 0.25) : 2;
  if (Math.abs(s.time - want) > slack && (justChanged || Date.now() - lastJump > 6000) && !s.buffering && (!duration || want < duration - 1)) {
    quietUntil = Date.now() + 1500;
    lastJump = Date.now();
    seek(p.playing ? want + 0.3 : want);
  }
}

/** "Sam paused", "Sam joined": what others do, briefly. */
function notes(before: TogetherRoom, after: TogetherRoom) {
  const me = getMe()?.name;
  const p = after.playback;
  if (p.rev !== before.playback.rev && p.by !== me) {
    const what = {
      pause: t('{name} paused', { name: p.by }),
      play: t('{name} pressed play', { name: p.by }),
      seek: t('{name} skipped to {time}', { name: p.by, time: clock(p.position) }),
      queue: t('{name} changed what’s playing', { name: p.by }),
    }[p.action as 'pause'];
    if (what) toast(what);
  }
  const was = new Set(before.members.filter((m) => m.here).map((m) => m.clientId));
  const now = new Set(after.members.filter((m) => m.here).map((m) => m.clientId));
  for (const m of after.members) if (m.here && !was.has(m.clientId) && m.clientId !== clientId) toast(t('{name} joined', { name: m.name }));
  for (const m of before.members) if (m.here && !now.has(m.clientId) && !after.members.some((x) => x.clientId === m.clientId)) toast(t('{name} left', { name: m.name }));
}

function receive(next: TogetherRoom) {
  const before = room;
  room = next;
  changed();
  if (before) notes(before, next);
  const fresh = next.playback.rev !== lastRev;
  lastRev = next.playback.rev;
  followRoom(fresh);
}

function ended() {
  if (!room) return;
  toast(t('Room ended. Still playing for you.'));
  close();
}

function close() {
  line?.close();
  line = undefined;
  room = undefined;
  clientId = undefined;
  lastRev = 0;
  changed();
}

function connect(id: string) {
  const key = getMe()?.mediaKey;
  line = new EventSource(`/api/together/${encodeURIComponent(id)}/events?client=${clientId}${key ? `&k=${key}` : ''}`);
  line.onmessage = (m) => {
    const e = JSON.parse(m.data) as TogetherEvent;
    gaps.push(e.now - Date.now());
    if (gaps.length > 20) gaps.shift();
    if (e.ended) ended();
    else if (e.room) receive(e.room);
  };
  line.onerror = () => {
    // The line drops and comes back by itself; a room that's gone doesn't.
    void api.together
      .room(id)
      .then(() => {
        if (line?.readyState === EventSource.CLOSED && clientId) setTimeout(() => clientId && connect(id), 3000);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) ended();
      });
  };
}

export function join(id: string) {
  if (room?.id === id.toUpperCase() && line) return;
  if (room) void leave();
  clientId = clientFor(id.toUpperCase());
  connect(id.toUpperCase());
}

/** A room with what's playing here; others join with its link. */
export async function startTogether(): Promise<TogetherRoom | undefined> {
  const s = getPlayer();
  if (s.index < 0) return undefined;
  const r = await api.together.start({ queue: s.queue, index: s.index, position: s.time, playing: s.playing, title: s.source?.title });
  join(r.id);
  room = r;
  lastRev = r.playback.rev;
  changed();
  return r;
}

export async function leave() {
  const r = room;
  const c = clientId;
  close();
  if (r && c) await api.together.leave(r.id, c).catch(() => {});
}

export async function endForEveryone() {
  if (!room) return;
  await api.together.end(room.id);
  close();
}

function send(c: Omit<TogetherControl, 'clientId'>) {
  const r = room;
  if (!r || !clientId) return;
  void api.together
    .control(r.id, { clientId, ...c })
    .then((next) => {
      // What's sent is already happening here.
      lastRev = next.playback.rev;
      room = next;
      changed();
    })
    .catch((err) => toast(err instanceof Error ? err.message : String(err)));
}

// What happens here goes to the room: another queue or song, play or pause, a seek.
let seen = { queue: getPlayer().queue, index: getPlayer().index, playing: getPlayer().playing };
onPlayer(() => {
  const s = getPlayer();
  const before = seen;
  seen = { queue: s.queue, index: s.index, playing: s.playing };
  const r = room;
  if (!r || Date.now() < quietUntil || s.index < 0) return;
  const p = r.playback;
  if (s.queue !== before.queue && ids(s.queue) !== ids(p.queue)) return send({ action: 'queue', queue: s.queue, index: s.index, position: s.time, playing: s.playing });
  if (s.index !== before.index && s.index !== p.index) return send({ action: 'index', index: s.index, position: 0 });
  if (s.playing !== before.playing && s.playing !== p.playing) send({ action: s.playing ? 'play' : 'pause', position: s.time });
});
onSeek((position) => {
  if (room && Date.now() >= quietUntil) send({ action: 'seek', position });
});

// Loosely in line, every couple of seconds.
setInterval(() => room && followRoom(false), 2000);

import type { ServerResponse } from 'node:http';
import type { Device, DeviceCommand, DevicesEvent, Track } from '@tuna/shared';
import { ping, send } from '../lib/sse';
import type { Session } from '../sessions';

/**
 * Someone's devices, as Spotify Connect: every open Tuna (a phone, a computer, a browser tab) says
 * what it's playing; the others show it, can control it, and can take the music over or hand it on.
 * One plays at a time: starting on one pauses the rest.
 */

interface Kept extends Device {
  queue: Track[];
  index: number;
  source?: unknown;
  lines: Set<ServerResponse>;
}

const people = new Map<string, Map<string, Kept>>();
const mine = (username: string) => {
  let m = people.get(username);
  if (!m) people.set(username, (m = new Map()));
  return m;
};

const shown = ({ id, name, kind, playing, track, position, at, played, queue, index, source }: Kept): Device => {
  const from = (source as { title?: unknown } | undefined)?.title;
  return { id, name, kind, playing, track, position, at, played, next: index >= 0 ? queue.slice(index + 1, index + 21) : [], from: typeof from === 'string' ? from : undefined };
};

function tell(d: Kept, event: Omit<DevicesEvent, 'now'>) {
  for (const line of d.lines) send(line, { now: Date.now(), ...event });
}

function everyone(username: string) {
  const devices = [...mine(username).values()].sort((a, b) => Number(b.playing) - Number(a.playing) || a.name.localeCompare(b.name)).map(shown);
  for (const d of mine(username).values()) tell(d, { devices });
}

/** A device's live line: the list of devices now and whenever it changes, and commands for it. */
export function openDevice(s: Session, id: string, name: string, kind: Device['kind'], line: ServerResponse) {
  const devices = mine(s.username);
  const d = devices.get(id) ?? { id, name, kind, playing: false, position: 0, at: Date.now(), queue: [], index: -1, lines: new Set<ServerResponse>() };
  Object.assign(d, { name, kind });
  d.lines.add(line);
  devices.set(id, d);
  everyone(s.username);
  const keep = setInterval(() => ping(line), 25_000);
  line.on('close', () => {
    clearInterval(keep);
    d.lines.delete(line);
    if (!d.lines.size) devices.delete(id);
    everyone(s.username);
  });
}

/** What a device is playing now (`queue` only when it changed). */
export function report(s: Session, id: string, state: { playing: boolean; index: number; position: number; queue?: Track[]; source?: unknown }) {
  const devices = mine(s.username);
  const d = devices.get(id);
  if (!d) return;
  if (state.queue) d.queue = state.queue;
  // Playing now, or until now: when it last played (opening Tuna somewhere isn't playing there).
  const played = state.playing || d.playing ? Date.now() : d.played;
  Object.assign(d, { playing: state.playing, index: state.index, position: state.position, at: Date.now(), played, source: state.source, track: d.queue[state.index] });
  if (state.playing) {
    for (const o of devices.values()) {
      if (o === d || !o.playing) continue;
      o.playing = false;
      o.played = Date.now();
      tell(o, { command: { type: 'pause' } });
    }
  }
  everyone(s.username);
}

/** Play, pause, skip or seek on another device. */
export function command(s: Session, to: string, cmd: DeviceCommand) {
  const d = mine(s.username).get(to);
  if (d && cmd.type !== 'take') tell(d, { command: cmd });
}

/** The music moves to `to`: from where it's playing (or was last), carrying on where it was. */
export function transfer(s: Session, to: string) {
  const devices = mine(s.username);
  const target = devices.get(to);
  const from = [...devices.values()]
    .filter((d) => d !== target && d.queue.length && d.index >= 0)
    .sort((a, b) => Number(b.playing) - Number(a.playing) || (b.played ?? 0) - (a.played ?? 0) || b.at - a.at)[0];
  if (!target || !from) return false;
  const position = from.position + (from.playing ? (Date.now() - from.at) / 1000 : 0);
  tell(target, { command: { type: 'take', queue: from.queue, index: from.index, position, playing: true, source: from.source } });
  if (from.playing) {
    from.playing = false;
    from.played = Date.now();
    tell(from, { command: { type: 'pause' } });
  }
  return true;
}

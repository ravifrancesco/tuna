import { useSyncExternalStore } from 'react';
import type { NativeAudioState, NativeOutput, NativeTrack, Quality, Track } from '@tuna/shared';
import { app, nativeAudio, onEvent } from './native';
import { coverUrl, getMe, streamUrl } from './session';
import { BANDS, onBrowserEq, type Eq } from './eq';

/**
 * The player: what's queued, what's playing and where. Two engines play it: the app's own player
 * (Mac, Windows, iPhone, Android — the queue lives there, so music carries on with the screen off
 * and the lock screen's buttons work) or the page's <audio> (browsers, Samsung TVs). The page
 * keeps the same queue either way, to show it.
 */

export type Repeat = 'off' | 'all' | 'one';

export interface Source {
  kind: 'album' | 'playlist' | 'mix' | 'liked' | 'artist' | 'search' | 'queue';
  id?: string;
  title?: string;
}

export interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  buffering: boolean;
  time: number;
  duration: number;
  shuffle: boolean;
  repeat: Repeat;
  volume: number;
  source?: Source;
  error?: string;
  /** Where the sound comes out, when the app says (AirPods, a car, AirPlay). */
  output?: NativeOutput;
  /** The sleep timer: stops at `at` (ms since 1970) or at the end of the song. */
  sleep?: { at?: number; endOfSong?: boolean };
  /** On mobile data, as the app says (Automatic plays Normal then). */
  mobileData?: boolean;
}

let state: PlayerState = { queue: [], index: -1, playing: false, buffering: false, time: 0, duration: 0, shuffle: false, repeat: 'off', volume: 1 };
/** The queue in its own order, to go back to when shuffle is turned off. */
let unshuffled: Track[] | undefined;
const listeners = new Set<() => void>();

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
  remember();
}

export const usePlayer = <T>(select: (s: PlayerState) => T): T =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => select(state),
  );

/** Every change to the player (Play together follows them). */
export const onPlayer = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
/** Someone seeking here (not the player catching up). */
let seeked: ((s: number) => void) | undefined;
export const onSeek = (fn: ((s: number) => void) | undefined) => (seeked = fn);

export const current = () => state.queue[state.index];
export const getPlayer = () => state;

// ---- Which file each song should be --------------------------------------------------------------

const browserFormats = (() => {
  const a = document.createElement('audio');
  const can = (type: string) => a.canPlayType(type) !== '';
  const out = ['mp3', 'wav'];
  if (can('audio/mp4; codecs="mp4a.40.2"')) out.push('aac', 'm4a');
  if (can('audio/flac')) out.push('flac');
  if (can('audio/ogg; codecs="opus"') || can('audio/webm; codecs="opus"')) out.push('opus', 'ogg');
  if (can('audio/mp4; codecs="alac"')) out.push('alac');
  return out;
})();

/** What the app says (no answer, as when the page wakes from sleep: as it was). */
function mobileData(on: boolean | undefined) {
  if (on === undefined || on === Boolean(state.mobileData)) return;
  set({ mobileData: on });
  // Automatic: what comes next follows the network (the song playing carries on), and so do the
  // songs the app keeps ahead.
  if ((getMe()?.prefs.quality ?? 'auto') === 'auto' && state.index >= 0) engine().update(state.queue, state.index);
}
const refreshMobileData = () => void app.mobileData().then(mobileData);
refreshMobileData();
setInterval(refreshMobileData, 60_000);
// The page sleeps with the screen off: again as soon as it's back, and whenever the app says.
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshMobileData());
onEvent((name, value) => name === 'mobileData' && mobileData(Boolean(value)));

/** Each level's bit rate: Opus where the player has it (as good at less), else MP3. */
const TIERS = { low: { opus: 96, mp3: 128 }, normal: { opus: 160, mp3: 192 }, high: { opus: 256, mp3: 320 } } as const;

export function fileFor(t: Track, level?: Quality): { format: string; bitRate?: number } {
  const formats = nativeAudio?.formats ?? browserFormats;
  const chosen = level ?? getMe()?.prefs.quality ?? 'auto';
  const quality = chosen === 'auto' ? (state.mobileData ? 'normal' : 'original') : chosen;
  if (quality === 'original' && t.suffix && formats.includes(t.suffix.toLowerCase())) return { format: 'raw' };
  const tier = TIERS[quality === 'original' ? 'high' : quality];
  return formats.includes('opus') ? { format: 'opus', bitRate: tier.opus } : { format: 'mp3', bitRate: tier.mp3 };
}

/** What a song is playing as: "FLAC · 1,411 kbps", "OPUS · 160 kbps". */
export function playingAs(t: Track): string {
  const f = fileFor(t);
  if (f.format === 'raw') return [t.suffix?.toUpperCase(), t.bitRate ? `${t.bitRate.toLocaleString()} kbps` : undefined].filter(Boolean).join(' · ');
  return `${f.format.toUpperCase()} · ${f.bitRate} kbps`;
}

export function nativeTrack(t: Track, level?: Quality): NativeTrack {
  const f = fileFor(t, level);
  const url = streamUrl(t.id, f.format, f.bitRate);
  // Automatic: mobile data's address too, so the app follows the network while the page sleeps.
  const m = (level ?? getMe()?.prefs.quality ?? 'auto') === 'auto' ? fileFor(t, 'normal') : undefined;
  const mobileUrl = m && streamUrl(t.id, m.format, m.bitRate);
  return { id: t.id, url, ...(mobileUrl && mobileUrl !== url ? { mobileUrl } : {}), title: t.title, artist: t.artist, album: t.album, artwork: coverUrl(t.cover, 600), duration: t.duration, liked: Boolean(t.liked) };
}

// ---- Engines -----------------------------------------------------------------------------------------

interface Engine {
  load(tracks: Track[], index: number, start: number, play: boolean): void;
  update(tracks: Track[], index: number): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  jump(index: number): void;
  next(): void;
  previous(): void;
  repeat(mode: Repeat): void;
  volume(v: number): void;
  stop(): void;
}

// The queue set from elsewhere (Android Auto): the page takes what the app has.
let catchingUp = false;
function catchUp() {
  if (catchingUp || !na) return;
  catchingUp = true;
  void na
    .current()
    .then((now) => {
      if (!now?.tracks.length) return;
      const byId = new Map(state.queue.map((t) => [t.id, t]));
      unshuffled = undefined;
      set({ queue: now.tracks.map((n) => byId.get(n.id) ?? fromNative(n)), index: now.index, source: undefined, shuffle: false });
      applyNative(now.state);
    })
    .finally(() => (catchingUp = false));
}

function applyNative(s: NativeAudioState) {
  if (s.id && s.id !== state.queue[s.index]?.id) return catchUp();
  const patch: Partial<PlayerState> = { playing: s.playing, buffering: Boolean(s.buffering), time: s.time, duration: s.duration || current()?.duration || 0 };
  if (s.index >= 0 && s.index < state.queue.length) patch.index = s.index;
  patch.error = s.error;
  if (s.output) patch.output = s.output;
  if (na?.sleep) patch.sleep = s.sleep;
  if (s.ended) patch.playing = false;
  set(patch);
}

const na = nativeAudio;
const nativeEngine: Engine | undefined = na && {
  load: (tracks, index, start, play) => na.load(tracks.map((t) => nativeTrack(t)), index, start, play),
  update: (tracks, index) => na.update(tracks.map((t) => nativeTrack(t)), index),
  play: () => na.command('play'),
  pause: () => na.command('pause'),
  seek: (s) => na.command('seek', s),
  jump: (i) => na.command('jump', i),
  next: () => na.command('next'),
  previous: () => na.command('previous'),
  repeat: (m) => na.command('repeat', m),
  volume: (v) => na.command('volume', v),
  stop: () => na.command('stop'),
};

/** The page's own player: two <audio>s, so the next song is ready when this one ends. */
let webAudio: (HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void }) | undefined;

// The equalizer in a browser: the page's player through six filters, built the first time it's on
// (so casting from Chrome keeps working for whoever never uses it).
let graph: { ctx: AudioContext; filters: BiquadFilterNode[]; pre: GainNode } | undefined;
function browserEq(e: Eq) {
  if (!graph) {
    if (!e.on) return;
    engine();
    if (!webAudio) return;
    const ctx = new AudioContext();
    const filters = BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1;
      return b;
    });
    const pre = ctx.createGain();
    [ctx.createMediaElementSource(webAudio), pre, ...filters].reduce((from, to) => (from.connect(to), to)).connect(ctx.destination);
    graph = { ctx, filters, pre };
  }
  const { ctx, filters, pre } = graph;
  const gains = e.on ? e.gains : e.gains.map(() => 0);
  filters.forEach((b, i) => b.gain.setTargetAtTime(gains[i], ctx.currentTime, 0.02));
  // Lowered by the highest boost, so nothing clips.
  pre.gain.setTargetAtTime(10 ** (-Math.max(0, ...gains) / 20), ctx.currentTime, 0.02);
  if (ctx.state === 'suspended') void ctx.resume();
}

function makeWebEngine(): Engine {
  const audio = new Audio();
  audio.preload = 'auto';
  webAudio = audio;
  // Playing on a Chromecast (Chrome) through the page's own player.
  audio.remote?.addEventListener('connect', () => set({ output: { name: 'Chromecast', kind: 'cast' } }));
  audio.remote?.addEventListener('disconnect', () => set({ output: undefined }));
  const ahead = new Audio();
  ahead.preload = 'auto';
  let tracks: Track[] = [];
  let index = -1;
  let repeat: Repeat = 'off';

  const nextIndex = () => (index + 1 < tracks.length ? index + 1 : repeat === 'all' && tracks.length ? 0 : -1);

  function prepareAhead() {
    const n = nextIndex();
    const url = n >= 0 ? nativeTrack(tracks[n]).url : '';
    if (url && ahead.src !== url) ahead.src = url;
  }

  function start(i: number, at: number, play: boolean) {
    index = i;
    const t = tracks[i];
    if (!t) return;
    const url = nativeTrack(t).url;
    audio.src = ahead.src === url ? ahead.src : url;
    audio.currentTime = at;
    set({ index: i, time: at, duration: t.duration, error: undefined });
    if (play) void audio.play().catch(() => set({ playing: false }));
    mediaSession(t);
    prepareAhead();
  }

  audio.addEventListener('timeupdate', () => set({ time: audio.currentTime }));
  audio.addEventListener('durationchange', () => Number.isFinite(audio.duration) && set({ duration: audio.duration }));
  audio.addEventListener('playing', () => set({ playing: true, buffering: false }));
  audio.addEventListener('play', () => graph?.ctx.state === 'suspended' && void graph.ctx.resume());
  audio.addEventListener('pause', () => set({ playing: false }));
  audio.addEventListener('waiting', () => set({ buffering: true }));
  audio.addEventListener('canplay', () => set({ buffering: false }));
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    set({ playing: false, buffering: false, error: 'error' });
    // Skip what can't be played rather than stopping the music.
    if (nextIndex() >= 0) setTimeout(() => start(nextIndex(), 0, true), 800);
  });
  audio.addEventListener('ended', () => {
    if (state.sleep?.endOfSong) {
      // The sleep timer: the next song waits, paused at its start.
      set({ sleep: undefined });
      const n = nextIndex();
      return n >= 0 ? start(n, 0, false) : set({ playing: false, time: 0 });
    }
    if (repeat === 'one') return start(index, 0, true);
    const n = nextIndex();
    if (n >= 0) start(n, 0, true);
    else set({ playing: false, time: 0 });
  });

  return {
    load(ts, i, at, play) {
      tracks = ts;
      start(i, at, play);
    },
    update(ts, i) {
      tracks = ts;
      index = i;
      prepareAhead();
    },
    play: () => void audio.play().catch(() => undefined),
    pause: () => audio.pause(),
    seek: (s) => {
      audio.currentTime = s;
      set({ time: s });
    },
    jump: (i) => start(i, 0, true),
    next: () => {
      const n = nextIndex();
      if (n >= 0) start(n, 0, true);
    },
    previous: () => (audio.currentTime > 3 || index === 0 ? ((audio.currentTime = 0), set({ time: 0 })) : start(index - 1, 0, true)),
    repeat: (m) => {
      repeat = m;
      prepareAhead();
    },
    volume: (v) => (audio.volume = v),
    stop: () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    },
  };
}

function mediaSession(t: Track) {
  if (!('mediaSession' in navigator)) return;
  const art = coverUrl(t.cover, 600);
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art ? [{ src: art, sizes: '600x600' }] : [] });
}

let webEngine: Engine | undefined;
const engine = (): Engine => nativeEngine ?? (webEngine ??= makeWebEngine());

if (nativeAudio) nativeAudio.onState(applyNative);

if ('mediaSession' in navigator && !nativeAudio) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => play());
  ms.setActionHandler('pause', () => pause());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', () => previous());
  ms.setActionHandler('seekto', (d) => d.seekTime !== undefined && seek(d.seekTime));
}

// ---- What people do ------------------------------------------------------------------------------------

if (!nativeEngine) onBrowserEq(browserEq);

/** In a browser: the music to a Chromecast (Chrome) or an AirPlay speaker (Safari), from a button. */
export const browserOutputs =
  !nativeEngine && typeof HTMLMediaElement !== 'undefined' && ('remote' in HTMLMediaElement.prototype || 'webkitShowPlaybackTargetPicker' in HTMLMediaElement.prototype)
    ? () => {
        engine();
        if (webAudio?.webkitShowPlaybackTargetPicker) webAudio.webkitShowPlaybackTargetPicker();
        else void webAudio?.remote.prompt().catch(() => {});
      }
    : undefined;

const shuffled = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function playTracks(tracks: Track[], index = 0, source?: Source, opts: { shuffle?: boolean } = {}) {
  if (!tracks.length) return;
  const shuffle = opts.shuffle ?? state.shuffle;
  let queue = tracks;
  let i = Math.max(0, Math.min(index, tracks.length - 1));
  unshuffled = undefined;
  if (shuffle) {
    unshuffled = tracks;
    const first = opts.shuffle && index === 0 ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[i];
    queue = [first, ...shuffled(tracks.filter((t) => t !== first))];
    i = 0;
  }
  set({ queue, index: i, shuffle, source, time: 0, duration: queue[i].duration, playing: true, error: undefined });
  engine().load(queue, i, 0, true);
  engine().repeat(state.repeat);
}

/** The quality changed: the song carries on from where it was, in the new quality, and so does the rest. */
export function reloadQueue() {
  if (state.index < 0) return;
  engine().load(state.queue, state.index, state.time, state.playing);
  engine().repeat(state.repeat);
}

/** Signing out or changing server: the music stops and the queue empties. */
export function stopAll() {
  engine().stop();
  unshuffled = undefined;
  set({ queue: [], index: -1, playing: false, time: 0, duration: 0, source: undefined, error: undefined });
}

export const play = () => (state.index < 0 ? undefined : engine().play());
export const pause = () => engine().pause();
export const toggle = () => (state.playing ? pause() : play());
export const seek = (s: number) => {
  set({ time: s });
  engine().seek(s);
  seeked?.(s);
};

/** Play together: the room's queue, from where the room is, playing or not. */
export function follow(tracks: Track[], index: number, position: number, playing: boolean, source?: Source) {
  if (!tracks.length) return;
  const i = Math.max(0, Math.min(index, tracks.length - 1));
  unshuffled = undefined;
  set({ queue: tracks, index: i, shuffle: false, source, time: position, duration: tracks[i].duration, playing, error: undefined });
  engine().load(tracks, i, position, playing);
  engine().repeat(state.repeat);
}
export const next = () => engine().next();
export const previous = () => engine().previous();
export const jump = (i: number) => engine().jump(i);
export const setVolume = (v: number) => {
  set({ volume: v });
  engine().volume(v);
};

export function cycleRepeat() {
  const repeat: Repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  set({ repeat });
  engine().repeat(repeat);
}

function replaceQueue(queue: Track[], index: number) {
  set({ queue, index });
  engine().update(queue, index);
}

export function setShuffle(on: boolean) {
  const now = current();
  if (!now) return set({ shuffle: on });
  if (on) {
    unshuffled = state.queue;
    const rest = shuffled(state.queue.filter((_, i) => i !== state.index));
    set({ shuffle: true });
    replaceQueue([now, ...rest], 0);
  } else {
    const back = unshuffled ?? state.queue;
    unshuffled = undefined;
    set({ shuffle: false });
    replaceQueue(back, Math.max(0, back.indexOf(now)));
  }
}

export function playNext(tracks: Track[]) {
  if (state.index < 0) return playTracks(tracks, 0, { kind: 'queue' });
  const q = [...state.queue];
  q.splice(state.index + 1, 0, ...tracks);
  unshuffled = unshuffled ? [...unshuffled, ...tracks] : undefined;
  replaceQueue(q, state.index);
}

/** New songs into what's playing: a few songs apart from two ahead, or one after another from `at`. */
export function slipIn(tracks: Track[], at?: number) {
  if (state.index < 0 || !tracks.length) return;
  const q = [...state.queue];
  tracks.forEach((t, i) => q.splice(Math.min(q.length, at !== undefined ? at + i : state.index + 2 + i * 3), 0, t));
  unshuffled = unshuffled ? [...unshuffled, ...tracks] : undefined;
  replaceQueue(q, state.index);
}

export function addToQueue(tracks: Track[]) {
  if (state.index < 0) return playTracks(tracks, 0, { kind: 'queue' });
  unshuffled = unshuffled ? [...unshuffled, ...tracks] : undefined;
  replaceQueue([...state.queue, ...tracks], state.index);
}

export function removeFromQueue(i: number) {
  if (i === state.index) return;
  const q = state.queue.filter((_, j) => j !== i);
  replaceQueue(q, i < state.index ? state.index - 1 : state.index);
}

// The sleep timer: the app keeps it where it can (so it stops with the screen off), else the page.
let sleepTimer: number | undefined;
export function setSleep(pick: { minutes?: number; endOfSong?: boolean } | undefined) {
  clearTimeout(sleepTimer);
  const sleep = pick?.minutes ? { at: Date.now() + pick.minutes * 60_000 } : pick?.endOfSong ? { endOfSong: true } : undefined;
  set({ sleep });
  if (na?.sleep) return na.sleep(pick ?? {});
  if (sleep?.at) sleepTimer = window.setTimeout(() => (pause(), set({ sleep: undefined })), sleep.at - Date.now());
}

/** Everything after the song playing goes. */
export function clearQueue() {
  if (state.index < 0) return;
  unshuffled = undefined;
  replaceQueue(state.queue.slice(0, state.index + 1), state.index);
}

export function moveInQueue(from: number, to: number) {
  if (from === state.index || to <= state.index) return;
  const q = [...state.queue];
  const [t] = q.splice(from, 1);
  q.splice(to, 0, t);
  replaceQueue(q, state.index);
}

/** A song changed (liked from somewhere else): the queue shows it. */
export function patchTrack(id: string, patch: Partial<Track>) {
  if (!state.queue.some((t) => t.id === id)) return;
  set({ queue: state.queue.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

// ---- Back where it was after a reload ----------------------------------------------------------------

const KEY = 'tuna.player';
let rememberTimer: number | undefined;
function remember() {
  if (rememberTimer) return;
  rememberTimer = window.setTimeout(() => {
    rememberTimer = undefined;
    try {
      const { queue, index, time, shuffle, repeat, source, volume } = state;
      localStorage.setItem(KEY, JSON.stringify({ queue: queue.slice(0, 500), index, time, shuffle, repeat, source, volume }));
    } catch {
      /* storage full or blocked */
    }
  }, 1000);
}

let restored = false;
export async function restore() {
  if (restored) return;
  restored = true;
  let saved: Partial<PlayerState> | undefined;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined;
  } catch {
    saved = undefined;
  }
  if (nativeAudio) {
    // The app may still be playing what was queued before the page reloaded: show that, and never
    // load over it. Songs the page didn't keep (long queues) come back from what the app knows.
    const now = await nativeAudio.current();
    if (now?.tracks.length) {
      const byId = new Map((saved?.queue ?? []).map((t) => [t.id, t]));
      const queue = now.tracks.map((n) => byId.get(n.id) ?? fromNative(n));
      set({ shuffle: saved?.shuffle ?? false, source: saved?.source, volume: saved?.volume ?? 1, queue, index: now.index, repeat: now.state.repeat ?? saved?.repeat ?? 'off' });
      applyNative(now.state);
      return;
    }
  }
  if (saved?.queue?.length && saved.index !== undefined && saved.index >= 0) {
    set({ queue: saved.queue, index: saved.index, time: saved.time ?? 0, shuffle: saved.shuffle ?? false, repeat: saved.repeat ?? 'off', source: saved.source, volume: saved.volume ?? 1, playing: false });
    engine().load(saved.queue, saved.index, saved.time ?? 0, false);
    engine().repeat(state.repeat);
    engine().volume(state.volume);
  }
}

/** A song as the app reported it: enough to show it (its cover id is in the artwork address). */
function fromNative(n: NativeTrack): Track {
  const cover = n.artwork?.match(/\/api\/cover\/([^?]+)/)?.[1];
  return { id: n.id, title: n.title, artist: n.artist, album: n.album, duration: n.duration, cover: cover ? decodeURIComponent(cover) : undefined, liked: n.liked };
}

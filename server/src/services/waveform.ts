import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { subsonicUrl, type SubsonicAuth } from '../clients/navidrome';
import { config } from '../config';
import { log } from '../lib/log';
import { writeJson } from '../lib/storage';

/**
 * Each song's shape, for the waveform seek bar: the file read once with ffmpeg, boiled down to
 * 800 bar heights (0–255, its loudness along the way) and kept on disk, so every song is measured
 * only once. One song at a time, so the server isn't kept busy. Started as a song begins to play,
 * so Now Playing usually finds it ready.
 */

const BARS = 800;
const RATE = 4000;
const DIR = () => path.join(config.dataDir, 'cache', 'waves');
const DAY = 24 * 3600 * 1000;

export interface Wave {
  peaks: number[];
}

const VERSION = 3;
const fileOf = (id: string) => path.join(DIR(), `${id.replace(/[^\w-]/g, '_')}.v${VERSION}.json`);
const inflight = new Map<string, Promise<Wave | null>>();
let queue: Promise<unknown> = Promise.resolve();
let ffmpeg: boolean | undefined;

export function hasFfmpeg(): Promise<boolean> {
  if (ffmpeg !== undefined) return Promise.resolve(ffmpeg);
  return new Promise((resolve) => {
    const p = spawn(process.env.FFMPEG ?? 'ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve((ffmpeg = false)));
    p.on('exit', (code) => resolve((ffmpeg = code === 0)));
  }).then((ok) => {
    if (!ok) log.warn('waveforms', 'ffmpeg is missing: the seek bar stays plain');
    return ok as boolean;
  });
}

/** The song as mono samples, fed to ffmpeg from Navidrome (the address, with its token, stays inside Tuna). */
function decode(url: string, background: boolean): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG ?? 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // At night it gives way to anything else the server is doing.
    if (background && p.pid) {
      try {
        os.setPriority(p.pid, 15);
      } catch {
        /* not allowed here: it runs at normal priority */
      }
    }
    const chunks: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.on('error', reject);
    p.stdin.on('error', () => undefined);
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      p.kill('SIGKILL');
    }, 120_000);
    p.on('exit', () => {
      clearTimeout(timer);
      const all = Buffer.concat(chunks);
      if (all.length < 2) return reject(new Error('no sound'));
      resolve(new Int16Array(all.buffer, all.byteOffset, Math.floor(all.length / 2)));
    });
    fetch(url, { signal: abort.signal })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error(`Navidrome ${res.status}`);
        Readable.fromWeb(res.body as never).pipe(p.stdin);
      })
      .catch((err) => {
        p.stdin.destroy();
        p.kill();
        reject(err);
      });
  });
}

/** 800 bars: how loud each slice is on average (loudness, not the odd peak), against the loudest. */
function peaksOf(samples: Int16Array): number[] {
  const per = samples.length / BARS;
  const raw: number[] = [];
  for (let b = 0; b < BARS; b++) {
    let sum = 0;
    const start = Math.floor(b * per);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((b + 1) * per)));
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    raw.push(Math.sqrt(sum / (end - start)));
  }
  const top = Math.max(1, ...raw);
  return raw.map((v) => Math.round((v / top) ** 0.85 * 255));
}

function read(id: string): { at: number; wave: Wave | null } | undefined {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Measured already (or tried within the day). */
export const isMeasured = (id: string) => fs.existsSync(fileOf(id));

/** A song's waveform: kept, or measured now (waiting for its turn). Null when it can't be. */
export function waveOf(auth: SubsonicAuth, id: string, background = false): Promise<Wave | null> {
  const kept = read(id);
  if (kept && (kept.wave || Date.now() - kept.at < DAY)) return Promise.resolve(kept.wave);
  const pending = inflight.get(id);
  if (pending) return pending;
  const job = (queue = queue.catch(() => undefined).then(async () => {
    if (!(await hasFfmpeg())) return null;
    let wave: Wave | null = null;
    try {
      wave = { peaks: peaksOf(await decode(subsonicUrl(auth, 'stream', { id, format: 'raw' }), background)) };
    } catch (err) {
      log.debug('waveforms', `Couldn't measure ${id}: ${String(err)}`);
    }
    try {
      writeJson(fileOf(id), { at: Date.now(), wave });
    } catch {
      /* a cache only */
    }
    return wave;
  })).finally(() => inflight.delete(id)) as Promise<Wave | null>;
  inflight.set(id, job);
  return job;
}

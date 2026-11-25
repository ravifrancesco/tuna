import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, userAgent } from '../config';
import { log } from './log';

/**
 * Covers kept on Tuna's own disk: Navidrome's (their ids change when the picture does) and the
 * Cover Art Archive's for music that isn't here yet. The first view costs one fetch; every later
 * one is a file read. The oldest go when the cache passes IMAGE_CACHE_MB (512 by default).
 */

const DIR = () => path.join(config.dataDir, 'cache', 'images');
const LIMIT = (Number(process.env.IMAGE_CACHE_MB) || 512) * 1024 * 1024;
const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const TYPE: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type]));

export interface CachedImage {
  file: string;
  type: string;
}

const inflight = new Map<string, Promise<CachedImage | undefined>>();
let writes = 0;

function find(hash: string): CachedImage | undefined {
  for (const ext of Object.keys(TYPE)) {
    const file = path.join(DIR(), `${hash}.${ext}`);
    if (fs.existsSync(file)) return { file, type: TYPE[ext] };
  }
  return undefined;
}

function trim() {
  try {
    const files = fs.readdirSync(DIR()).map((name) => {
      const file = path.join(DIR(), name);
      const st = fs.statSync(file);
      return { file, size: st.size, used: st.atimeMs };
    });
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= LIMIT * 0.9) break;
      fs.rmSync(f.file, { force: true });
      total -= f.size;
    }
  } catch {
    /* next time */
  }
}

/** A picture by key, fetched from `url` the first time. A missing picture gives undefined. */
export function cachedImage(key: string, url: string): Promise<CachedImage | undefined> {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  const hit = find(hash);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(hash);
  if (pending) return pending;
  const job = (async () => {
    try {
      const res = await fetch(url, { headers: { 'user-agent': userAgent() }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!res.ok || !EXT[type]) return undefined;
      const body = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(DIR(), { recursive: true });
      const file = path.join(DIR(), `${hash}.${EXT[type]}`);
      fs.writeFileSync(file, body);
      if (++writes % 50 === 0) trim();
      return { file, type };
    } catch (err) {
      log.debug('images', `${String(err)}`);
      return undefined;
    } finally {
      inflight.delete(hash);
    }
  })();
  inflight.set(hash, job);
  return job;
}

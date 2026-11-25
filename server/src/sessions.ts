import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { login as ndLogin, type SubsonicAuth } from './clients/navidrome';
import { config } from './config';
import { t } from './lib/i18n';
import { log } from './lib/log';
import { writeJson } from './lib/storage';
import { HttpError } from './lib/upstream';

/**
 * Signing in goes through Navidrome. Tuna keeps what Navidrome gives back (a Subsonic token, never
 * the password) for each signed-in device, in the data folder, so people stay signed in across
 * restarts. The browser holds a random session id in an HttpOnly cookie; the apps' own players
 * use the session's media key, which only opens music and covers.
 */

export interface Session {
  id: string;
  userId: string;
  username: string;
  name: string;
  admin: boolean;
  salt: string;
  token: string;
  /** Navidrome's own sign-in, for admins' household settings (it renews itself as it's used). */
  jwt: string;
  mediaKey: string;
  created: number;
  seen: number;
}

export const COOKIE = 'tuna_session';
const FILE = () => path.join(config.dataDir, 'sessions.json');
const YEAR = 365 * 24 * 3600 * 1000;

const sessions = new Map<string, Session>();
const byMediaKey = new Map<string, Session>();

(function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Session[];
    for (const s of list) {
      if (Date.now() - s.seen > YEAR) continue;
      sessions.set(s.id, s);
      byMediaKey.set(s.mediaKey, s);
    }
  } catch {
    /* none yet */
  }
})();

let saveTimer: NodeJS.Timeout | undefined;
function save(now = false) {
  const write = () => {
    saveTimer = undefined;
    try {
      writeJson(FILE(), [...sessions.values()], 0o600);
    } catch (err) {
      log.warn('sign-in', "Couldn't save sessions", err);
    }
  };
  if (now) return write();
  saveTimer ??= setTimeout(write, 5000);
}

const random = () => crypto.randomBytes(24).toString('base64url');

export const authOf = (s: Session): SubsonicAuth => ({ username: s.username, token: s.token, salt: s.salt });

export async function signIn(username: string, password: string): Promise<Session> {
  if (!username.trim()) throw new HttpError(400, t('Username is required'));
  const r = await ndLogin(username.trim(), password);
  const session: Session = {
    id: random(),
    userId: r.id,
    username: r.username,
    name: r.name || r.username,
    admin: r.isAdmin,
    salt: r.subsonicSalt,
    token: r.subsonicToken,
    jwt: r.token,
    mediaKey: random(),
    created: Date.now(),
    seen: Date.now(),
  };
  sessions.set(session.id, session);
  byMediaKey.set(session.mediaKey, session);
  save(true);
  log.info('sign-in', `${session.name} signed in`);
  return session;
}

export function signOut(session: Session) {
  sessions.delete(session.id);
  byMediaKey.delete(session.mediaKey);
  save(true);
}

/** Someone's password changed or they were removed: every device of theirs signs in again. */
export function endSessionsOf(username: string) {
  for (const s of sessions.values()) if (s.username === username) signOut(s);
}

export function setCookie(reply: FastifyReply, session: Session) {
  reply.setCookie(COOKIE, session.id, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: YEAR / 1000 });
}

function touch(s: Session) {
  if (Date.now() - s.seen > 60_000) {
    s.seen = Date.now();
    save();
  }
  return s;
}

export function sessionOf(req: FastifyRequest): Session | undefined {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const id = bearer ?? req.cookies[COOKIE];
  const s = id ? sessions.get(id) : undefined;
  return s ? touch(s) : undefined;
}

/** Music and covers: the cookie, or the media key in the address (the apps' players, lock screens). */
export function mediaSessionOf(req: FastifyRequest): Session | undefined {
  const key = (req.query as { k?: string }).k;
  const s = (key && byMediaKey.get(key)) || sessionOf(req);
  return s ? touch(s) : undefined;
}

export function requireUser(req: FastifyRequest): Session {
  const s = sessionOf(req);
  if (!s) throw new HttpError(401, t('Please sign in'));
  return s;
}

export function requireAdmin(req: FastifyRequest): Session {
  const s = requireUser(req);
  if (!s.admin) throw new HttpError(403, t('Admins only'));
  return s;
}

/** When each person last used Tuna (for the household list). */
export function lastSeen(): Map<string, number> {
  const seen = new Map<string, number>();
  for (const s of sessions.values()) seen.set(s.username, Math.max(seen.get(s.username) ?? 0, s.seen));
  return seen;
}

/** For work the server does by itself (measuring waveforms at night): the admin seen most recently. */
export function adminAuth(): SubsonicAuth | undefined {
  const admin = [...sessions.values()].filter((s) => s.admin).sort((a, b) => b.seen - a.seen)[0];
  return admin ? authOf(admin) : undefined;
}

export function saveSessions() {
  save();
}

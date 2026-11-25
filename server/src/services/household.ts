import type { Person } from '@tuna/shared';
import { native, type NdUser } from '../clients/navidrome';
import { t } from '../lib/i18n';
import { log } from '../lib/log';
import { HttpError, UpstreamError } from '../lib/upstream';
import { endSessionsOf, lastSeen, saveSessions, type Session } from '../sessions';
import { forgetListens } from './listens';

/** Who can use Tuna: Navidrome's accounts, managed by admins from Tuna's settings. */

/**
 * Navidrome's own sign-in (kept from when the admin signed in) runs out after a while unused; that
 * only means signing in again to manage the household, not being signed out of Tuna.
 */
const call = <T>(admin: Session, method: string, path: string, body?: unknown) =>
  native<T>(admin.jwt, method, path, body, (jwt) => {
    admin.jwt = jwt;
    saveSessions();
  }).catch((err: unknown) => {
    if (err instanceof UpstreamError && err.status === 401) throw new HttpError(409, t('To change the household, sign out and sign in again'));
    throw err;
  });

export async function people(admin: Session): Promise<Person[]> {
  const users = await call<NdUser[]>(admin, 'GET', '/user?_sort=name&_order=ASC&_start=0&_end=200');
  const seen = lastSeen();
  return users.map((u) => {
    const at = seen.get(u.userName) ?? (u.lastAccessAt ? Date.parse(u.lastAccessAt) : 0);
    return { id: u.id, username: u.userName, name: u.name || u.userName, admin: u.isAdmin, lastSeen: at ? new Date(at).toISOString() : undefined };
  });
}

export async function addPerson(admin: Session, p: { username: string; name?: string; password: string; admin?: boolean }): Promise<Person> {
  const username = p.username.trim();
  if (!username) throw new HttpError(400, t('Username is required'));
  if ((p.password ?? '').length < 4) throw new HttpError(400, t('The password needs at least 4 characters'));
  const u = await call<NdUser>(admin, 'POST', '/user', { userName: username, name: p.name?.trim() || username, password: p.password, isAdmin: Boolean(p.admin) });
  log.info('household', `${admin.name} added ${u.name || username}${p.admin ? ' (admin)' : ''}`);
  return { id: u.id, username: u.userName, name: u.name || u.userName, admin: u.isAdmin };
}

export async function changePerson(admin: Session, id: string, change: { name?: string; password?: string; admin?: boolean }): Promise<Person> {
  const users = await call<NdUser[]>(admin, 'GET', '/user?_start=0&_end=200');
  const u = users.find((x) => x.id === id);
  if (!u) throw new HttpError(404, t('Not found'));
  if (change.password !== undefined && change.password.length < 4) throw new HttpError(400, t('The password needs at least 4 characters'));
  const body = {
    ...u,
    name: change.name?.trim() || u.name,
    isAdmin: change.admin ?? u.isAdmin,
    ...(change.password ? { password: change.password, changePassword: true } : {}),
  };
  const saved = await call<NdUser>(admin, 'PUT', `/user/${id}`, body);
  if (change.password) {
    endSessionsOf(u.userName);
    log.info('household', `${admin.name} changed ${u.name || u.userName}'s password`);
  }
  return { id: saved.id ?? id, username: saved.userName ?? u.userName, name: saved.name ?? body.name, admin: saved.isAdmin ?? body.isAdmin };
}

export async function removePerson(admin: Session, id: string) {
  const users = await call<NdUser[]>(admin, 'GET', '/user?_start=0&_end=200');
  const u = users.find((x) => x.id === id);
  if (!u) throw new HttpError(404, t('Not found'));
  if (u.userName === admin.username) throw new HttpError(400, t("You can't remove yourself"));
  await call(admin, 'DELETE', `/user/${id}`);
  endSessionsOf(u.userName);
  forgetListens(u.userName);
  log.info('household', `${admin.name} removed ${u.name || u.userName}`);
}

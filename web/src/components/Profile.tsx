import { Link } from 'react-router';
import type { Me } from '@tuna/shared';
import { api, setBearer } from '../api';
import { forgetPages } from '../lib/keep';
import { stopAll } from '../lib/player';
import { setMe, useMe } from '../lib/session';

export async function signOut() {
  await api.logout().catch(() => undefined);
  stopAll();
  forgetPages();
  setBearer(undefined);
  setMe(undefined);
}

export const Avatar = ({ me, size = 32 }: { me: Pick<Me, 'name' | 'username'>; size?: number }) => (
  <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.44 }} aria-hidden>
    {(me.name || me.username).trim().charAt(0).toUpperCase()}
  </span>
);

/** Who's signed in, at the top of Home: their profile. */
export function ProfileButton() {
  const me = useMe();
  if (!me) return null;
  return (
    <Link className="profile-btn" to="/profile" aria-label={me.name}>
      <Avatar me={me} />
    </Link>
  );
}

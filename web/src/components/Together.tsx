import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Copy, Share2 } from 'lucide-react';
import { api } from '../api';
import { t, tn } from '../i18n';
import { getMe, useMe } from '../lib/session';
import { endForEveryone, join, leave, myClient, startTogether, useTogether } from '../lib/together';
import { Item } from './Menu';
import { Cover, Sheet, toast } from './ui';

/** Play together's mark: two notes, their heads two fish. */
export const TogetherIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 17V6.2M19 15V4.2" />
    <path d="M9 6.2 19 4.2" strokeWidth="2.6" />
    <ellipse cx="6.6" cy="17" rx="2.6" ry="2" fill="currentColor" stroke="none" />
    <path d="M4.4 17 2 15.2v3.6z" fill="currentColor" stroke="none" />
    <ellipse cx="16.6" cy="15" rx="2.6" ry="2" fill="currentColor" stroke="none" />
    <path d="M14.4 15 12 13.2v3.6z" fill="currentColor" stroke="none" />
  </svg>
);

let openSheet: ((open: boolean) => void) | undefined;
export const showTogether = () => openSheet?.(true);

/** In the player's menu: start a room with what's playing (or show the one this is in). */
export function TogetherItem() {
  const room = useTogether();
  return (
    <Item
      icon={<TogetherIcon size={18} />}
      onClick={async () => {
        if (!room) await startTogether().catch((err: Error) => toast(err.message));
        showTogether();
      }}
    >
      {room ? t('Playing together') : t('Play together')}
    </Item>
  );
}

/** Shows this is playing together, and how many are listening; opens the room. */
export function TogetherChip({ className = '' }: { className?: string }) {
  const room = useTogether();
  if (!room) return null;
  const n = room.members.filter((m) => m.here).length;
  return (
    <button className={`together-chip ${className}`} onClick={(e) => (e.stopPropagation(), showTogether())}>
      <TogetherIcon size={15} /> {n > 1 ? tn(n, '{n} listening', '{n} listening') : t('Just you')}
    </button>
  );
}

/** The room: its link, who's in it, leaving or ending it. */
export function TogetherSheetHost() {
  const [open, setOpen] = useState(false);
  const room = useTogether();
  const me = useMe();
  useEffect(() => {
    openSheet = setOpen;
    return () => void (openSheet = undefined);
  }, []);
  if (!open || !room) return null;
  const link = `${location.origin}/together/${room.id}`;
  const share = async () => {
    if (navigator.share) return void navigator.share({ title: t('Play together'), url: link }).catch(() => {});
    await navigator.clipboard?.writeText(link).catch(() => {});
    toast(t('Link copied'));
  };
  const close = () => setOpen(false);
  return (
    <Sheet title={t('Playing together')} onClose={close}>
      <div className="together">
        <div className="together__link">
          <span className="together__code">{room.id}</span>
          <span className="muted small">{link.replace(/^https?:\/\//, '')}</span>
          <button className="btn btn--small btn--primary" onClick={() => void share()}>
            {'share' in navigator ? <Share2 size={15} /> : <Copy size={15} />} {'share' in navigator ? t('Share link') : t('Copy link')}
          </button>
        </div>
        <ul className="together__members">
          {room.members.map((m) => (
            <li key={m.clientId}>
              <span className={`together__dot ${m.here ? 'on' : ''}`} />
              <b>{m.name}</b>
              <span className="muted small">
                {m.here ? t('Here') : t('Away')}
                {m.clientId === myClient() ? ` · ${t('you')}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <div className="sheet__buttons">
          <button className="btn btn--ghost" onClick={() => void leave().then(close)}>
            {t('Leave')}
          </button>
          {(room.host === me?.username || me?.admin) && (
            <button className="btn btn--danger" onClick={() => void endForEveryone().then(close).catch((err: Error) => toast(err.message))}>
              {t('End for everyone')}
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Home: rooms others have open, to join. */
export function TogetherRow() {
  const room = useTogether();
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: api.together.list, refetchInterval: 20_000 });
  const others = (rooms.data ?? []).filter((r) => r.id !== room?.id && !r.names.every((n) => n === getMe()?.name));
  if (!others.length) return null;
  return (
    <section className="together-row">
      {others.map((r) => (
        <div className="together-card" key={r.id}>
          <Cover cover={r.cover} size={100} />
          <span className="together-card__text">
            <span className="together-card__live">
              <TogetherIcon size={14} /> {t('{names} playing together', { names: r.names.join(', ') })}
            </span>
            {r.title && <b>{r.title}</b>}
          </span>
          <button className="btn btn--small btn--primary" onClick={() => join(r.id)}>
            {t('Join')}
          </button>
        </div>
      ))}
    </section>
  );
}

/** The invite link: joins, then goes Home with the music. */
export function JoinRoom() {
  const { id } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    if (id) join(id);
    navigate('/', { replace: true });
  }, [id, navigate]);
  return null;
}

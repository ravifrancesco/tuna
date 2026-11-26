import { api } from '../api';
import { getPlayer, onPlayer, slipIn } from './player';

/**
 * A song's radio: the few new songs Tuna asks for as it starts (server/src/services/discovery.ts)
 * join it a couple of songs ahead as they arrive, for its first quarter of an hour.
 */
let following: string | undefined;
let timer: number | undefined;

onPlayer(() => {
  const s = getPlayer().source;
  const seed = s?.kind === 'mix' && s.id?.startsWith('song:') ? s.id.slice(5) : undefined;
  if (seed === following) return;
  following = seed;
  window.clearInterval(timer);
  if (!seed) return;
  const until = Date.now() + 15 * 60_000;
  timer = window.setInterval(() => {
    if (Date.now() > until || following !== seed) return window.clearInterval(timer);
    void api
      .radioNew(seed)
      .then((fresh) => {
        const here = new Set(getPlayer().queue.map((t) => t.id));
        slipIn(fresh.filter((t) => !here.has(t.id)));
      })
      .catch(() => undefined);
  }, 45_000);
});

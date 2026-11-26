import { api } from '../api';
import { getPlayer, onPlayer, slipIn } from './player';

/**
 * A song's radio is mostly new songs (server/src/services/discovery.ts): each joins the queue as it
 * arrives, right after the new songs already waiting ahead, so they play one after another, with
 * songs from the library filling in until the first are here. The page says how many it has
 * played, so the server keeps a handful more coming.
 */
let following: string | undefined;
let timer: number | undefined;
const delivered = new Set<string>();

function check(seed: string) {
  if (following !== seed) return;
  const { queue, index } = getPlayer();
  const heard = queue.slice(0, index + 1).filter((t) => delivered.has(t.id)).length;
  void api
    .radioNew(seed, heard)
    .then((fresh) => {
      const p = getPlayer();
      const here = new Set(p.queue.map((t) => t.id));
      const add = fresh.filter((t) => !here.has(t.id) && !delivered.has(t.id));
      if (!add.length || following !== seed) return;
      let at = p.index + 1;
      while (at < p.queue.length && delivered.has(p.queue[at].id)) at++;
      add.forEach((t) => delivered.add(t.id));
      slipIn(add, at);
    })
    .catch(() => undefined);
}

onPlayer(() => {
  const s = getPlayer().source;
  const seed = s?.kind === 'mix' && s.id?.startsWith('song:') ? s.id.slice(5) : undefined;
  if (seed === following) return;
  following = seed;
  delivered.clear();
  window.clearInterval(timer);
  if (!seed) return;
  window.setTimeout(() => check(seed), 8000);
  timer = window.setInterval(() => check(seed), 20_000);
});

import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query';

/**
 * The pages as they were last time, kept on this device for the person signed in: Tuna opens on them
 * at once (Home, the library, playlists, the albums and artists seen lately) and brings them up to
 * date as the server answers. Gone when they sign out; another person signing in starts afresh.
 */

const STORE = 'tuna.pages';
/** Kept whole. */
const LISTS = new Set(['home', 'playlists', 'mixes', 'liked', 'artists', 'albums']);
/** Kept for the ones seen most recently. */
const PAGES = new Set(['album', 'artist', 'playlist', 'mix']);
const RECENT = 30;
/** Well inside what browsers allow a site (about 5 MB). */
const MOST = 2_000_000;

let stop: (() => void) | undefined;

const kind = (q: Query) => String(q.queryKey[0]);

/** Opens on what this person saw last time, and keeps what they see from now on. */
export function keepPages(client: QueryClient, username: string) {
  stop?.();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as { who?: string; state?: unknown } | null;
    if (saved?.who === username && saved.state) hydrate(client, saved.state);
    else localStorage.removeItem(STORE);
  } catch {
    /* storage blocked or damaged: the server's answers it is */
  }
  let timer: number | undefined;
  const save = () => {
    timer = undefined;
    const recent = new Set(
      client
        .getQueryCache()
        .getAll()
        .filter((q) => PAGES.has(kind(q)) && q.state.status === 'success')
        .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
        .slice(0, RECENT),
    );
    const state = dehydrate(client, { shouldDehydrateQuery: (q) => q.state.status === 'success' && (LISTS.has(kind(q)) || recent.has(q)) });
    try {
      const text = JSON.stringify({ who: username, state });
      if (text.length < MOST) localStorage.setItem(STORE, text);
    } catch {
      /* full or blocked */
    }
  };
  const unsubscribe = client.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'success' && timer === undefined) timer = window.setTimeout(save, 2000);
  });
  stop = () => {
    unsubscribe();
    window.clearTimeout(timer);
  };
}

/** Signed out: nothing of theirs stays on the device. */
export function forgetPages() {
  stop?.();
  stop = undefined;
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* blocked */
  }
}

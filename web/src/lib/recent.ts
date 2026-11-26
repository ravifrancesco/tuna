import { getMe } from './session';

/** What someone searched for lately, on this device (newest first). */
const key = () => `tuna.recent.${getMe()?.username ?? ''}`;

export function recentSearches(): string[] {
  try {
    return JSON.parse(localStorage.getItem(key()) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function keep(list: string[]) {
  try {
    localStorage.setItem(key(), JSON.stringify(list));
  } catch {
    /* private browsing: just not kept */
  }
  return list;
}

export const rememberSearch = (q: string) => keep([q, ...recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 10));
export const forgetSearch = (q: string) => keep(recentSearches().filter((x) => x !== q));
export const clearSearches = () => keep([]);

import { locale, t, tn } from '../i18n';

/** 3:07, or 1:02:03 for anything an hour or longer. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "1 h 12 min" or "42 min" (album and playlist lengths). */
export function length(seconds: number): string {
  const m = Math.round((seconds || 0) / 60);
  if (m < 60) return t('{n} min', { n: m });
  return t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
}

export const songs = (n: number) => tn(n, '{n} song', '{n} songs');

export function ago(iso?: string): string {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return tn(minutes, '{n} minute ago', '{n} minutes ago');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return tn(hours, '{n} hour ago', '{n} hours ago');
  const days = Math.round(hours / 24);
  if (days < 30) return tn(days, '{n} day ago', '{n} days ago');
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

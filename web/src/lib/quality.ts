import type { Quality } from '@tuna/shared';
import { api } from '../api';
import { t } from '../i18n';
import { reloadQueue } from './player';
import { getMe, setMe } from './session';

/** The quality levels, as people pick them (Now Playing's badge and Settings). */
export const QUALITIES: Array<{ value: Quality; label: () => string; detail: () => string }> = [
  { value: 'auto', label: () => t('Automatic'), detail: () => t('Original on Wi-Fi, Normal on mobile data') },
  { value: 'low', label: () => t('Low'), detail: () => t('96 kbps · about 45 MB an hour') },
  { value: 'normal', label: () => t('Normal'), detail: () => t('160 kbps · about 70 MB an hour') },
  { value: 'high', label: () => t('High'), detail: () => t('320 kbps · about 145 MB an hour') },
  { value: 'original', label: () => t('Original'), detail: () => t('The file as it is · up to 450 MB an hour') },
];

/** Changes it everywhere this person signs in, and carries on playing in the new quality. */
export async function setQuality(quality: Quality) {
  const me = getMe();
  if (!me || me.prefs.quality === quality) return;
  setMe({ ...me, prefs: { ...me.prefs, quality } });
  reloadQueue();
  try {
    const prefs = await api.savePrefs({ quality });
    const now = getMe();
    if (now) setMe({ ...now, prefs });
  } catch {
    /* kept on this device for now */
  }
}

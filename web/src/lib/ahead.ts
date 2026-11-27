import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useShown } from './devices';
import { coverUrl } from './session';
import { prepareTint } from './tint';

/** The sizes the player shows a cover at: the mini player and queue, the pill, Now Playing. */
const SIZES = [100, 150, 1200];

/** A picture in the browser's cache, ready to draw. */
function preload(url: string | undefined) {
  if (!url) return;
  const img = new Image();
  img.src = url;
  void img.decode?.().catch(() => undefined);
}

/**
 * The next song, made ready while this one plays: its cover at the player's sizes, its colours, its
 * waveform and its lyrics, so they all change at once when it starts.
 */
export function useNextReady() {
  const next = useShown((s) => s.queue[s.index + 1]);
  const qc = useQueryClient();
  useEffect(() => {
    if (!next) return;
    for (const size of SIZES) preload(coverUrl(next.cover, size));
    void prepareTint(next.cover);
    void qc.prefetchQuery({ queryKey: ['wave', next.id], queryFn: () => api.wave(next.id), staleTime: Infinity, retry: false });
    void qc.prefetchQuery({ queryKey: ['lyrics', next.id], queryFn: () => api.lyrics(next.id), staleTime: Infinity });
  }, [next?.id, next?.cover, qc]);
}

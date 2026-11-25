import { Pause, Play } from 'lucide-react';
import { t } from '../i18n';
import { toggle, usePlayer, type Source } from '../lib/player';

/** The big Play: Pause while this album, playlist or mix is the one playing. */
export function PlayButton({ source, onPlay, disabled }: { source: Source; onPlay: () => void; disabled?: boolean }) {
  const mine = usePlayer((s) => s.source?.kind === source.kind && s.source?.id === source.id && s.index >= 0);
  const playing = usePlayer((s) => s.playing);
  return (
    <button className="play-btn play-btn--big" aria-label={mine && playing ? t('Pause') : t('Play')} disabled={disabled} onClick={() => (mine ? toggle() : onPlay())}>
      {mine && playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
    </button>
  );
}

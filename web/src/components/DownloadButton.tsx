import { CircleArrowDown } from 'lucide-react';
import { t } from '../i18n';
import { canDownload, download, removeDownload, useDownload } from '../lib/downloads';

type Wanted = Parameters<typeof download>[0];

/** Download (the apps): an arrow, a ring filling while it comes, a full circle once it's here. */
export function DownloadButton({ want, size = 26 }: { want: Wanted; size?: number }) {
  const d = useDownload(want.id);
  if (!canDownload || !want.tracks.length) return null;
  const done = d?.state === 'done';
  const share = d && d.tracks.length ? d.ready.length / d.tracks.length : 0;
  const r = size / 2 - 2;
  return (
    <button
      className={`icon-btn download ${done ? 'on' : ''}`}
      aria-label={d ? t('Remove download') : t('Download')}
      onClick={() => {
        if (!d) download(want);
        else if (confirm(t('Remove the download from this device?'))) removeDownload(want.id);
      }}
    >
      {d && !done ? (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * r * Math.max(0.04, share)} ${2 * Math.PI * r}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      ) : (
        <CircleArrowDown size={size} />
      )}
    </button>
  );
}

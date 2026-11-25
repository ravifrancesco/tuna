import { Link } from 'react-router';
import { Trash2 } from 'lucide-react';
import type { NativeDownload } from '@tuna/shared';
import { Cover, Empty } from '../components/ui';
import { locale, t, tn } from '../i18n';
import { clearDownloads, rekey, removeDownload, usage, useDownloads } from '../lib/downloads';

/** "120 MB", "1.4 GB". */
export const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toLocaleString(locale, { maximumFractionDigits: 1 })} GB` : `${Math.max(1, Math.round(bytes / 1e6)).toLocaleString(locale)} MB`;

const where = (d: NativeDownload) => (d.kind === 'album' ? `/album/${d.id.slice(6)}` : d.kind === 'playlist' ? `/playlist/${d.id.slice(9)}` : d.kind === 'liked' ? '/liked' : undefined);

/** What's on this device (the apps), as in Netfish's downloads: each with how far it's come. */
export function Downloads() {
  const list = useDownloads();
  const bytes = usage(list);
  return (
    <div className="page">
      <div className="row__head">
        <h1 className="hello" style={{ margin: 0 }}>
          {t('Downloads')}
        </h1>
        {list.length > 0 && (
          <button className="btn btn--small" onClick={() => confirm(t('Delete every download from this device?')) && clearDownloads()}>
            {t('Delete all')}
          </button>
        )}
      </div>
      {list.length ? (
        <>
          <p className="muted small" style={{ margin: '0 0 16px' }}>
            {t('{size} on this device', { size: size(bytes) })}
          </p>
          <div className="downloads">
            {list.map((d) => {
              const to = where(d);
              const title = d.kind === 'liked' ? t('Liked songs') : d.title;
              return (
                <div className="download-row" key={d.id}>
                  <Cover src={rekey(d.cover)} size={100} />
                  <span className="download-row__text">
                    {to ? <Link to={to}>{title}</Link> : <b>{title}</b>}
                    <span className="muted small">
                      {[
                        d.subtitle,
                        d.state === 'done'
                          ? tn(d.ready.length, '{n} song', '{n} songs')
                          : d.state === 'failed'
                            ? t('Stopped: {done} of {total}', { done: d.ready.length, total: d.tracks.length })
                            : t('Downloading {done} of {total}', { done: d.ready.length, total: d.tracks.length }),
                        size(d.bytes),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <button className="icon-btn" aria-label={t('Remove download')} onClick={() => removeDownload(d.id)}>
                    <Trash2 size={18} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <Empty>{t('Nothing downloaded yet')}</Empty>
      )}
    </div>
  );
}

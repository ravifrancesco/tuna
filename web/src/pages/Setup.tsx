import { useState } from 'react';
import { api, ApiError } from '../api';
import { Mark } from '../components/Logo';
import { t } from '../i18n';

/** The first time: where Navidrome is (and Lidarr, if there is one), with the code from the server's log. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [navidromeUrl, setNavidrome] = useState('http://');
  const [lidarrUrl, setLidarr] = useState('');
  const [lidarrApiKey, setKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="center-page">
      <div className="signin" style={{ width: 'min(460px, 100%)' }}>
        <Mark className="mark" />
        <h1>{t('Set up Tuna')}</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            try {
              await api.setup({ code, navidromeUrl, lidarrUrl: lidarrUrl || undefined, lidarrApiKey: lidarrApiKey || undefined });
              onDone();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field">
            <label htmlFor="code">{t('Setup code')}</label>
            <input id="code" className="input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <small className="muted">{t("It's in Tuna's log on the server (Portainer → Containers → tuna → Logs).")}</small>
          </div>
          <div className="field">
            <label htmlFor="nd">{t('Navidrome address')}</label>
            <input id="nd" className="input" value={navidromeUrl} onChange={(e) => setNavidrome(e.target.value)} placeholder="http://192.168.1.10:4533" />
          </div>
          <div className="field">
            <label htmlFor="li">{t('Lidarr address (optional)')}</label>
            <input id="li" className="input" value={lidarrUrl} onChange={(e) => setLidarr(e.target.value)} placeholder="http://192.168.1.10:8686" />
          </div>
          {lidarrUrl && (
            <div className="field">
              <label htmlFor="lk">{t('Lidarr API key')}</label>
              <input id="lk" className="input" value={lidarrApiKey} onChange={(e) => setKey(e.target.value)} />
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <button className="btn btn--primary" type="submit" disabled={busy || !code || navidromeUrl.length < 10}>
            {busy ? t('Checking…') : t('Continue')}
          </button>
        </form>
      </div>
    </div>
  );
}

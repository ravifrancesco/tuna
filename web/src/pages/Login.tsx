import { useState } from 'react';
import type { Me } from '@tuna/shared';
import { api, ApiError, setBearer } from '../api';
import { Mark } from '../components/Logo';
import { t } from '../i18n';
import { app, has, isApp } from '../lib/native';

export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="center-page">
      <div className="signin">
        <Mark className="mark" />
        <h1>tuna</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            try {
              const r = await api.login(username, password);
              if (isApp) setBearer(r.session);
              onSignedIn(r.me);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : t("Couldn't reach the Tuna server"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field">
            <label htmlFor="u">{t('Username')}</label>
            <input id="u" className="input" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="p">{t('Password')}</label>
            <input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="btn btn--primary" type="submit" disabled={busy || !username}>
            {busy ? t('Signing in…') : t('Sign in')}
          </button>
        </form>
        {has('changeServer') && (
          <button className="btn btn--ghost" style={{ marginTop: 12 }} onClick={app.changeServer}>
            {t('Change server')}
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { Me, Person, Prefs, SpotifyImport, Stocking, StockingWhy } from '@tuna/shared';
import { api, ApiError } from '../api';
import { AwayFromHome } from '../components/AwayFromHome';
import { Mark } from '../components/Logo';
import { Avatar, signOut } from '../components/Profile';
import { Cover, Sheet, Switch, toast } from '../components/ui';
import { LANGUAGES, languageSetting, locale, setLanguage, t, tn } from '../i18n';
import { ago } from '../lib/format';
import { QUALITIES, setQuality } from '../lib/quality';
import { canDownload, downloadQuality, setDownloadQuality, usage, useDownloads, type DownloadQuality } from '../lib/downloads';
import { size } from './Downloads';
import { app, has, hello, onEvent, type UpdateStatus } from '../lib/native';
import { artUrl, setMe, useMe } from '../lib/session';
import { EqualizerControls } from '../components/Equalizer';
import { hasEq } from '../lib/eq';

/** Settings, laid out as in Netfish: the one place that explains how things work. */
export function Settings() {
  const me = useMe();
  if (!me) return null;
  return (
    <div className="page settings">
      <h1 className="settings__title">{t('Settings')}</h1>
      <Account me={me} />
      <Listening prefs={me.prefs} />
      <LanguageSection />
      <ListenBrainz prefs={me.prefs} />
      <LastFm prefs={me.prefs} />
      <Spotify />
      {app.tunnel && <AwayFromHome />}
      {hello && <AppSection />}
      {me.admin && <WeeklyPicks />}
      {me.admin && <ConnectionsSection />}
      {me.admin && <Waveforms />}
      {me.admin && <Household me={me} />}
      <About />
    </div>
  );
}

const failed = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

function Account({ me }: { me: Me }) {
  return (
    <section className="panel">
      <h2>{t('Account')}</h2>
      <div className="account">
        <Avatar me={me} size={52} />
        <div className="account__who">
          <strong>{me.name}</strong>
          <span className="muted small">
            {me.username} · {me.admin ? t('Administrator') : t('Member')}
          </span>
        </div>
        <button className="btn btn--ghost" onClick={() => void signOut()}>
          {t('Sign out')}
        </button>
      </div>
    </section>
  );
}

function Listening({ prefs }: { prefs: Prefs }) {
  return (
    <section className="panel">
      <h2>{t('Listening')}</h2>
      <label className="field">
        <span>{t('Sound quality')}</span>
        <select className="input" value={prefs.quality} onChange={(e) => void setQuality(e.target.value as Prefs['quality'])}>
          {QUALITIES.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label()}
            </option>
          ))}
        </select>
        <small className="muted">{QUALITIES.find((q) => q.value === prefs.quality)?.detail()}</small>
      </label>
      {canDownload && <DownloadQualityField />}
      {hasEq && (
        <div className="field">
          <EqualizerControls />
          <small className="muted">{t('On this device, for every song.')}</small>
        </div>
      )}
    </section>
  );
}

function LanguageSection() {
  return (
    <section className="panel">
      <h2>{t('Language')}</h2>
      <label className="field">
        <select className="input" value={languageSetting()} onChange={(e) => setLanguage(e.target.value as 'auto' | 'en' | 'it')} aria-label={t('Language')}>
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.value === 'auto' ? t('Automatic') : l.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

/** Linking an account elsewhere: a token or a name, then "Linked as …". */
function Linked({ name, onUnlink }: { name: string; onUnlink: () => void }) {
  return (
    <div className="account">
      <span className="account__who">{t('Linked as {name}', { name })}</span>
      <button className="btn btn--ghost btn--small" onClick={onUnlink}>
        {t('Unlink')}
      </button>
    </div>
  );
}

function LinkForm({ placeholder, onLink }: { placeholder: string; onLink: (value: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="link-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onLink(value).then(() => setValue(''));
      }}
    >
      <input className="input" autoCapitalize="none" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn btn--primary" type="submit" disabled={!value.trim()}>
        {t('Link')}
      </button>
    </form>
  );
}

function usePrefsSaver() {
  const me = useMe()!;
  const [error, setError] = useState<string>();
  const save = async (patch: { listenbrainzToken?: string; lastfmUser?: string }) => {
    setError(undefined);
    try {
      setMe({ ...me, prefs: await api.savePrefs(patch) });
    } catch (err) {
      setError(failed(err));
      throw err;
    }
  };
  return { save, error };
}

function ListenBrainz({ prefs }: { prefs: Prefs }) {
  const { save, error } = usePrefsSaver();
  return (
    <section className="panel">
      <h2>ListenBrainz</h2>
      <p className="muted small">
        {t('Sends what you play to ListenBrainz; its picks show up on Home.')}{' '}
        <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer">
          {t('Your token')}
        </a>
      </p>
      {prefs.listenbrainzToken ? (
        <Linked name={prefs.listenbrainzUser ?? ''} onUnlink={() => void save({ listenbrainzToken: '' }).catch(() => {})} />
      ) : (
        <LinkForm placeholder={t('ListenBrainz token')} onLink={(v) => save({ listenbrainzToken: v })} />
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function LastFm({ prefs }: { prefs: Prefs }) {
  const { save, error } = usePrefsSaver();
  return (
    <section className="panel">
      <h2>Last.fm</h2>
      <p className="muted small">{t('What you play elsewhere helps choose the albums Tuna gets.')}</p>
      {prefs.lastfmUser ? (
        <Linked name={prefs.lastfmUser} onUnlink={() => void save({ lastfmUser: '' }).catch(() => {})} />
      ) : (
        <LinkForm placeholder={t('Your Last.fm name')} onLink={(v) => save({ lastfmUser: v })} />
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** Spotify's data download (or Exportify's CSV files): what's in the library comes in, the rest can be got. */
function Spotify() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SpotifyImport>();
  const [asked, setAsked] = useState<{ n: number; songs: boolean }>();
  const [error, setError] = useState<string>();
  const choose = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setDone(undefined);
    setAsked(undefined);
    setError(undefined);
    try {
      let all: SpotifyImport | undefined;
      for (const f of files) all = add(all, await api.importSpotify(f));
      setDone(all);
      void qc.invalidateQueries();
    } catch (err) {
      setError(failed(err));
    } finally {
      setBusy(false);
    }
  };
  const getAll = async () => {
    try {
      if (done!.missingSongs?.length) {
        const r = await api.getSongs(done!.missingSongs);
        setAsked({ n: r.asked, songs: r.songs });
      } else setAsked({ n: (await api.getMany(done!.missingAlbums.map((a) => ({ artist: a.artist, album: a.album })))).asked, songs: false });
    } catch (err) {
      setError(failed(err));
    }
  };
  const what =
    done &&
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(
      [
        done.playlists && tn(done.playlists, '{n} playlist', '{n} playlists'),
        done.liked && tn(done.liked, '{n} liked song', '{n} liked songs'),
        done.albums && tn(done.albums, '{n} album', '{n} albums'),
        done.artists && tn(done.artists, '{n} artist', '{n} artists'),
        done.plays && tn(done.plays, '{n} play', '{n} plays'),
      ].filter((x): x is string => Boolean(x)),
    );
  const missing = done?.missingAlbums ?? [];
  return (
    <section className="panel">
      <h2>Spotify</h2>
      <p className="muted small">{t('Brings in your playlists, likes and listening history, from either of these.')}</p>
      <div className="links">
        <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">
          {t('All your data from Spotify · a few days')} <ExternalLink size={13} />
        </a>
        <a href="https://exportify.net/" target="_blank" rel="noreferrer">
          {t('Playlists from Exportify · right away')} <ExternalLink size={13} />
        </a>
      </div>
      <div>
        <label className={`btn btn--primary ${busy ? 'disabled' : ''}`}>
          {busy ? t('Bringing it in…') : t('Choose files')}
          <input
            type="file"
            accept=".zip,.json,.csv"
            multiple
            hidden
            disabled={busy}
            onChange={(e) => {
              void choose(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {done && (
        <div className="spotify-done">
          <p>{what ? t('Brought in {what}.', { what }) : t('Nothing new came in.')}</p>
          {missing.length > 0 && (
            <>
              <p className="muted small">
                {tn(done.missing, "{n} song isn't in the library, from:", "{n} songs aren't in the library, from:")}{' '}
                {missing
                  .slice(0, 4)
                  .map((a) => `${a.album} (${a.artist})`)
                  .join(', ')}
                {missing.length > 4 ? ` ${tn(missing.length - 4, 'and {n} more', 'and {n} more')}` : ''}
              </p>
              {asked === undefined ? (
                <div>
                  <button className="btn btn--primary" onClick={() => void getAll()}>
                    {done.missingSongs?.length ? tn(done.missingSongs.length, 'Get it', 'Get all {n}') : tn(missing.length, 'Get it', 'Get all {n}')}
                  </button>
                </div>
              ) : (
                <p className="small">
                  {asked.songs
                    ? tn(asked.n, '{n} song to get, most played first, a few at a time.', '{n} songs to get, most played first, a few at a time.')
                    : tn(asked.n, '{n} album to get, most played first, a few at a time.', '{n} albums to get, most played first, a few at a time.')}{' '}
                  <Link to="/getting">{t('On its way')}</Link>
                </p>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** Two files' worth together. */
function add(a: SpotifyImport | undefined, b: SpotifyImport): SpotifyImport {
  if (!a) return b;
  const albums = new Map(a.missingAlbums.map((m) => [`${m.artist}|${m.album}`, m]));
  for (const m of b.missingAlbums) {
    const k = `${m.artist}|${m.album}`;
    const was = albums.get(k);
    albums.set(k, { ...m, songs: (was?.songs ?? 0) + m.songs, plays: (was?.plays ?? 0) + m.plays });
  }
  return {
    playlists: a.playlists + b.playlists,
    liked: a.liked + b.liked,
    albums: a.albums + b.albums,
    artists: a.artists + b.artists,
    plays: a.plays + b.plays,
    missing: a.missing + b.missing,
    missingAlbums: [...albums.values()].sort((x, y) => y.plays - x.plays).slice(0, 50),
  };
}

const DOWNLOAD_QUALITIES: { value: DownloadQuality; label: () => string; detail: () => string }[] = [
  { value: 'normal', label: () => t('Normal'), detail: () => t('About 5 MB a song') },
  { value: 'high', label: () => t('High'), detail: () => t('About 8 MB a song') },
  { value: 'original', label: () => t('Original'), detail: () => t('The file as it is: about 30 MB a song in FLAC') },
];

/** Downloads on this device: smaller, or as they are. New downloads use it. */
function DownloadQualityField() {
  const [q, setQ] = useState(downloadQuality);
  return (
    <label className="field">
      <span>{t('Download quality')}</span>
      <select className="input" value={q} onChange={(e) => (setDownloadQuality(e.target.value as DownloadQuality), setQ(e.target.value as DownloadQuality))}>
        {DOWNLOAD_QUALITIES.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label()}
          </option>
        ))}
      </select>
      <small className="muted">
        {DOWNLOAD_QUALITIES.find((x) => x.value === q)?.detail()} · {t('For new downloads')}
      </small>
    </label>
  );
}

function AppSection() {
  const downloads = useDownloads();
  const onDevice = [...new Set(downloads.flatMap((d) => d.ready))];
  const bytes = usage(downloads);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [installing, setInstalling] = useState<number>();
  useEffect(() => {
    void app.update?.check().then((u) => setUpdate(u ?? undefined)).catch(() => undefined);
    // The app reports an install as it goes: {received, total}, {done} or {error}.
    return onEvent((name, value) => {
      if (name !== 'update' || !value || typeof value !== 'object') return;
      const v = value as { received?: number; total?: number; done?: boolean; error?: string };
      if (v.error) {
        setInstalling(undefined);
        toast(v.error);
      } else if (v.done) setInstalling(undefined);
      else if (v.total) setInstalling(Math.round(((v.received ?? 0) / v.total) * 100));
    });
  }, []);
  if (!update && !has('changeServer') && !canDownload) return null;
  return (
    <section className="panel">
      <h2>{t('This app')}</h2>
      {update && (
        <div className="account">
          <span className="account__who">{update.available ? t('Tuna {v} is out', { v: update.latest ?? '' }) : t('Tuna {v} is up to date', { v: update.current })}</span>
          {update.available && update.canInstall && (
            <button className="btn btn--primary btn--small" disabled={installing !== undefined} onClick={() => app.update?.install()}>
              {installing !== undefined ? `${installing}%` : t('Update')}
            </button>
          )}
        </div>
      )}
      {canDownload && (
        <div className="account">
          <span className="account__who">
            {t('Downloads')}
            <span className="muted small">{tn(onDevice.length, '{n} song on this device', '{n} songs on this device')}{bytes ? ` · ${size(bytes)}` : ''}</span>
          </span>
          <Link className="btn btn--ghost btn--small" to="/downloads">
            {t('Show')}
          </Link>
        </div>
      )}
      {has('changeServer') && (
        <div className="account">
          <span className="account__who">{location.host}</span>
          <button className="btn btn--ghost btn--small" onClick={app.changeServer}>
            {t('Change server')}
          </button>
        </div>
      )}
    </section>
  );
}

const WHY: Record<StockingWhy, () => string> = {
  elsewhere: () => t('Played elsewhere'),
  new: () => t('New release'),
  listenbrainz: () => t('Suggested by ListenBrainz'),
  more: () => t('More by an artist you play'),
};
const PER_WEEK = [0, 3, 5, 10, 20, 40];
const SONGS_PER_WEEK = [0, 10, 20, 30];

/** New songs each person gets every Monday, in their Fresh catch; kept only if someone keeps them. */
function NewSongsField() {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['discovery'], queryFn: api.discovery });
  if (!d.data) return null;
  const save = async (perWeek: number) => qc.setQueryData(['discovery'], await api.saveDiscovery(perWeek));
  return (
    <label className="field">
      <span>{t('New songs a week, for each person')}</span>
      <select className="input" value={d.data.perWeek} disabled={!d.data.available} onChange={(e) => void save(Number(e.target.value))}>
        {[...new Set([...SONGS_PER_WEEK, d.data.perWeek])].sort((x, y) => x - y).map((n) => (
          <option key={n} value={n}>
            {n ? n : t('Off')}
          </option>
        ))}
      </select>
      <small className="muted">
        {d.data.available ? t('In their Fresh catch every Monday. Songs nobody likes or adds to a playlist go the week after.') : t('Needs slskd and Lidarr, in Connections below.')}
      </small>
    </label>
  );
}

/** Keeping the library stocked: how much of what's played is here, and the weekly picks. */
function WeeklyPicks() {
  const qc = useQueryClient();
  const stocking = useQuery({ queryKey: ['stocking'], queryFn: api.stocking });
  const [error, setError] = useState<string>();
  const s: Stocking | undefined = stocking.data;
  if (!s) return null;
  const save = async (perWeek: number) => {
    setError(undefined);
    try {
      qc.setQueryData(['stocking'], await api.saveStocking(perWeek));
    } catch (err) {
      setError(failed(err));
    }
  };
  return (
    <section className="panel">
      <h2>{t('Weekly picks')}</h2>
      <p className="muted small">{t('Albums the household will probably want, asked for through Get. Nothing is deleted.')}</p>
      {s.coverage && s.coverage.plays > 0 && (
        <div className="coverage">
          <b>{s.coverage.percent}%</b>
          <span>
            {t('of what the household played in the last 30 days is here.')}
            {s.coverage.missing.length > 0 && (
              <span className="muted small">
                {' '}
                {t('Missing most: {albums}', {
                  albums: s.coverage.missing
                    .slice(0, 3)
                    .map((m) => `${m.album} (${m.artist})`)
                    .join(', '),
                })}
              </span>
            )}
          </span>
        </div>
      )}
      <label className="field">
        <span>{t('Albums a week')}</span>
        <select className="input" value={s.perWeek} disabled={s.needsLidarr} onChange={(e) => void save(Number(e.target.value))}>
          {[...new Set([...PER_WEEK, s.perWeek])].sort((x, y) => x - y).map((n) => (
            <option key={n} value={n}>
              {n ? n : t('Off')}
            </option>
          ))}
        </select>
        <small className="muted">{s.needsLidarr ? t('Needs Lidarr, in Connections below.') : s.perWeek ? tn(s.thisWeek, '{n} so far this week', '{n} so far this week') : t('From ListenBrainz, Last.fm and what’s played here.')}</small>
      </label>
      <NewSongsField />
      {s.picks.length > 0 && (
        <div className="picks">
          {s.picks.map((p) => (
            <div className="pick" key={`${p.title}|${p.at}`}>
              <Cover src={artUrl(p.cover)} size={100} />
              <span className="account__who">
                <strong>{p.title}</strong>
                <span className="muted small">
                  {p.artist} · {WHY[p.why]()} · {ago(p.at)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function ConnectionsSection() {
  const qc = useQueryClient();
  const conn = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const [navidrome, setNavidrome] = useState('');
  const [lidarrUrl, setLidarrUrl] = useState('');
  const [lidarrKey, setLidarrKey] = useState('');
  const [slskdUrl, setSlskdUrl] = useState('');
  const [slskdKey, setSlskdKey] = useState('');
  const [lastfm, setLastfm] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!conn.data) return;
    setNavidrome(conn.data.navidrome.url ?? '');
    setLidarrUrl(conn.data.lidarr.url ?? '');
    setSlskdUrl(conn.data.slskd?.url ?? '');
  }, [conn.data]);
  const save = async () => {
    setError(undefined);
    try {
      await api.saveConnections({
        navidromeUrl: navidrome,
        lidarrUrl,
        ...(lidarrKey ? { lidarrApiKey: lidarrKey } : {}),
        slskdUrl,
        ...(slskdKey ? { slskdApiKey: slskdKey } : {}),
        ...(lastfm ? { lastfmApiKey: lastfm } : {}),
      });
      setLidarrKey('');
      setSlskdKey('');
      setLastfm('');
      void qc.invalidateQueries({ queryKey: ['connections'] });
      toast(t('Saved'));
    } catch (err) {
      setError(failed(err));
    }
  };
  return (
    <section className="panel">
      <h2>{t('Connections')}</h2>
      <p className="muted small">{t('Navidrome has the music, Lidarr gets albums, slskd gets single songs (Lidarr files them), Last.fm finds similar artists.')}</p>
      <label className="field">
        <span>{t('Navidrome address')}</span>
        <input className="input" value={navidrome} onChange={(e) => setNavidrome(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>{t('Lidarr address')}</span>
          <input className="input" value={lidarrUrl} onChange={(e) => setLidarrUrl(e.target.value)} placeholder="http://192.168.1.10:8686" />
        </label>
        <label className="field">
          <span>{t('Lidarr API key')}</span>
          <input className="input" value={lidarrKey} onChange={(e) => setLidarrKey(e.target.value)} placeholder={conn.data?.lidarr.apiKey ? t('Saved (type to replace)') : ''} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>{t('slskd address')}</span>
          <input className="input" value={slskdUrl} onChange={(e) => setSlskdUrl(e.target.value)} placeholder="http://192.168.1.10:5030" />
        </label>
        <label className="field">
          <span>{t('slskd API key')}</span>
          <input className="input" value={slskdKey} onChange={(e) => setSlskdKey(e.target.value)} placeholder={conn.data?.slskd?.apiKey ? t('Saved (type to replace)') : t('Optional')} />
        </label>
      </div>
      <label className="field">
        <span>{t('Last.fm API key')}</span>
        <input className="input" value={lastfm} onChange={(e) => setLastfm(e.target.value)} placeholder={conn.data?.lastfm.apiKey ? t('Saved (type to replace)') : t('Optional')} />
      </label>
      {error && <p className="error small">{error}</p>}
      <div>
        <button className="btn btn--primary" onClick={() => void save()}>
          {t('Save')}
        </button>
      </div>
    </section>
  );
}

function Waveforms() {
  const qc = useQueryClient();
  const waves = useQuery({ queryKey: ['waves'], queryFn: api.waves, refetchInterval: (q) => (q.state.data?.running ? 10_000 : false) });
  const [error, setError] = useState<string>();
  const w = waves.data;
  const save = async (patch: { enabled?: boolean; from?: string; until?: string }) => {
    setError(undefined);
    try {
      qc.setQueryData(['waves'], await api.saveWaves(patch));
    } catch (err) {
      setError(failed(err));
    }
  };
  if (!w) return null;
  const status = w.noFfmpeg
    ? t('ffmpeg is missing on the server, so waveforms can’t be measured.')
    : w.needsAdmin
      ? t('It starts once an admin has signed in on this server.')
      : w.total !== undefined
        ? `${t('{measured} of {total} songs measured', { measured: (w.measured ?? 0).toLocaleString(), total: w.total.toLocaleString() })}${w.running ? ` · ${t('measuring now')}` : ''}`
        : w.running
          ? t('Measuring now')
          : undefined;
  return (
    <section className="panel">
      <h2>{t('Waveforms')}</h2>
      <p className="muted small">{t('Measured when a song first plays, or for the whole library in the hours below.')}</p>
      <div className="account">
        <span className="account__who">{t('Measure the library ahead of time')}</span>
        <Switch on={w.enabled} label={t('Measure the library ahead of time')} onChange={(on) => void save({ enabled: on })} />
      </div>
      {w.enabled && (
        <div className="field-row">
          <label className="field">
            <span>{t('From')}</span>
            <input className="input" type="time" value={w.from} onChange={(e) => e.target.value && void save({ from: e.target.value })} />
          </label>
          <label className="field">
            <span>{t('Until')}</span>
            <input className="input" type="time" value={w.until} onChange={(e) => e.target.value && void save({ until: e.target.value })} />
          </label>
        </div>
      )}
      {status && <small className="muted">{status}</small>}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function Household({ me }: { me: Me }) {
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['household'], queryFn: api.household });
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<Person>();
  return (
    <section className="panel">
      <h2>{t('Household')}</h2>
      <p className="muted small">{t('Everyone has their own likes, playlists and history.')}</p>
      {people.error && <p className="error small">{people.error.message}</p>}
      {people.data?.map((p) => (
        <div className="account" key={p.id}>
          <Avatar me={p} size={40} />
          <div className="account__who">
            <strong>{p.name}</strong>
            <span className="muted small">
              {p.username} · {p.admin ? t('Administrator') : t('Member')}
              {p.lastSeen ? ` · ${ago(p.lastSeen)}` : ''}
            </span>
          </div>
          <span className="row-gap">
            <button className="btn btn--ghost btn--small" onClick={() => setChanging(p)}>
              {t('Change')}
            </button>
            {p.username !== me.username && (
              <button
                className="btn btn--ghost btn--small"
                onClick={async () => {
                  if (!confirm(t('Remove {name}?', { name: p.name }))) return;
                  await api.removePerson(p.id);
                  void qc.invalidateQueries({ queryKey: ['household'] });
                }}
              >
                {t('Remove')}
              </button>
            )}
          </span>
        </div>
      ))}
      <div>
        <button className="btn" onClick={() => setAdding(true)}>
          {t('Add someone')}
        </button>
      </div>
      {adding && <PersonSheet onClose={() => setAdding(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ['household'] })} />}
      {changing && <PersonSheet person={changing} onClose={() => setChanging(undefined)} onSaved={() => void qc.invalidateQueries({ queryKey: ['household'] })} />}
    </section>
  );
}

function PersonSheet({ person, onClose, onSaved }: { person?: Person; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState(person?.username ?? '');
  const [name, setName] = useState(person?.name ?? '');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(person?.admin ?? false);
  const [error, setError] = useState<string>();
  return (
    <Sheet title={person ? t('Change {name}', { name: person.name }) : t('Add someone')} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            if (person) await api.changePerson(person.id, { name, admin, ...(password ? { password } : {}) });
            else await api.addPerson({ username, name, password, admin });
            onSaved();
            onClose();
          } catch (err) {
            setError(failed(err));
          }
        }}
      >
        {!person && (
          <div className="field">
            <label>{t('Username')}</label>
            <input className="input" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
        )}
        <div className="field">
          <label>{t('Name')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>{person ? t('New password (optional)') : t('Password')}</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="account" style={{ marginBottom: 14 }}>
          <span className="account__who">{t('Administrator')}</span>
          <Switch on={admin} label={t('Administrator')} onChange={setAdmin} />
        </div>
        {error && <div className="error">{error}</div>}
        <div className="sheet__buttons">
          <button type="button" className="btn btn--ghost" onClick={onClose} data-close>
            {t('Cancel')}
          </button>
          <button className="btn btn--primary" type="submit" disabled={!person && (!username || !password)}>
            {t('Save')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** At the bottom, as in Netfish: the fish and the versions. */
function About() {
  const server = useQuery({ queryKey: ['server'], queryFn: api.server });
  return (
    <footer className="about">
      <Mark size={28} />
      <span className="muted small">
        Tuna {server.data?.version}
        {hello ? ` · ${t('app')} ${hello.version} (${hello.platform})` : ''}
      </span>
    </footer>
  );
}

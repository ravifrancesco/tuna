import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, ImagePlus, ListEnd, ListPlus, ListStart, MoreHorizontal, Radio, Shuffle } from 'lucide-react';
import { api, ApiError } from '../api';
import { AlbumCard, Row } from '../components/Cards';
import { Item, pickPlaylist, showMenu } from '../components/Menu';
import { PlayButton } from '../components/PlayButton';
import { TrackList } from '../components/TrackList';
import { Cover, Empty, Spinner, toast } from '../components/ui';
import { t, tn } from '../i18n';
import { useLiked } from '../lib/actions';
import { DownloadButton } from '../components/DownloadButton';
import { length, songs } from '../lib/format';
import { addToQueue, playNext, playTracks } from '../lib/player';
import { useTint } from '../lib/tint';
import { GetMissing } from './Playlist';

/** A picture's width and height, as the browser reads it (undefined: not a picture). */
const pictureSize = (file: Blob) =>
  new Promise<{ width: number; height: number } | undefined>((done) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => (done({ width: img.naturalWidth, height: img.naturalHeight }), URL.revokeObjectURL(url));
    img.onerror = () => (done(undefined), URL.revokeObjectURL(url));
    img.src = url;
  });

export function Album() {
  const { id = '' } = useParams();
  const album = useQuery({ queryKey: ['album', id], queryFn: () => api.album(id) });
  // The rest of the album (its kind, and its songs that aren't here), once it's known.
  const whole = useQuery({ queryKey: ['album-whole', id], queryFn: () => api.albumWhole(id), staleTime: 5 * 60_000 });
  // The songs show all at once, with those that aren't here; if finding those takes long, without them.
  const [waited, setWaited] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(id), 2500);
    return () => window.clearTimeout(timer);
  }, [id]);
  const complete = whole.isFetched || waited === id;
  // An album without a cover: one can be given (a square picture).
  const qc = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [bare, setBare] = useState<string>();
  const [given, setGiven] = useState<{ id: string; url: string }>();
  const [sending, setSending] = useState(false);
  const giveCover = async (file: File | undefined) => {
    if (!file) return;
    const size = await pictureSize(file);
    if (!size) return toast(t("That isn't a picture"));
    if (Math.abs(size.width - size.height) > Math.max(size.width, size.height) * 0.01) return toast(t('The picture has to be square'));
    setSending(true);
    try {
      await api.albumCover(id, file);
      setGiven({ id, url: URL.createObjectURL(file) });
      // Navidrome has it once it has looked at the album's folder again.
      for (const ms of [5000, 20000]) window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['album', id] }), ms);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  const [liked, toggleLike] = useLiked('album', id, album.data?.liked);
  const tint = useTint(album.data?.cover);
  if (album.isLoading) return <Spinner />;
  const a = album.data;
  if (!a) return <Empty>{t("Couldn't find this album")}</Empty>;
  const source = { kind: 'album' as const, id: a.id, title: a.name };
  const missing = whole.data?.missing ?? [];
  const kind = whole.data?.kind ? { Album: t('Album'), EP: t('EP'), Single: t('Single'), Other: t('Album') }[whole.data.kind] : complete ? (a.songCount <= 3 ? t('Single') : t('Album')) : '\u00a0';
  return (
    <div className="page--flush">
      <header className="hero" style={{ '--hero': tint } as React.CSSProperties}>
        {given?.id === a.id ? (
          <Cover src={given.url} size={600} />
        ) : !a.cover || bare === a.cover ? (
          <button className="hero__give" aria-label={t('Add a cover')} title={t('Add a cover')} disabled={sending} onClick={() => picker.current?.click()}>
            <Cover size={600} />
            <span className="hero__give-mark">{sending ? <span className="btn__spin" /> : <ImagePlus size={30} />}</span>
          </button>
        ) : (
          <Cover cover={a.cover} size={600} onMissing={() => setBare(a.cover)} />
        )}
        <input
          ref={picker}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            void giveCover(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <div>
          <div className="hero__kind">{kind}</div>
          <h1>{a.name}</h1>
          <div className="hero__meta">
            {a.artistId ? <Link to={`/artist/${a.artistId}`}>{a.artist}</Link> : a.artist}
            {a.year ? ` · ${a.year}` : ''} · {songs(a.songCount)}, {length(a.duration)}
            {missing.length ? ` · ${tn(missing.length, '{n} not here yet', '{n} not here yet')}` : ''}
          </div>
        </div>
      </header>
      <div className="actions">
        <PlayButton source={source} onPlay={() => playTracks(a.tracks, 0, source, { shuffle: false })} />
        <button className="icon-btn" aria-label={t('Shuffle')} onClick={() => playTracks(a.tracks, 0, source, { shuffle: true })}>
          <Shuffle size={24} />
        </button>
        <DownloadButton want={{ id: `album:${a.id}`, kind: 'album', title: a.name, subtitle: a.artist, cover: a.cover, tracks: a.tracks }} />
        <button className={`icon-btn ${liked ? 'on' : ''}`} aria-label={liked ? t('Remove from your library') : t('Save to your library')} onClick={toggleLike}>
          <Heart size={26} fill={liked ? 'currentColor' : 'none'} />
        </button>
        <button
          className="icon-btn"
          aria-label={t('More')}
          onClick={(e) =>
            showMenu(
              e,
              <>
                <Item icon={<ListStart size={18} />} onClick={() => (playNext(a.tracks), toast(t('Plays next')))}>
                  {t('Play next')}
                </Item>
                <Item icon={<ListEnd size={18} />} onClick={() => (addToQueue(a.tracks), toast(t('Added to the queue')))}>
                  {t('Add to queue')}
                </Item>
                <Item icon={<Radio size={18} />} onClick={() => void api.mix(`album:${a.id}`).then((tr) => playTracks(tr, 0, { kind: 'mix', id: `album:${a.id}`, title: t('{title} radio', { title: a.name }) }, { shuffle: false }))}>
                  {t('Start radio')}
                </Item>
                <Item icon={<ListPlus size={18} />} onClick={() => pickPlaylist(a.tracks)}>
                  {t('Add to playlist')}
                </Item>
              </>,
            )
          }
        >
          <MoreHorizontal size={24} />
        </button>
      </div>
      {complete && missing.length > 0 && (
        <div className="section section--tight">
          <GetMissing waiting={missing} />
        </div>
      )}
      <div className="section">{complete ? <TrackList tracks={a.tracks} waiting={missing} source={source} numbers compact /> : <div className="tracks-wait" aria-busy />}</div>
      {a.moreBy.length > 0 && (
        <div className="section">
          <Row title={t('More by {name}', { name: a.artist })}>
            {a.moreBy.map((x) => (
              <AlbumCard key={x.id} album={x} sub={String(x.year ?? '')} />
            ))}
          </Row>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Airplay, AudioLines, Bluetooth, Car, Check, ChevronDown, Headphones, Maximize2, Minimize2, MonitorSpeaker, MoreHorizontal, Speaker, Tv } from 'lucide-react';
import type { NativeOutput } from '@tuna/shared';
import { api } from '../api';
import { t } from '../i18n';
import { nativeAudio } from '../lib/native';
import { jump, playingAs, seek, usePlayer } from '../lib/player';
import { QUALITIES, setQuality } from '../lib/quality';
import { useMe } from '../lib/session';
import { useTints } from '../lib/tint';
import { Item, showMenu, TrackMenu } from './Menu';
import { TogetherChip, TogetherItem } from './Together';
import { Controls, LikeNow } from './PlayerBar';
import { WaveProgress } from './Waveform';
import { Cover, Empty, Spinner } from './ui';

/** The full-screen player: the cover, the controls, and the lyrics or the queue beside it. */
export function NowPlaying({ tab: firstTab, onClose }: { tab?: 'lyrics' | 'queue'; onClose: () => void }) {
  const track = usePlayer((s) => s.queue[s.index]);
  const source = usePlayer((s) => s.source);
  // Lyrics, or the queue when the song has none. Picking the queue holds; picking the lyrics only
  // holds for that song.
  const [picked, setPicked] = useState(firstTab && { tab: firstTab, song: track?.id });
  const lyrics = useQuery({ queryKey: ['lyrics', track?.id], queryFn: () => api.lyrics(track!.id), enabled: Boolean(track), staleTime: Infinity });
  const noLyrics = lyrics.isError || (lyrics.isSuccess && !lyrics.data.lines.length);
  const tab = picked && (picked.tab === 'queue' || picked.song === track?.id) ? picked.tab : noLyrics ? 'queue' : 'lyrics';
  // Phones: three stops, one above the other. The player, with the lyrics (or queue) card peeking
  // below it; the controls with the card under them, where a swipe up lands; the card on its own.
  const page = useRef<HTMLDivElement>(null);
  const second = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  // While the card only peeks below the player, neither chip is lit: what's under it is unseen.
  const [down, setDown] = useState(true);
  const go = (to: Element | null | undefined, smooth = true) => {
    const p = page.current;
    if (p && p.scrollHeight > p.clientHeight) p.scrollTo({ top: to ? stopAt(to) : 0, behavior: smooth ? 'smooth' : 'auto' });
  };
  const toPanel = (smooth = true) => go(page.current?.querySelector('.now__left > .wave'), smooth);
  const toFull = () => go(second.current);
  const toPlayer = () => go(null);
  useEffect(() => {
    const p = page.current;
    if (!p) return;
    const seen = () => {
      setDown(p.scrollTop < 24);
      setFull(Boolean(second.current) && p.scrollTop >= stopAt(second.current!) - 4);
    };
    seen();
    p.addEventListener('scroll', seen, { passive: true });
    return () => p.removeEventListener('scroll', seen);
  }, []);
  // Phones: pulling the player down from the top closes it, like the arrow does.
  useEffect(() => {
    const p = page.current;
    if (!p) return;
    let from: number | undefined;
    let dy = 0;
    let at = 0;
    const start = (e: TouchEvent) => {
      const onSeekBar = (e.target as Element).closest('.wave, input');
      from = p.scrollTop <= 0 && !onSeekBar && matchMedia('(max-width: 899px)').matches ? e.touches[0].clientY : undefined;
      dy = 0;
      at = Date.now();
    };
    const move = (e: TouchEvent) => {
      if (from === undefined) return;
      dy = e.touches[0].clientY - from;
      // Upwards is the card's swipe, not this.
      if (dy <= 0 && !p.style.transform) {
        from = undefined;
        return;
      }
      e.preventDefault();
      p.style.transition = 'none';
      p.style.transform = `translateY(${Math.max(0, dy)}px)`;
    };
    const end = () => {
      if (from === undefined) return;
      from = undefined;
      p.style.transition = 'transform 0.22s ease';
      if (dy > 140 || (dy > 50 && Date.now() - at < 250)) {
        p.style.transform = 'translateY(100%)';
        setTimeout(onClose, 200);
      } else p.style.transform = '';
    };
    p.addEventListener('touchstart', start, { passive: true });
    p.addEventListener('touchmove', move, { passive: false });
    p.addEventListener('touchend', end);
    p.addEventListener('touchcancel', end);
    return () => {
      p.removeEventListener('touchstart', start);
      p.removeEventListener('touchmove', move);
      p.removeEventListener('touchend', end);
      p.removeEventListener('touchcancel', end);
    };
  }, [onClose]);
  const open = (next: 'lyrics' | 'queue') => {
    setPicked({ tab: next, song: track?.id });
    // Expanded, it stays expanded.
    if (!full) toPanel();
  };
  useEffect(() => {
    if (firstTab) requestAnimationFrame(() => toPanel(false));
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { tint, bright } = useTints(track?.cover);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    if (!track) onClose();
  }, [track, onClose]);
  if (!track) return null;
  const from = source?.title && (
    <>
      {t('Playing from')}
      <b>{source.title}</b>
    </>
  );
  return (
    <div className={`now ${down ? 'now--down' : ''}`} ref={page} data-layer="top" style={{ '--tint': tint, '--bright': bright } as React.CSSProperties} role="dialog" aria-label={t('Now playing')}>
      <div className="now__top">
        <button className="icon-btn" aria-label={t('Close')} onClick={onClose} data-close>
          <ChevronDown size={26} />
        </button>
        <div className="now__from">{from}</div>
        <button
          className="icon-btn"
          aria-label={t('More')}
          onClick={(e) =>
            showMenu(
              e,
              <>
                <TrackMenu track={track} />
                <hr />
                <TogetherItem />
              </>,
            )
          }
        >
          <MoreHorizontal size={22} />
        </button>
      </div>
      <div className="now__left">
        <Cover cover={track.cover} size={1200} />
        <div className="now__info">
          <div>
            <Link className="now__title" to={track.albumId ? `/album/${track.albumId}` : '#'} onClick={onClose}>
              {track.title}
            </Link>
            <Link className="now__artist" to={track.artistId ? `/artist/${track.artistId}` : '#'} onClick={onClose}>
              {track.artist}
            </Link>
          </div>
          <LikeNow size={26} />
        </div>
        <WaveProgress />
        <Controls big />
        <div className="now__extras">
          <TogetherChip />
          <OutputButton />
          <QualityBadge />
        </div>
      </div>
      <div className="now__right" ref={second}>
        {/* Wide: over the lyrics (or queue), level with the top of the cover. */}
        {from && <div className="now__from now__source">{from}</div>}
        <div className="now__head">
          {/* Phones: the card peeks below the player; swipe up (or tap the handle) for the lyrics, down to go back. */}
          <button className="now__grab" aria-label={tab === 'lyrics' ? t('Lyrics') : t('Queue')} onClick={() => (page.current && page.current.scrollTop > 10 ? toPlayer() : toPanel())} />
          <div className="now__tabs chips">
            <button className={`chip ${tab === 'lyrics' ? 'on' : ''}`} onClick={() => open('lyrics')}>
              {t('Lyrics')}
            </button>
            <button className={`chip ${tab === 'queue' ? 'on' : ''}`} onClick={() => open('queue')}>
              {t('Queue')}
            </button>
          </div>
          <button className="icon-btn now__expand" aria-label={full ? t('Collapse') : t('Expand')} onClick={() => (full ? toPanel() : toFull())}>
            {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        </div>
        <div className="now__panel">{tab === 'lyrics' ? <LyricsView songId={track.id} /> : <QueueView onClose={onClose} />}</div>
      </div>
    </div>
  );
}

/** Where the phone page scrolls to for this stop: the element's top, less its scroll margin. */
function stopAt(el: Element): number {
  return el instanceof HTMLElement ? el.offsetTop - parseFloat(getComputedStyle(el).scrollMarginTop || '0') : 0;
}

const OUTPUT_ICONS: Record<NativeOutput['kind'], typeof Speaker> = { phone: MonitorSpeaker, headphones: Headphones, bluetooth: Bluetooth, airplay: Airplay, car: Car, tv: Tv, speaker: Speaker };

/** Where it plays (the apps): the phone itself, or AirPods, a car, a speaker, named. */
function OutputButton() {
  const output = usePlayer((s) => s.output);
  const choose = nativeAudio?.outputs;
  if (!choose) return null;
  const Icon = OUTPUT_ICONS[output?.kind ?? 'phone'] ?? MonitorSpeaker;
  const away = output && output.kind !== 'phone';
  return (
    <button className={`quality output ${away ? 'on' : ''}`} aria-label={t('Play on another device')} onClick={(e) => choose(e.currentTarget.getBoundingClientRect())}>
      <Icon size={14} />
      {away && <span className="output__name">{output.name}</span>}
    </button>
  );
}

function QualityBadge() {
  const track = usePlayer((s) => s.queue[s.index]);
  const me = useMe();
  if (!track || !me) return null;
  const chosen = QUALITIES.find((q) => q.value === me.prefs.quality);
  return (
    <button
      className="quality"
      aria-label={t('Sound quality')}
      onClick={(e) =>
        showMenu(
          e,
          <>
            <div className="menu__head">
              <b>{t('Sound quality')}</b>
            </div>
            <hr />
            {QUALITIES.map((q) => (
              <Item key={q.value} icon={me.prefs.quality === q.value ? <Check size={18} /> : <span style={{ width: 18 }} />} onClick={() => void setQuality(q.value)}>
                <span>
                  {q.label()}
                  <small className="muted" style={{ display: 'block', fontSize: 12 }}>
                    {q.detail()}
                  </small>
                </span>
              </Item>
            ))}
          </>,
        )
      }
    >
      <AudioLines size={14} />
      {playingAs(track)}
      {chosen && me.prefs.quality !== 'original' && <span className="quality__level">{chosen.label()}</span>}
    </button>
  );
}

function LyricsView({ songId }: { songId: string }) {
  const lyrics = useQuery({ queryKey: ['lyrics', songId], queryFn: () => api.lyrics(songId), staleTime: Infinity });
  const time = usePlayer((s) => s.time);
  const box = useRef<HTMLDivElement>(null);
  const lines = lyrics.data?.lines ?? [];
  const synced = Boolean(lyrics.data?.synced);
  const at = useMemo(() => {
    if (!synced) return -1;
    let i = -1;
    for (let j = 0; j < lines.length; j++) if ((lines[j].time ?? 0) <= time + 0.25) i = j;
    return i;
  }, [lines, time, synced]);
  useEffect(() => {
    if (at < 0) return;
    // Scroll the lyrics alone (scrollIntoView would move the whole screen on phones), keeping the
    // line in the middle of what's on screen: on phones the card can run past the bottom.
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${at}"]`);
    const scroller = box.current?.closest<HTMLElement>('.now__panel');
    if (!el || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const seen = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const view = seen > 120 ? seen : scroller.clientHeight;
    scroller.scrollTo({ top: el.offsetTop - scroller.offsetTop - view / 2 + el.clientHeight / 2, behavior: 'smooth' });
  }, [at]);
  if (lyrics.isLoading) return <Spinner />;
  if (!lines.length) return <Empty>{t('No lyrics for this song')}</Empty>;
  return (
    <div className={`lyrics ${synced ? '' : 'lyrics--plain'}`} ref={box}>
      {lines.map((l, i) => (
        <p key={i} data-i={i} className={i === at ? 'now-line' : i < at ? 'past' : ''} onClick={() => synced && l.time !== undefined && seek(l.time)}>
          {l.text || '♪'}
        </p>
      ))}
    </div>
  );
}

function QueueView({ onClose }: { onClose: () => void }) {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const source = usePlayer((s) => s.source);
  const now = queue[index];
  const upcoming = queue.slice(index + 1, index + 101);
  return (
    <div className="queue">
      <h3>{t('Now playing')}</h3>
      {now && <QueueRow trackIndex={index} />}
      {upcoming.length > 0 && <h3>{source?.title ? t('Next from {name}', { name: source.title }) : t('Next up')}</h3>}
      {upcoming.map((_, i) => (
        <QueueRow key={`${queue[index + 1 + i].id}-${index + 1 + i}`} trackIndex={index + 1 + i} onClose={onClose} />
      ))}
      {!upcoming.length && <Empty>{t('Nothing else queued')}</Empty>}
    </div>
  );
}

function QueueRow({ trackIndex }: { trackIndex: number; onClose?: () => void }) {
  const track = usePlayer((s) => s.queue[trackIndex]);
  const isNow = usePlayer((s) => s.index === trackIndex);
  if (!track) return null;
  return (
    <div className={`track ${isNow ? 'playing' : ''}`} onDoubleClick={() => jump(trackIndex)}>
      <div className="track__main">
        <Cover cover={track.cover} size={100} />
        <div className="track__text">
          <button className="track__title" style={{ textAlign: 'left', maxWidth: '100%' }} onClick={() => jump(trackIndex)}>
            {track.title}
          </button>
          <span className="track__artist">{track.artist}</span>
        </div>
      </div>
      <span />
      <button className="icon-btn" aria-label={t('More')} onClick={(e) => showMenu(e, <TrackMenu track={track} queueIndex={isNow ? undefined : trackIndex} />)}>
        <MoreHorizontal size={18} />
      </button>
    </div>
  );
}

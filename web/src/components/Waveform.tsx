import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { t } from '../i18n';
import { clock } from '../lib/format';
import { getPlayer, seek, usePlayer } from '../lib/player';
import { Progress } from './PlayerBar';

/**
 * Now Playing's seek bar: the song's own shape (measured once by the server), the part already
 * played in violet. Click or drag anywhere to go there; the keyboard and TV remotes use the
 * invisible slider on top. Until the shape is ready it's the plain bar.
 */

const BAR = 3;
const GAP = 2;
const PLAYED = '#dccbff';
const AHEAD = 'rgba(241, 238, 252, 0.24)';
const HOVER = 'rgba(220, 203, 255, 0.5)';

export function WaveProgress() {
  const id = usePlayer((s) => s.queue[s.index]?.id);
  const nextId = usePlayer((s) => s.queue[s.index + 1]?.id);
  const qc = useQueryClient();
  const wave = useQuery({ queryKey: ['wave', id], queryFn: () => api.wave(id!), enabled: Boolean(id), staleTime: Infinity, retry: false });
  // The next song's shape, ready for when it starts.
  useEffect(() => {
    if (nextId) void qc.prefetchQuery({ queryKey: ['wave', nextId], queryFn: () => api.wave(nextId), staleTime: Infinity, retry: false });
  }, [nextId, qc]);
  if (!wave.data?.peaks.length) return <Progress />;
  return <Waveform peaks={wave.data.peaks} />;
}

function Waveform({ peaks }: { peaks: number[] }) {
  const time = usePlayer((s) => s.time);
  const playing = usePlayer((s) => s.playing);
  const duration = usePlayer((s) => s.duration || s.queue[s.index]?.duration || 0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number>();
  const [width, setWidth] = useState(0);
  // Where the player said it was, and when: between its reports the playhead moves on by itself.
  const said = useRef({ time, at: performance.now() });
  useEffect(() => {
    said.current = { time, at: performance.now() };
  }, [time]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !width) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const h = el.clientHeight;
    el.width = Math.round(width * dpr);
    el.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);
    // As many bars as fit, each the average of the measurements it covers (the loudest would flatten it).
    const count = Math.max(1, Math.floor((width + GAP) / (BAR + GAP)));
    const bars = Array.from({ length: count }, (_, i) => {
      const from = Math.floor((i * peaks.length) / count);
      const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / count));
      let sum = 0;
      for (let j = from; j < to; j++) sum += peaks[j] ?? 0;
      return sum / (to - from) / 255;
    });
    let frame = 0;
    const draw = () => {
      const now = getPlayer();
      const elapsed = now.playing ? (performance.now() - said.current.at) / 1000 : 0;
      const at = duration ? Math.min(1, (said.current.time + elapsed) / duration) : 0;
      ctx.clearRect(0, 0, width, h);
      for (let i = 0; i < count; i++) {
        const x = i * (BAR + GAP);
        const barH = Math.max(3, bars[i] * h);
        const pos = (x + BAR / 2) / width;
        ctx.fillStyle = pos <= at ? PLAYED : hover !== undefined && pos <= hover ? HOVER : AHEAD;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, (h - barH) / 2, BAR, barH, 1.5);
        else ctx.rect(x, (h - barH) / 2, BAR, barH);
        ctx.fill();
      }
      if (now.playing) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [peaks, width, duration, hover, playing, time]);

  const pct = duration ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <div className="progress wave">
      <span>{clock(time)}</span>
      <div
        className="wave__box"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
        onMouseLeave={() => setHover(undefined)}
      >
        <canvas ref={canvas} className="wave__canvas" aria-hidden="true" />
        <input
          className="wave__input"
          type="range"
          min={0}
          max={duration || 1}
          step={1}
          value={Math.min(time, duration || 1)}
          aria-label={t('Position')}
          aria-valuetext={`${clock(time)} / ${clock(duration)}`}
          style={{ '--p': `${pct}%` } as React.CSSProperties}
          onChange={(e) => seek(Number(e.target.value))}
        />
        {hover !== undefined && duration > 0 && (
          <span className="wave__tip" style={{ left: `${hover * 100}%` }}>
            {clock(hover * duration)}
          </span>
        )}
      </div>
      <span>{clock(duration)}</span>
    </div>
  );
}

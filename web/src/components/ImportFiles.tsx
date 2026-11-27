import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, FileAudio, FolderOpen, ImagePlus, X } from 'lucide-react';
import type { GetState } from '@tuna/shared';
import { api, ApiError, type StagedFile } from '../api';
import { t, tn } from '../i18n';
import { clock } from '../lib/format';
import { hello } from '../lib/native';
import { Sheet, toast } from './ui';

/** What the files are for: one song, an album (asked for, or any), or whatever their tags say. */
export type ImportTarget = { kind: 'song'; title: string; artist: string; album?: string } | { kind: 'album'; artist: string; album: string; mbid?: string } | { kind: 'any' };

const SONG_FILE = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac|wma|ape|wv)$/i;
const COVER_FILE = /(^|\/)(cover|folder|front)\.(jpe?g|png|webp)$/i;
// Choosing a whole folder: computers only.
const folders = !/^(ios|android|androidtv)$/.test(hello?.platform ?? '') && !window.matchMedia('(pointer: coarse)').matches;
const newBatch = () => Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 10)).join('');
const failed = (err: unknown) => (err instanceof ApiError ? err.message : t("Couldn't send it"));
/** The most common of some values (an album's artist, its name, its year, across its files). */
const most = (values: Array<string | undefined>) => {
  const n = new Map<string, number>();
  for (const v of values) if (v) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const same = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

type Row = {
  file: File;
  id?: string;
  seconds?: number;
  guess?: StagedFile['guess'];
  title: string;
  artist: string;
  number?: number;
  disc?: number;
  /** Sent so far (0–1), while it goes. */
  sending?: number;
  /** Why it can't go in (it didn't arrive, or it isn't the song). */
  why?: string;
  done?: boolean;
};

/**
 * Files someone has (and a cover): sent as soon as they're chosen, then shown with their names filled
 * in (from the song or album asked for, what MusicBrainz knows, their tags) to look over and change,
 * then put into the library, each said where it went or why not.
 */
export function ImportFiles({ target, onClose, onSent }: { target: ImportTarget; onClose: () => void; onSent?: (get: GetState) => void }) {
  const batch = useMemo(newBatch, []);
  const [rows, setRows] = useState<Row[]>([]);
  const [artist, setArtist] = useState(target.kind === 'song' ? target.artist.split(/\s*;\s*/)[0] : target.kind === 'album' ? target.artist : '');
  const [album, setAlbum] = useState(target.kind === 'song' ? (target.album ?? '') : target.kind === 'album' ? target.album : '');
  const [year, setYear] = useState('');
  const [mbid, setMbid] = useState(target.kind === 'album' ? target.mbid : undefined);
  const [cover, setCover] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [step, setStep] = useState<'pick' | 'sending' | 'form' | 'importing' | 'done'>('pick');
  const checked = useRef('');
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement | null>(null);
  const coverPicker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!cover) return setPreview(undefined);
    const url = URL.createObjectURL(cover);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);
  const fine = rows.filter((r) => r.id && !r.why);
  const update = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** What MusicBrainz (through Lidarr) knows of the album: its year, each file's song on it, and why one can't be. */
  const check = async (list: Row[], names: { artist: string; album: string; mbid?: string }) => {
    const sent = list.filter((r) => r.id);
    if (!names.artist || !names.album || !sent.length) return;
    checked.current = `${names.artist}|${names.album}`;
    const r = await api.checkFiles({ ...names, files: sent.map((x) => ({ id: x.id!, title: x.title, number: x.number, disc: x.disc })) }).catch(() => undefined);
    if (!r?.album) return;
    const known = r.album;
    setYear((y) => y || known.year || '');
    setMbid((m) => m ?? known.mbid);
    setRows((now) =>
      now.map((x) => {
        const found = r.files.find((f) => f.id === x.id);
        if (!found?.title || (x.why && !x.id)) return x;
        return { ...x, title: list.length === 1 && target.kind === 'song' ? x.title : found.title, number: found.number ?? x.number, disc: found.disc ?? x.disc, why: found.why };
      }),
    );
  };

  const take = async (list: FileList | null) => {
    const all = [...(list ?? [])];
    const songs = all.filter((f) => SONG_FILE.test(f.name)).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
    if (!songs.length) return toast(t("That isn't a song file"));
    const found = all.find((f) => COVER_FILE.test(f.webkitRelativePath || f.name));
    if (found && !cover) setCover(found);
    if (rows.some((r) => r.id)) void api.discardFiles(batch).catch(() => undefined);
    const fresh: Row[] = songs.map((file) => ({ file, title: file.name.replace(/\.[^.]+$/, ''), artist: '', sending: 0 }));
    setRows(fresh);
    setStep('sending');
    // One by one, each with what it seems to be.
    const got: Row[] = [];
    for (const [i, row] of fresh.entries()) {
      try {
        const r = await api.stageFile({ batch, name: row.file.name, path: row.file.webkitRelativePath || undefined }, row.file, (part) => update(i, { sending: part }));
        got.push({ ...row, id: r.id, seconds: r.seconds, guess: r.guess, sending: undefined });
      } catch (err) {
        got.push({ ...row, why: failed(err), sending: undefined });
      }
      update(i, got[i]);
    }
    // Filled in: the song or album asked for first, then what the files say.
    const ok = got.filter((r) => r.guess);
    const names = {
      artist: artist || most(ok.map((r) => r.guess!.albumArtist)) || most(ok.map((r) => r.guess!.artist)) || '',
      album: album || most(ok.map((r) => r.guess!.album)) || (target.kind === 'song' ? target.title : ''),
      year: year || most(ok.map((r) => r.guess!.year)) || '',
    };
    const filled = got.map((r) =>
      !r.guess
        ? r
        : target.kind === 'song' && got.length === 1
          ? { ...r, title: target.title, artist: target.artist.split(/\s*;\s*/).join('; '), number: r.guess.number, disc: r.guess.disc }
          : { ...r, title: r.guess.title, artist: r.guess.artist || names.artist, number: r.guess.number, disc: r.guess.disc },
    );
    setArtist(names.artist);
    setAlbum(names.album);
    setYear(names.year);
    setRows(filled);
    setStep('form');
    await check(filled, { artist: names.artist, album: names.album, mbid });
  };

  const close = () => {
    if (step === 'importing' || step === 'sending') return;
    if (step !== 'done' && rows.some((r) => r.id)) void api.discardFiles(batch).catch(() => undefined);
    onClose();
  };

  const go = async () => {
    setStep('importing');
    try {
      if (cover) await api.sendCover(batch, cover);
      const r = await api.importFiles({
        batch,
        song: target.kind === 'song' ? { artist: target.artist, title: target.title } : undefined,
        album: { artist: artist.trim(), title: album.trim(), year: year.trim() || undefined, mbid },
        files: fine.map((x) => ({ id: x.id!, title: x.title.trim(), artist: x.artist.trim() || undefined, number: x.number, disc: x.disc })),
      });
      const results = new Map(r.files.map((f) => [f.id, f.why]));
      setRows((now) => now.map((x) => (x.id && results.has(x.id) ? { ...x, done: !results.get(x.id), why: results.get(x.id) } : x)));
      const n = r.files.filter((f) => !f.why).length;
      if (n) onSent?.({ state: 'looking' });
      if (n === rows.length) {
        toast(tn(n, 'Importing {n} song', 'Importing {n} songs'));
        return onClose();
      }
      setStep('done');
    } catch (err) {
      toast(failed(err));
      setStep('form');
    }
  };

  // Another artist or album: what MusicBrainz knows of that one.
  const recheck = () => {
    if (step !== 'form' || `${artist}|${album}` === checked.current) return;
    const asked = target.kind === 'album' && same(artist, target.artist) && same(album, target.album);
    if (!asked) setMbid(undefined);
    setRows((now) => now.map((x) => (x.id ? { ...x, why: undefined } : x)));
    void check(rows, { artist, album, mbid: asked ? mbid : undefined });
  };
  const busy = step === 'sending' || step === 'importing';
  const locked = busy || step === 'done';
  const total = rows.reduce((n, r) => n + r.file.size, 0);
  const progress = rows.reduce((n, r) => n + r.file.size * (r.sending ?? (r.id || r.why ? 1 : 0)), 0) / Math.max(1, total);

  return createPortal(
    <div onClick={(e) => e.stopPropagation()}>
      <Sheet title={target.kind === 'song' ? t('Import a file') : t('Import files')} onClose={close} wide>
        <div className="import">
          <button className="import__cover" onClick={() => coverPicker.current?.click()} disabled={locked} aria-label={t('Cover')}>
            {preview ? <img src={preview} alt="" /> : <ImagePlus size={26} />}
            <span>{t('Cover')}</span>
          </button>
          <div className="import__fields">
            <label className="field">
              <span>{t('Artist')}</span>
              <input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} onBlur={recheck} disabled={locked} />
            </label>
            <div className="import__row">
              <label className="field">
                <span>{t('Album')}</span>
                <input className="input" value={album} onChange={(e) => setAlbum(e.target.value)} onBlur={recheck} disabled={locked} />
              </label>
              <label className="field import__year">
                <span>{t('Year')}</span>
                <input className="input" value={year} inputMode="numeric" maxLength={4} onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} disabled={locked} />
              </label>
            </div>
          </div>
        </div>
        {step !== 'done' && (
          <div className="import__pick">
            <button className="btn btn--small" onClick={() => filePicker.current?.click()} disabled={busy}>
              <FileAudio size={16} /> {rows.length ? t('Other files') : t('Choose files')}
            </button>
            {folders && (
              <button className="btn btn--small btn--ghost" onClick={() => folderPicker.current?.click()} disabled={busy}>
                <FolderOpen size={16} /> {t('A folder')}
              </button>
            )}
          </div>
        )}
        {rows.length > 0 && (
          <ol className="import__songs">
            {rows.map((r, i) => {
              const off = step !== 'form' || !r.id || Boolean(r.why && !r.id);
              return (
                <li key={`${r.file.webkitRelativePath || r.file.name}-${i}`} className={r.done ? 'is-in' : r.why ? 'is-out' : ''}>
                  <input className="input import__n" aria-label="#" inputMode="numeric" value={r.number ?? ''} onChange={(e) => update(i, { number: Number(e.target.value.replace(/\D/g, '')) || undefined })} disabled={off} />
                  <div className="import__song">
                    <input className="input" aria-label={t('Title')} value={r.title} onChange={(e) => update(i, { title: e.target.value })} disabled={off} />
                    <input className="input import__by" aria-label={t('Artist')} value={r.artist} placeholder={artist} onChange={(e) => update(i, { artist: e.target.value })} disabled={off} />
                    {r.why && (
                      <small className="import__why">
                        <X size={13} /> {r.why}
                      </small>
                    )}
                  </div>
                  <span className="import__len">
                    {r.done ? <Check size={16} aria-label={t('In the library')} /> : r.sending !== undefined ? `${Math.round(r.sending * 100)}%` : r.seconds ? clock(r.seconds) : ''}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <input ref={filePicker} type="file" hidden multiple accept="audio/*,.flac,.mp3,.m4a,.ogg,.opus,.wav,.aiff,.aif,.wma" onChange={(e) => (void take(e.target.files), (e.target.value = ''))} />
        <input
          ref={(el) => {
            folderPicker.current = el;
            el?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          hidden
          onChange={(e) => (void take(e.target.files), (e.target.value = ''))}
        />
        <input
          ref={coverPicker}
          type="file"
          hidden
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) setCover(f);
          }}
        />
        {step === 'sending' && (
          <div className="import__bar" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
            <i style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} />
          </div>
        )}
        <div className="sheet__buttons">
          {step === 'done' ? (
            <button className="btn btn--primary" onClick={onClose}>
              {t('Done')}
            </button>
          ) : (
            <>
              <button className="btn btn--ghost" onClick={close} disabled={busy}>
                {t('Cancel')}
              </button>
              <button className="btn btn--primary" disabled={step !== 'form' || !fine.length || !artist.trim() || !album.trim()} onClick={() => void go()}>
                {step === 'sending' ? `${Math.round(progress * 100)}%` : step === 'importing' ? t('Importing') : fine.length > 1 ? tn(fine.length, 'Import {n} song', 'Import {n} songs') : t('Import')}
              </button>
            </>
          )}
        </div>
      </Sheet>
    </div>,
    document.body,
  );
}

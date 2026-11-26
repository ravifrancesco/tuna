import crypto from 'node:crypto';
import { slskd as slskdConnection } from '../connections';
import { NotConfiguredError, request, type RequestOptions } from '../lib/upstream';

/** slskd, the household's Soulseek client: single songs, searched for and downloaded by name. */

const SERVICE = 'slskd';

function call<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const c = slskdConnection();
  if (!c) throw new NotConfiguredError(SERVICE);
  return request<T>(SERVICE, c.url, `/api/v0${path}`, { ...opts, headers: { 'X-API-Key': c.apiKey, ...opts.headers } });
}

export interface SFile {
  /** Its path in the other person's share, Windows-style as often as not. */
  filename: string;
  size: number;
  bitRate?: number;
  bitDepth?: number;
  sampleRate?: number;
  /** Seconds. */
  length?: number;
  extension?: string;
  isLocked?: boolean;
}
export interface SResponse {
  username: string;
  files: SFile[];
  hasFreeUploadSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
}
export interface STransfer {
  id: string;
  username: string;
  filename: string;
  size: number;
  /** "Queued, Remotely", "InProgress", "Completed, Succeeded", "Completed, Errored"… */
  state: string;
  percentComplete?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Who has it: everyone that answered within the search's ten seconds. */
export async function search(text: string): Promise<SResponse[]> {
  const id = crypto.randomUUID();
  await call('/searches', { method: 'POST', body: { id, searchText: text, searchTimeout: 10_000, responseLimit: 100, fileLimit: 2000, filterResponses: true } });
  try {
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      if ((await call<{ isComplete?: boolean }>(`/searches/${id}`)).isComplete) break;
    }
    return await call<SResponse[]>(`/searches/${id}/responses`);
  } finally {
    await call(`/searches/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

export const download = (username: string, files: Array<{ filename: string; size: number }>) =>
  call(`/transfers/downloads/${encodeURIComponent(username)}`, { method: 'POST', body: files });

export async function transfers(): Promise<STransfer[]> {
  const users = await call<Array<{ username: string; directories?: Array<{ files?: STransfer[] }> }>>('/transfers/downloads');
  return users.flatMap((u) => (u.directories ?? []).flatMap((d) => (d.files ?? []).map((f) => ({ ...f, username: u.username }))));
}

export const cancel = (username: string, id: string) => call(`/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}`, { method: 'DELETE', query: { remove: true } });

/** Where slskd saves downloads, as slskd sees it. */
export const downloadsFolder = () => call<{ directories?: { downloads?: string } }>('/options').then((o) => o.directories?.downloads);

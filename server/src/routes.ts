import type { FastifyInstance } from 'fastify';
import type { DeviceCommand, Me, ServerInfo, StatsPeriod, TogetherControl, Track } from '@tuna/shared';
import { config } from './config';
import { SETUP_CODE, connections, has, saveConnections, type ConnectionsPatch } from './connections';
import { t } from './lib/i18n';
import { HttpError } from './lib/upstream';
import { authOf, mediaSessionOf, requireAdmin, requireUser, setCookie, signIn, signOut, sessionOf, COOKIE, type Session } from './sessions';
import * as getting from './services/getting';
import { home } from './services/home';
import { addedDates, forgetAdded, noteAdded } from './services/added';
import { importedSongs, LIKED, orderLiked, waitingIn } from './services/imported';
import { addPerson, changePerson, people, removePerson } from './services/household';
import * as library from './services/library';
import { listeningHistory, listeningStats, yearInReview } from './services/listens';
import { importSpotify } from './services/spotify';
import { getMany, missedAlbums, saveStocking, stillToAsk, stocking, stopAsking } from './services/stocking';
import { lookAgain, songItems, songsNotFound, songsWaiting, stopSongs, wantSongs, withTracks } from './services/songs';
import { arrived, discoverySettings, saveDiscovery, topUpRadio } from './services/discovery';
import * as together from './services/together';
import * as devices from './services/devices';
import { openLine } from './lib/sse';
import { lyrics } from './services/lyrics';
import { autoplay, blends, dailyMixes, mixTracks } from './services/mixes';
import { art, countPlay, cover, stream } from './services/playback';
import { listenbrainzOf, prefsOf, savePrefs } from './services/prefs';
import { searchLibrary, searchWorld } from './services/search';
import { nightWaves, saveNightWaves } from './services/nightWaves';
import { waveOf } from './services/waveform';
import { artistDetail, worldAlbum, worldArtist } from './services/world';

const me = (s: Session): Me => ({ id: s.userId, username: s.username, name: s.name, admin: s.admin, mediaKey: s.mediaKey, prefs: prefsOf(s.username) });

export async function apiRoutes(app: FastifyInstance) {
  // The apps check an address with this before keeping it.
  app.get('/health', async () => ({ ok: true, name: 'tuna', version: config.version }));

  app.get('/server', async (): Promise<ServerInfo> => ({
    version: config.version,
    ready: has.navidrome(),
    services: { navidrome: has.navidrome(), lidarr: has.lidarr(), slskd: has.slskd(), lastfm: has.lastfm() },
  }));

  // ---- First run: where Navidrome (and Lidarr) are, with the code from the server's log ----------
  app.post<{ Body: ConnectionsPatch & { code?: string } }>('/setup', async (req) => {
    if (has.navidrome()) throw new HttpError(409, t('Tuna is already set up. Admins can change this in Settings.'));
    if (String(req.body?.code ?? '').trim() !== SETUP_CODE) throw new HttpError(403, t("That setup code isn't right"));
    const { code: _code, ...patch } = req.body;
    return saveConnections(patch);
  });

  // ---- Signing in -------------------------------------------------------------------------------
  app.post<{ Body: { username?: string; password?: string } }>('/login', async (req, reply) => {
    const s = await signIn(req.body?.username ?? '', req.body?.password ?? '');
    setCookie(reply, s);
    // The apps keep the session id themselves (Bearer), as their players can't share the cookie.
    return { me: me(s), session: s.id };
  });

  app.post('/logout', async (req, reply) => {
    const s = sessionOf(req);
    if (s) signOut(s);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => me(requireUser(req)));

  app.put<{ Body: { quality?: Me['prefs']['quality']; listenbrainzToken?: string; lastfmUser?: string } }>('/me/prefs', async (req) => {
    const s = requireUser(req);
    return savePrefs(s.username, req.body ?? {});
  });

  app.get<{ Querystring: { period?: StatsPeriod } }>('/me/stats', async (req) => {
    const s = requireUser(req);
    const period = (['week', 'month', 'year', 'all'] as const).find((p) => p === req.query.period) ?? 'month';
    const stats = listeningStats(s.username, period);
    const liked = await library.liked(authOf(s)).catch(() => undefined);
    const ids = new Set(liked?.tracks.map((tr) => tr.id));
    for (const tr of stats.topSongs) tr.liked = ids.has(tr.id);
    return stats;
  });
  // The apps play downloaded songs from the device: the page says when one has been played.
  app.get<{ Querystring: { year?: string } }>('/me/year', async (req) => yearInReview(requireUser(req).username, Number(req.query.year) || new Date().getFullYear()));
  app.post<{ Body: { id?: string } }>('/me/played', async (req) => {
    const s = requireUser(req);
    if (req.body?.id) await countPlay(s, String(req.body.id), 'device');
    return { ok: true };
  });
  app.get<{ Querystring: { offset?: string; size?: string } }>('/me/history', async (req) => {
    const s = requireUser(req);
    return listeningHistory(s.username, Math.max(0, Number(req.query.offset) || 0), Math.min(200, Math.max(1, Number(req.query.size) || 50)));
  });

  // Spotify's data download (or Exportify's CSV files), sent as they are.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post<{ Querystring: { name?: string }; Body: Buffer }>('/me/import/spotify', async (req) => {
    const s = requireUser(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, t("There's nothing from Spotify in that file"));
    return importSpotify(authOf(s), s.username, req.query.name ?? '', req.body);
  });

  // ---- The library -----------------------------------------------------------------------------
  app.get('/home', async (req) => {
    const s = requireUser(req);
    return home(authOf(s), s.name, listenbrainzOf(s.username).user);
  });

  app.get<{ Querystring: { sort?: library.AlbumSort; offset?: string; size?: string } }>('/albums', async (req) => {
    const s = requireUser(req);
    const sort = req.query.sort ?? 'alphabeticalByName';
    return library.albums(authOf(s), sort, Math.min(500, Number(req.query.size) || 60), Number(req.query.offset) || 0);
  });

  app.get<{ Params: { id: string } }>('/album/:id', async (req) => library.album(authOf(requireUser(req)), req.params.id));
  app.get('/artists', async (req) => library.artists(authOf(requireUser(req))));
  app.get<{ Params: { id: string } }>('/artist/:id', async (req) => artistDetail(authOf(requireUser(req)), req.params.id));
  app.get<{ Params: { id: string } }>('/song/:id', async (req) => library.song(authOf(requireUser(req)), req.params.id));

  app.get('/playlists', async (req) => library.playlists(authOf(requireUser(req))));
  app.get<{ Params: { id: string } }>('/playlist/:id', async (req) => {
    const s = requireUser(req);
    const p = await library.playlist(authOf(s), req.params.id);
    // When each song went in: added here, else Spotify's date (the importer's own playlists).
    const ours = addedDates(p.id);
    const theirs = importedSongs(p.mine ? s.username : (p.owner ?? ''), p.id);
    return { ...p, added: p.tracks.map((tr) => ours[tr.id] ?? theirs.get(tr.id) ?? null), waiting: waitingIn(s.username, p.id, p.tracks) };
  });
  app.post<{ Body: { name?: string; tracks?: string[] } }>('/playlists', async (req) => {
    const name = req.body?.name?.trim();
    if (!name) throw new HttpError(400, t('Give the playlist a name'));
    const made = await library.createPlaylist(authOf(requireUser(req)), name, req.body.tracks ?? []);
    noteAdded(made.id, req.body.tracks ?? []);
    return made;
  });
  app.put<{ Params: { id: string }; Body: { name?: string; add?: string[]; remove?: number[]; order?: string[] } }>('/playlist/:id', async (req) => {
    const p = await library.updatePlaylist(authOf(requireUser(req)), req.params.id, req.body ?? {});
    noteAdded(req.params.id, req.body?.add ?? []);
    return p;
  });
  app.delete<{ Params: { id: string } }>('/playlist/:id', async (req) => {
    await library.deletePlaylist(authOf(requireUser(req)), req.params.id);
    forgetAdded(req.params.id);
    return { ok: true };
  });

  app.get('/liked', async (req) => {
    const s = requireUser(req);
    const { starred, ...l } = await library.liked(authOf(s));
    const tracks = orderLiked(s.username, l.tracks);
    // When each was liked: Spotify's date for likes brought over (unknown in its library file), else when it was liked here.
    const imported = importedSongs(s.username, LIKED);
    const added = tracks.map((tr) => (imported.has(tr.id) ? (imported.get(tr.id) ?? null) : (starred[tr.id] ?? null)));
    return { ...l, tracks, added, waiting: waitingIn(s.username, LIKED, tracks) };
  });
  app.post<{ Body: { kind: 'track' | 'album' | 'artist'; id: string; on: boolean } }>('/like', async (req) => {
    const { kind, id, on } = req.body ?? ({} as never);
    if (!['track', 'album', 'artist'].includes(kind) || !id) throw new HttpError(400, 'kind and id');
    await library.like(authOf(requireUser(req)), kind, id, Boolean(on));
    return { ok: true };
  });

  app.get<{ Querystring: { q?: string } }>('/search', async (req) => searchLibrary(authOf(requireUser(req)), req.query.q ?? ''));
  app.get<{ Querystring: { q?: string } }>('/search/world', async (req) => searchWorld(authOf(requireUser(req)), req.query.q ?? ''));

  app.get('/mixes', async (req) => {
    const s = requireUser(req);
    return [...(await dailyMixes(authOf(s))), ...blends(s.username, s.name)];
  });
  app.get<{ Params: { id: string } }>('/mix/:id', async (req) => {
    const s = requireUser(req);
    return mixTracks(authOf(s), req.params.id, listenbrainzOf(s.username).user);
  });

  app.get<{ Params: { id: string } }>('/lyrics/:id', async (req) => (await lyrics(authOf(requireUser(req)), req.params.id)) ?? { synced: false, lines: [], source: 'library' });

  // ---- Music and covers (cookie, or the media key for the apps' players) -------------------------
  app.get('/stream/:id', stream);
  app.get('/cover/:id', cover);
  app.get('/art', art);
  app.get<{ Params: { id: string } }>('/wave/:id', async (req, reply) => {
    const s = mediaSessionOf(req);
    if (!s) throw new HttpError(401, t('Please sign in'));
    const wave = await waveOf(authOf(s), req.params.id);
    if (!wave) return reply.code(404).send({ error: t('Not found') });
    // Kept by the browser for an hour: a waveform can be measured again (VERSION in services/waveform.ts).
    reply.header('cache-control', 'private, max-age=3600');
    return wave;
  });

  // ---- Beyond the library ------------------------------------------------------------------------
  app.get<{ Params: { mbid: string } }>('/world/artist/:mbid', async (req) => worldArtist(authOf(requireUser(req)), req.params.mbid));
  app.get<{ Params: { mbid: string } }>('/world/album/:mbid', async (req) => worldAlbum(authOf(requireUser(req)), req.params.mbid));
  app.post<{ Body: { mbid: string; artistMbid?: string; title?: string; artist?: string } }>('/get', async (req) => {
    const s = requireUser(req);
    const b = req.body ?? ({} as never);
    if (!b.mbid) throw new HttpError(400, 'mbid');
    return getting.get(s, { mbid: b.mbid, artistMbid: b.artistMbid, title: b.title ?? '', artist: b.artist ?? '' });
  });
  app.get('/getting', async (req) => {
    const s = requireUser(req);
    return getting.list(s.username, await withTracks(authOf(s), songItems()));
  });
  app.post('/getting/opened', async (req) => {
    const s = requireUser(req);
    getting.opened(s.username);
    return getting.list(s.username, songItems());
  });
  app.post<{ Body: { albums?: Array<{ artist: string; album: string }> } }>('/get/many', async (req) => ({ asked: getMany(requireUser(req), req.body?.albums ?? []) }));
  app.get('/get/missed', async (req) => (requireUser(req), missedAlbums()));
  // Everything people asked for that couldn't be found, looked for again (Settings).
  app.get('/get/again', async (req) => (requireAdmin(req), { songs: songsNotFound().length, albums: missedAlbums().length }));
  app.post('/get/again', async (req) => {
    const s = requireAdmin(req);
    const missed = missedAlbums().map((m) => ({ artist: m.artist, album: m.album }));
    return { songs: has.slskd() && has.lidarr() ? lookAgain(s.name) : 0, albums: missed.length && has.lidarr() ? getMany(s, missed) : 0 };
  });
  // New songs: the weekly ones for each person (an admin sets how many), and a radio's.
  app.get('/discovery', async (req) => (requireUser(req), discoverySettings()));
  app.put<{ Body: { perWeek?: number } }>('/discovery', async (req) => saveDiscovery(requireAdmin(req), Number(req.body?.perWeek) || 0));
  // A song's radio: its new songs that are here, keeping a handful more on the way (`heard`: how many it has played).
  app.get<{ Querystring: { seed?: string; heard?: string } }>('/radio/new', async (req) => {
    const s = requireUser(req);
    if (!req.query.seed) return [];
    topUpRadio(s.username, req.query.seed, Number(req.query.heard) || 0);
    return arrived(s.username, { radio: req.query.seed });
  });
  // Autoplay: what's playing ran out; songs like its last ones, none already in the queue.
  app.post<{ Body: { seeds?: string[]; have?: string[] } }>('/autoplay', async (req) => autoplay(authOf(requireUser(req)), req.body?.seeds ?? [], new Set(req.body?.have ?? [])));
  app.get('/get/waiting', async (req) => {
    const s = requireUser(req);
    const albums = stillToAsk(s);
    return { count: albums.count + songsWaiting(), mine: albums.mine + songsWaiting(s.name) };
  });
  app.post('/get/stop', async (req) => {
    const s = requireUser(req);
    return { stopped: stopAsking(s) + stopSongs(s.admin ? undefined : s.name) };
  });
  // Single songs (a playlist's missing songs, Get all): through slskd, filed by Lidarr; without slskd, their albums.
  app.post<{ Body: { songs?: Array<{ artist: string; title: string; album?: string }> } }>('/get/songs', async (req) => {
    const s = requireUser(req);
    const list = (req.body?.songs ?? []).filter((x) => x.artist && x.title).slice(0, 5000);
    if (has.slskd() && has.lidarr()) return { asked: wantSongs(s.name, list), songs: true };
    const albums = [...new Map(list.filter((x) => x.album).map((x) => [`${x.artist}|${x.album}`.toLowerCase(), { artist: x.artist, album: x.album! }])).values()];
    return { asked: getMany(s, albums), songs: false };
  });

  // ---- Devices (as Spotify Connect) ----------------------------------------------------------------
  // The live line: EventSource can't send the app's Bearer token, so the media key works too.
  app.get<{ Querystring: { device?: string; name?: string; kind?: string } }>('/devices/events', async (req, reply) => {
    const s = mediaSessionOf(req);
    if (!s) throw new HttpError(401, t('Please sign in'));
    const id = String(req.query.device ?? '').slice(0, 64);
    if (!id) throw new HttpError(400, 'device');
    const kind = (['phone', 'tablet', 'computer', 'tv', 'browser'] as const).find((k) => k === req.query.kind) ?? 'browser';
    devices.openDevice(s, id, String(req.query.name ?? '').slice(0, 40) || 'Tuna', kind, openLine(reply));
  });
  app.post<{ Body: { device?: string; playing?: boolean; index?: number; position?: number; queue?: Track[]; source?: unknown } }>('/devices/state', async (req) => {
    const b = req.body ?? {};
    if (b.device) devices.report(requireUser(req), b.device, { playing: Boolean(b.playing), index: Number(b.index ?? -1), position: Number(b.position ?? 0), queue: b.queue, source: b.source });
    return { ok: true };
  });
  app.post<{ Body: { to?: string; command?: DeviceCommand } }>('/devices/command', async (req) => {
    if (req.body?.to && req.body.command) devices.command(requireUser(req), req.body.to, req.body.command);
    return { ok: true };
  });
  app.post<{ Body: { to?: string } }>('/devices/transfer', async (req) => ({ ok: req.body?.to ? devices.transfer(requireUser(req), req.body.to) : false }));

  // ---- Play together -----------------------------------------------------------------------------
  app.get('/together', async (req) => {
    requireUser(req);
    return together.listRooms();
  });
  app.post<{ Body: { queue?: Track[]; index?: number; position?: number; playing?: boolean; title?: string } }>('/together', async (req) => together.createRoom(requireUser(req), req.body ?? {}));
  app.get<{ Params: { id: string } }>('/together/:id', async (req) => {
    requireUser(req);
    return together.getRoom(req.params.id);
  });
  // The live line: EventSource can't send the app's Bearer token, so the media key works too.
  app.get<{ Params: { id: string }; Querystring: { client?: string } }>('/together/:id/events', async (req, reply) => {
    const s = mediaSessionOf(req);
    if (!s) throw new HttpError(401, t('Please sign in'));
    const client = String(req.query.client ?? '').slice(0, 64);
    if (!client) throw new HttpError(400, 'client');
    together.getRoom(req.params.id);
    together.openStream(s, req.params.id, client, openLine(reply));
  });
  app.post<{ Params: { id: string }; Body: TogetherControl }>('/together/:id/control', async (req) => together.control(requireUser(req), req.params.id, req.body));
  app.post<{ Params: { id: string }; Body: { clientId?: string } }>('/together/:id/leave', async (req) => {
    together.leave(requireUser(req), req.params.id, String(req.body?.clientId ?? ''));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/together/:id', async (req) => {
    together.endForEveryone(requireUser(req), req.params.id);
    return { ok: true };
  });

  // ---- Admins ------------------------------------------------------------------------------------
  app.get('/connections', async (req) => {
    requireAdmin(req);
    return connections();
  });
  app.put<{ Body: ConnectionsPatch }>('/connections', async (req) => {
    requireAdmin(req);
    return saveConnections(req.body ?? {});
  });

  app.get('/stocking', async (req) => {
    requireAdmin(req);
    return stocking();
  });
  app.put<{ Body: { perWeek?: number } }>('/stocking', async (req) => saveStocking(requireAdmin(req), Number(req.body?.perWeek ?? 0)));
  app.get('/waves', async (req) => {
    requireAdmin(req);
    return nightWaves();
  });
  app.put<{ Body: { enabled?: boolean; from?: string; until?: string } }>('/waves', async (req) => {
    const s = requireAdmin(req);
    return saveNightWaves(req.body ?? {}, s.name);
  });

  app.get('/household', async (req) => people(requireAdmin(req)));
  app.post<{ Body: { username: string; name?: string; password: string; admin?: boolean } }>('/household', async (req) => addPerson(requireAdmin(req), req.body));
  app.put<{ Params: { id: string }; Body: { name?: string; password?: string; admin?: boolean } }>('/household/:id', async (req) =>
    changePerson(requireAdmin(req), req.params.id, req.body ?? {}),
  );
  app.delete<{ Params: { id: string } }>('/household/:id', async (req) => {
    await removePerson(requireAdmin(req), req.params.id);
    return { ok: true };
  });
}

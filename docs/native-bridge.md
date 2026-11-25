# The apps and the web interface

Every Tuna app is a thin shell around the server's web interface, like Netfish's, with one
difference: **the app owns the play queue**. The page tells the app what to play; the app plays
it with its own player, so music keeps going with the screen off, from the lock screen and
headphone buttons, and while the web view is suspended. The page shows what the app reports.

The web side of all this is `web/src/lib/native.ts` (the bridge) and `web/src/lib/player.ts`
(which uses it). The shared types are `NativeTrack` and `NativeAudioState` in `shared/src/index.ts`.

## Loading the interface

- First run: the app shows its own address page (`apps/ios/Tuna/setup.html`, `apps/windows/setup.html`…)
  asking for the server address (e.g. `http://192.168.1.10:7778`), checks `GET {server}/api/health`
  → `{"ok": true, "name": "tuna", "version": …}`, and keeps it.
- While connecting: `apps/common/loading.html` (the hook-and-fish animation, on the clock so the
  web page's opening animation carries it on in step). It has `window.tunaStatus(text)` for a status
  line and, away from home, `window.tunaTunnel('connecting' | 'connected')`, as Netfish's
  `netfishTunnel`: a ring (the tunnel) breathes beside the mark, then the mark swims into it and the
  ring comes to the centre. Once it's in (about 0.8 s after `connected`), open the server with
  `#tunnel`: the web page's opening animation takes over the same ring and the mark comes out of it.
- Then the web view opens `{server}/` itself (same origin: cookies, `localStorage` and the page's
  `fetch('/api/...')` all just work). External links (anything not on the server) open in the
  system browser.
- `changeServer` (below) goes back to the address page.

## Saying hello (before the page's scripts run)

The page reads, synchronously at start, what the app can do:

```js
window.tunaHello = {
  platform: 'mac' | 'windows' | 'ios' | 'android' | 'androidtv',
  version: '0.1.0',
  formats: ['mp3', 'aac', 'm4a', 'flac', 'alac', 'wav'],   // what the player plays as-is
  features: ['audio', 'changeServer', 'keepAwake', 'mobileData', 'outputs', 'tunnel', 'update'],
}
```

- **Android**: a `@JavascriptInterface` object named `TunaAndroid` with `String hello()` (that JSON)
  and `void post(String json)`.
- **iPhone/iPad, Mac**: a `WKUserScript` at document start that sets `window.tunaHello`; messages
  arrive on `WKScriptMessageHandler` named `tuna`.
- **Windows (WebView2)**: `AddScriptToExecuteOnDocumentCreatedAsync("window.tunaHello = …")`;
  messages arrive on `WebMessageReceived` (`e.WebMessageAsJson`).

Only list features that work. `formats`: Apple's AVPlayer → `mp3, aac, m4a, alac, flac, wav`;
ExoPlayer → add `opus, ogg`; Windows MediaPlayer → `mp3, aac, m4a, flac, wav, alac`. The server
converts anything else (the page asks for `f=mp3` or `f=opus` in the stream URL).

## Page → app

`{ "cmd": string, "args"?: object, "id"?: number }`. When there's an `id`, answer with a reply.

| cmd | args | reply |
|---|---|---|
| `audio.load` | `{ tracks: NativeTrack[], index, start /*seconds*/, play: boolean }` | — |
| `audio.update` | `{ tracks: NativeTrack[], index }` — a new queue around the song that's playing (shuffle, play next, add to queue, remove). **The current song carries on without a gap**; only what comes after changes. If the song moved on just before the update arrived, find the one playing in the new list (at `index`, then `index + 1`, then anywhere) and report the index it ended up at. | — |
| `audio.command` | `{ name, value? }`: `play`, `pause`, `toggle`, `next`, `previous` (restart the song if more than 3 s in, else the one before), `seek` (seconds), `jump` (queue index), `stop` (stop and empty the queue: signing out, changing server), `repeat` (`'off' \| 'all' \| 'one'`), `volume` (0–1, the player's own) | — |
| `audio.current` | — | `{ tracks, index, state }` of what the app is playing, or `null`. The page asks after it reloads, shows that, and never loads over it |
| `audio.liked` | `{ id, liked }`: a song liked or unliked on the page. The app keeps it with the song (for `audio.current`) and, on Android, fills or empties the lock screen's heart | — |
| `audio.outputs` | `{ x, y, width, height }`, the page's button: show the system's list of speakers and headphones (iPhone: the AirPlay/Bluetooth picker, pointing at the button on iPad; Android: the output switcher). Only with the `outputs` feature | — |
| `changeServer` | — | — |
| `keepAwake` | `{ on }` (TVs: keep the screen on) | — |
| `mobileData` | — | `true` on mobile data |
| `tunnel.status` / `tunnel.save` `{config}` / `tunnel.remove` | | as in Netfish: `{configured, active, problem}` / `""` or what's wrong / — |
| `update.check` / `update.install` | | `{current, latest, available, canInstall, page}` / — |

A `NativeTrack` is `{ id, url, title, artist, album, artwork?, duration, liked? }`. `url` and `artwork` are
absolute and carry `?k=<media key>`: fetch them directly, no cookie needed. Streams answer range
requests. Covers are PNG/JPEG.

## App → page

Call `window.__tuna(message)` (Android `evaluateJavascript`, Apple `evaluateJavaScript`,
WebView2 `ExecuteScriptAsync` or `PostWebMessageAsJson` — the page listens to both on Windows):

- `{ "type": "reply", "id": 7, "value": …, "error"?: string }` (`error` when the command failed)
- `{ "type": "audio", "state": NativeAudioState }` — **on every change** (track, play/pause,
  buffering, seek, repeat, error, end) **and about once a second while playing**:
  `{ index, playing, buffering?, time, duration, ended?, error?, repeat?, output? }`. `index` is into the
  queue as last loaded/updated. `ended`: the whole queue has played (repeat off). `output`: where
  the sound comes out, `{ name, kind }` with kind `phone`, `headphones`, `bluetooth`, `airplay`, `car`,
  `tv` or `speaker` (apps with `outputs`; sent again when it changes).
- `{ "type": "event", "name": string, "value": … }`: `update` while installing (`{received, total}`,
  `{done: true}` or `{error}`; Settings shows progress and errors), `tunnel` changes, and `liked`
  (`{id, liked}`): the lock screen's heart on Android. The app has told the server already (`POST
  /api/like` with the page's cookie); the page only shows it. Likes made while the window was out
  of sight arrive when it's back.

The system's Back (Android's button, TV remotes): call `window.tunaBack()`. It closes whatever is
open on top or goes back a page, and returns `false` on Home with nothing open (then the app can
leave).

## Downloads (feature `downloads`)

Albums, playlists, Liked songs and single songs kept on the device, as in Netfish: they play with no
connection at all. Android (phones and tablets, not TVs), iPhone/iPad, Mac and Windows.

Page → app:

| cmd | args | reply |
|---|---|---|
| `downloads.add` | `{ id, kind, title, subtitle?, cover?, tracks: NativeTrack[] }` (`NativeDownload` without `ready`, `bytes`, `state`). Keep it and download every song's `url` (and its `artwork`, and `cover`) that isn't on the device yet, one at a time, carrying on in the background as far as the system allows. Adding an `id` that's already there replaces its songs (a playlist that changed): new ones download, and files no download needs any more are deleted. | — |
| `downloads.remove` | `{ id }`: forget it, stop what's in progress for it, delete files no other download needs | — |
| `downloads.clear` | — everything | — |
| `downloads.list` | — | `NativeDownload[]`, newest first |
| `downloads.offline` | — the page can't reach the server: open the offline page | — |
| `server.reachable` | — (offline page) does `GET {server}/api/health` answer now (through the tunnel when there is one) | `true` / `false` |
| `server.open` | — (offline page) load the server's page again | — |

App → page: `{ type: "event", name: "downloads", value: NativeDownload[] }` on every change, at most
about twice a second while downloading.

- **Playing**: whenever `audio.load` or `audio.update` has a song (by `id`) that's on the device,
  play the file instead of `url`, online too (it saves data). Offline, a song that isn't on the
  device is reported as an `error` and skipped.
- **Plays**: a download's song addresses end in `&dl=1`, so fetching them isn't counted as playing
  them; the page tells the server (`POST /api/me/played`) when half of a song played from the
  device has been heard. Unfinished downloads are added again when the page loads, with the
  session's current media key.
- **Keeping**: in the app's own storage (not the user's files), surviving updates. A JSON manifest
  of the downloads (as given, plus which songs are ready and their files); files named by song id.
  A download that fails (a song the server didn't give, even briefly, as during a restart) keeps
  `state: "failed"` and tries again the next time it's added (the page adds unfinished ones again
  each time it loads) or the app starts with the server reachable.
- **Offline page**: `apps/common/offline.html`, copied into each app like `loading.html` and served
  from the app's own address (iPhone and Mac: the local scheme; Android: a `WebViewAssetLoader` or
  `shouldInterceptRequest` address; Windows: a virtual host), with the same bridge and a
  `tunaHello` whose features are `audio` and `downloads`. Each `NativeDownload` also has
  `localCover`, an address on that origin serving its cover (sent to the server's page too, where
  it isn't used). The app opens it when the server
  doesn't answer at start (after the loading page has tried, tunnel included) and something is
  downloaded, and on `downloads.offline`.

## The player

- A real queue: Android Media3 ExoPlayer playlist in a `MediaSessionService` (foreground service,
  notification, lock screen, Bluetooth, Android Auto for free); iPhone `AVQueuePlayer` with the
  `audio` background mode, `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`; Mac
  `AVQueuePlayer` + `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` (media keys, Control Centre);
  Windows `Windows.Media.Playback.MediaPlayer` + `MediaPlaybackList` (the system media overlay and
  media keys come with it).
- The next song is loaded ahead so songs follow each other without a gap.
- Repeat `one` repeats the song; `all` goes back to the start after the last one.
- A song that fails: report `error`, then go on to the next one.
- Interruptions (a call, another app's audio): pause, and resume if the system says to.
- Artwork for the lock screen/notification: `track.artwork`.
- Closing the window (Mac/Windows) or leaving the app (phones) doesn't stop the music; quitting does.

## What else the apps share with Netfish

- Server address handling, the setup and loading pages, updates from GitHub releases
  (`ravifrancesco/tuna`), and the WireGuard tunnel (`apps/common/tunnel`, built as `tuna-tunnel`),
  all work as in Netfish (`../Netfish/apps/*`).
- App ids: Android `app.tuna.music` (debug build `app.tuna.music.debug`), Apple `app.tuna.music`,
  Windows "Tuna". Icons: `apps/common/icon.png` (rounded, with margin), `icon-ios.png` (full
  square), `tv-icon.png` and `banner.png` (TVs), all from `npm run art`.
- Builds happen outside iCloud Drive (`~/Library/Caches/tuna-build/…`), as Netfish's do.

## Trying it

`npm run dev:mock` runs fake Navidrome/Lidarr/MusicBrainz on :7701, the Tuna server on **:7778**
and the interface on :5174. Sign in as demo/demo. From the Android emulator the server is
`http://10.0.2.2:7778`; from the iOS Simulator, `http://localhost:7778`.

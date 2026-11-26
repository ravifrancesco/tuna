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
  features: ['audio', 'changeServer', 'keepAwake', 'mobileData', 'outputs', 'tunnel', 'update',
             'downloads', 'sleep', 'haptics', 'cast'],
}
```

- `sleep`: the app keeps the sleep timer itself (`audio.sleep`), so it stops the music with the
  screen off. Without it the page keeps the timer (the browser, TVs).
- `haptics`: `app.haptic` gives a short vibration (swiping a song). Phones only.
- `cast`: the `outputs` picker also lists Chromecasts, and the music can play on one (Android).
- `eq`: the app's player has the equalizer (`audio.eq`).

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
| `audio.outputs` | `{ x, y, width, height }`, the page's button: show the system's list of speakers and headphones (iPhone and Mac: the AirPlay/Bluetooth picker, pointing at the button on iPad; Android: the output switcher, with Chromecasts when there's `cast`). Only with the `outputs` feature | — |
| `audio.sleep` | `{ minutes }` (stop that many minutes from now) or `{ endOfSong: true }` (stop when the song playing ends); `{}` turns it off. When it's time: pause (don't empty the queue) and forget the timer; with `endOfSong`, move on to the next song paused at its start, so play carries on from there (or end as usual if it was the last). A new `audio.load` keeps it; `stop` clears it. Report it in every state as `sleep`. Only with `sleep` | — |
| `audio.eq` | `{ on: boolean, gains: number[] }`: the equalizer. `gains` are six levels in dB (−12 to +12) for 60 Hz, 150 Hz, 400 Hz, 1 kHz, 2.4 kHz and 15 kHz: a low shelf at 60 Hz, a high shelf at 15 kHz, peaks (Q ≈ 1) between, all as Web Audio's (a shelf has half its gain at its frequency), and the whole lowered by the highest boost (neighbouring boosts together can still add a few dB, which the app saturates rather than wraps). iPhone and Mac: AVPlayer leaves about a quarter of a second of silence after a song with a processing tap, so songs get taps only while it's on (off, they follow each other without a gap). Applies at once (no gap) to everything the app plays (streams, the queue kept ahead, downloads; not on a Chromecast), and the app keeps the last one given, across restarts, so music started without the page (the car, the lock screen) sounds the same. The page sends it when it loads and whenever it changes. Only with `eq` | — |
| `app.haptic` | `{ style: 'light' \| 'success' }`: a short vibration as the page confirms something (a song swiped into the queue or liked). Only with `haptics` | — |
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
  `{ index, id, playing, buffering?, time, duration, ended?, error?, repeat?, output?, local?, sleep? }`.
  `index` is into the queue as last loaded/updated; `id` is that song's, so the page notices a queue
  set from elsewhere (Android Auto, the car) and asks `audio.current` for it. `ended`: the whole queue has played (repeat
  off). `output`: where the sound comes out, `{ name, kind }` with kind `phone`, `headphones`,
  `bluetooth`, `airplay`, `cast`, `car`, `tv` or `speaker` (apps with `outputs`; sent again when it
  changes). `local`: the song playing comes from a file on the device (a download, or the queue
  kept ahead, below), so the server never sees it played; the page counts the play. `sleep`: the
  sleep timer, `{ at /* ms since 1970 */ }` or `{ endOfSong: true }`, absent when off.
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
  device (`local`, or downloaded) has been heard. If the player had streamed half of that song
  already (loading it ahead before its copy took over), the server counts it once. Unfinished downloads are added again when the page loads, with the
  session's current media key.
- **Keeping**: in the app's own storage (not the user's files), surviving updates. A JSON manifest
  of the downloads (as given, plus which songs are ready and their files); files named by song id.
  A download that fails (a song the server didn't give, even briefly, as during a restart) keeps
  `state: "failed"` and tries again the next time it's added (the page adds unfinished ones again
  each time it loads) or the app starts with the server reachable.
- **Offline page**: `apps/common/offline.html`, copied into each app like `loading.html` and served
  from the app's own address (iPhone and Mac: the local scheme; Android: a `WebViewAssetLoader` or
  `shouldInterceptRequest` address; Windows: a virtual host), with the same bridge and a
  `tunaHello` whose features are `audio`, `downloads` and, where the app has it, `eq`. Each `NativeDownload` also has
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
- The next song is loaded ahead so songs follow each other without a gap (gapless: no silence
  between the songs of a live album or a mix).
- **The queue kept ahead**: the next 5 songs (on Wi-Fi and mobile data alike: the sound quality is the
  person's choice) are fetched in full into a cache in the app's own storage, at the queue's `url`
  with `&dl=1` added (fetching them isn't counted as playing them), and played from the file once there, so the music carries on through a dropped
  connection, a switch between home and the tunnel, or a server restart. One at a time, after the
  song playing has loaded; at most about 500 MB, oldest first; a song that's downloaded
  (`downloads`) is never fetched again. While a song plays from a file (cache or download), report
  `local: true`. Copies are kept by their address without `k`, so they follow the sound quality: when
  it changes, the page sends the queue again with new addresses, and the app fetches those songs
  again in the new quality and deletes their copies in the old one (the song playing carries on).
- **Casting** (`cast`, Android): pick a Chromecast in the outputs picker and the queue moves to it
  (Media3's `CastPlayer`, the Default Media Receiver), from where it is; the notification and lock
  screen control it. The Chromecast fetches the songs' `url` itself, so it works with a server
  address it can reach (at home), not through the tunnel. `output` is `{ name, kind: 'cast' }`.
- Repeat `one` repeats the song; `all` goes back to the start after the last one.
- A song that fails: report `error`, then go on to the next one.
- Interruptions (a call, another app's audio): pause, and resume if the system says to.
- Artwork for the lock screen/notification: `track.artwork`.
- Closing the window (Mac/Windows) or leaving the app (phones) doesn't stop the music; quitting does.

## Android Auto (Android phones)

The app is a media app in the car: Media3's `MediaLibraryService`, with
`com.google.android.gms.car.application` → `automotive_app_desc` (`<uses name="media"/>`) in the
manifest. The browse tree, read from the server with the web view's cookies
(`CookieManager.getInstance().getCookie(server)`), first level:

- **Home**: the mixes in `GET /api/home` (rows of `kind: 'mixes'`; each mix plays `GET /api/mix/{id}`).
- **Playlists**: `GET /api/playlists`; one plays `GET /api/playlist/{id}` (its `tracks`).
- **Liked songs**: `GET /api/liked`.
- **Downloads**: what's on the device (plays with no connection).

Songs from the server become the queue as the page's would: `url` =
`{server}/api/stream/{id}?f={format}&br={bitRate}&k={mediaKey}` and `artwork` =
`{server}/api/cover/{cover}?s=600&k={mediaKey}`, with `mediaKey` and the person's sound quality
from `GET /api/me` (`mediaKey`, `prefs.quality`): `original` (or `auto` on Wi-Fi) plays the file as
it is (`f=raw`) when its format is one the player plays (`suffix`), else Opus at 256 kbps; `high`
Opus 256, `normal` Opus 160 (and `auto` on mobile data), `low` Opus 96. The page shows whatever the
car started (`audio.current`, and the states it sends).

## What else the apps share with Netfish

- Server address handling, the setup and loading pages, updates from GitHub releases
  (`ravifrancesco/tuna`), and the WireGuard tunnel (`apps/common/tunnel`, built as `tuna-tunnel`),
  all work as in Netfish (`../Netfish/apps/*`).
  - iPhone and iPad (iOS 17 and later): the tunnel is built into the app as a library
    (`apps/ios/tunnel/build.sh`). The page, downloads and the queue kept ahead go through its proxy;
    AVPlayer can't use a proxy, so songs and the lock screen's artwork go through its forwarding
    address, `http://127.0.0.1:<port>/through/<host:port>/<path>`. Away from home, downloads carry on
    only while Tuna is running (playing music keeps it running).
- App ids: Android `app.tuna.music` (debug build `app.tuna.music.debug`), Apple `app.tuna.music`,
  Windows "Tuna". Icons: `apps/common/icon.png` (rounded, with margin), `icon-ios.png` (full
  square), `tv-icon.png` and `banner.png` (TVs), all from `npm run art`.
- Builds happen outside iCloud Drive (`~/Library/Caches/tuna-build/…`), as Netfish's do.

## Trying it

`npm run dev:mock` runs fake Navidrome/Lidarr/MusicBrainz on :7701, the Tuna server on **:7778**
and the interface on :5174. Sign in as demo/demo. From the Android emulator the server is
`http://10.0.2.2:7778`; from the iOS Simulator, `http://localhost:7778`.

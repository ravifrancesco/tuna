# Tuna

Notes for anyone (person or AI assistant) working on Tuna's code.

## What it is

- A Spotify-style front end for a home music stack: **Navidrome** (the library, the music, the
  accounts) and **Lidarr** (getting albums, through the household's Prowlarr and qBittorrent), plus
  MusicBrainz, the Cover Art Archive, LRCLIB, ListenBrainz and Last.fm. The sister of Netfish
  (`../Netfish`), built the same way.
- Tuna is its own container: port **7778**, image `ghcr.io/ravifrancesco/tuna`, MIT licence.
- **Tuna never changes how the other services are set up.** It only talks to their APIs.
  Navidrome is a hidden engine for music and sign-in; nobody needs to open it. (Get does add an
  artist and watch one album in Lidarr: that's using Lidarr, not configuring it.)
- Every app is a thin shell around the server's web UI, **but the app owns the play queue**, so
  music keeps playing with the screen off. The contract is [docs/native-bridge.md](docs/native-bridge.md).
  - **Mac:** Swift/AppKit, AVFoundation, WKWebView.
  - **Windows:** C# WinForms, WebView2, Windows.Media.Playback.
  - **iPhone/iPad:** Swift, AVQueuePlayer, WKWebView.
  - **Android, Fire TV, Android TV:** one Java app, Media3 ExoPlayer in a MediaSessionService, WebView.
  - **Samsung TV:** a Tizen starter page that loads the web UI; the page plays the music itself.
- English and Italian everywhere. Italian uses the informal "tu"; terms in [docs/i18n-glossary.md](docs/i18n-glossary.md).

## Layout

| Folder | What's there |
|---|---|
| `server/` | Fastify + TypeScript. Routes in `server/src/routes.ts`, logic in `server/src/services/`, clients in `server/src/clients/` (`navidrome.ts`, `lidarr.ts`, `public.ts` for the public services), sign-in in `server/src/sessions.ts`, the readable log in `server/src/lib/log.ts` |
| `web/` | The React web UI, used by the browser and inside every app. The player is `web/src/lib/player.ts`, the bridge to the apps `web/src/lib/native.ts` |
| `shared/` | Types shared by server, web and (as JSON) the apps (`shared/src/index.ts`) |
| `apps/{mac,windows,ios,android,tizen,common}` | The native shells. `apps/common` has the loading page, the mark, the icons (`npm run art`) and netfish-tunnel's code (built as `tuna-tunnel`; built into the iPhone app by `apps/ios/tunnel/build.sh`, iOS 17+) |
| `server/dev/mock.ts` | Fake Navidrome, Lidarr, slskd, MusicBrainz, Cover Art Archive, LRCLIB, ListenBrainz and Last.fm on port 7701 |
| `scripts/` | Builds, icons, the translation check and the release script |
| `release/` | Build output only (not committed) |

## How things work

- **Sign-in:** Navidrome's `/auth/login`; Tuna keeps the Subsonic token it returns (never the
  password) per device in `sessions.json`. Browsers get an HttpOnly cookie; the apps send the
  session as a Bearer token. Each session has a **media key** that opens only `/api/stream`,
  `/api/cover` and `/api/art`, so the apps' players and lock screens can fetch without cookies.
- **Plays are counted on the server**, in the stream proxy: "now playing" when a song starts, a
  play (Navidrome scrobble, and ListenBrainz if linked) once half of it has been sent. So every
  player counts, including the apps' with the page asleep.
- **Get** (`server/src/services/getting.ts`): add the artist to Lidarr watching nothing, watch the
  one album, AlbumSearch; follow Lidarr's queue until all its tracks are files; remember who asked.
- **"In your library"** for music from MusicBrainz: matched by MusicBrainz id, else by normalised
  artist + title (`libraryIndex`, one per server, 10 minutes).
- **Waveforms** (`server/src/services/waveform.ts`): ffmpeg reads a song once as it starts playing and
  keeps 800 loudness bars in `cache/waves`; Now Playing draws them as its seek bar (`web/src/components/Waveform.tsx`).
  Raise `VERSION` there when the measuring changes. ffmpeg is in the Docker image; developing needs it too (`brew install ffmpeg`).
- **Mixes** are made when played (`server/src/services/mixes.ts`): Navidrome's similar songs when
  it has an outside source, else same artist and genre.
- **Covers** are kept on Tuna's disk (`server/src/lib/imageCache.ts`, `cache/images`, `IMAGE_CACHE_MB`)
  and by browsers and apps for good (a cover's id changes with its picture). Every album's cover is
  made ready ahead at the sizes cards and lists use (`server/src/services/covers.ts`). The page keeps
  what Home, the library and recent pages showed on the device, per person (`web/src/lib/keep.ts`),
  so it opens on them at once.

## Conventions

- **Text:** every string the user sees goes through `t()` / `tn()` (keyed by the English text),
  with the Italian in `web/src/i18n/it/*.ts` (server: `server/src/lib/i18n.ts`). `npm run
  check:i18n` lists anything missing. Plain, short sentences; no jargon.
- **Explanations only in Settings.** Cards, pages, buttons and tooltips state facts ("On its way ·
  40%", "In your library"), never how things work. Settings may explain.
- **The log is for people:** one readable line per event, in the household's time zone. Never
  write tokens, keys or passwords to it. `LOG_LEVEL` sets how much is written.
- Keep things minimal. Match the surrounding code's style and comment density.
- Commit messages: "Tuna X.Y.Z" followed by short bullets. No "#N" issue references.

## Developing

- Node 22 or later. `npm install` at the root (npm workspaces).
- Go (`brew install go`) for the Android, Mac, Windows and iPhone builds: each builds the tunnel for itself.
- `npm run dev:mock` runs the mock services (:7701), the server against them (:7778) and the web
  dev server (:5174). Mock users: demo/demo, sam/sam, admin/admin. Lidarr's fake downloads take
  `MOCK_GET_SECONDS` (40); `MOCK_EMPTY_LIBRARY=1` starts with nothing in the library, as a new install.
  The fake slskd: `MOCK_SLSKD_EMPTY=1` (every search finds nothing), `MOCK_SLSKD_FAIL=<peer>` (that
  peer's downloads fail), `MOCK_SLSKD_MOVE_SECONDS` (2: how long a finished download takes to reach
  slskd's downloads folder, as in slskd), `MOCK_SLSKD_REFUSE=<peer,…>` (they refuse to send),
  `MOCK_SLSKD_STUCK=<peer,…>` (their queues never move). `MOCK_LIDARR_LOOKUP_FAIL=<word,…>` makes Lidarr's
  search fail for names with those words, as its metadata server does for some. `MOCK_MB_CROWDED=<word,…>`
  makes songs with those words famous in MusicBrainz (150 compilation and live recordings before the
  album's, and a greatest hits Lidarr doesn't keep). `MOCK_COVER_MS` makes each cover that slow, as Navidrome
  on a Raspberry Pi. ListenBrainz token for Settings: `mock-lb`.
- `npm run typecheck` checks server and web; `npm run check:i18n` the Italian.
- **Develop against the mock**, never against a real household's server.
- A running server serves the web files from `web/dist` as they are: `npm run build -w web` to
  refresh what the apps load from :7778.
- Gradle and .NET builds don't work inside iCloud Drive folders; the build scripts copy the
  sources to `~/Library/Caches/tuna-build` first.

## Releasing

1. Raise the version in the four `package.json` files and `package-lock.json`, `apps/android/app/build.gradle`,
   the iOS project (`apps/ios/project.yml` and the Xcode project), `apps/windows` (csproj), and the image tag in `README.md`.
2. Add `## X.Y.Z (date)` to `CHANGELOG.md`.
3. Commit "Tuna X.Y.Z", push `main`.
4. `scripts/release.sh` builds every app, tags `vX.Y.Z` and uploads 7 files. The tag makes GitHub
   Actions build the Docker image. Then it writes `apps/ios/sidestore.json` (SideStore's source for
   the iPhone app, pointing at the new `.ipa`) and pushes it to `main`.

## Keeping this file current

Update it when something here stops being true: a new folder, a new convention, a changed release step.

# Tuna

**Your music at home, like Spotify.** Tuna is a music app for a home server: your own library from
**Navidrome**, anything else in the world one tap away through **Lidarr**, mixes made for each
person, synced lyrics, and apps for every screen. It's the sister of
[Netfish](https://github.com/ravifrancesco/netfish), which does the same for films and shows.

- **Home** that knows you: where you left off, Daily Mixes around what you play, what's new.
- **Search everything**: your library first, then all the music that exists (MusicBrainz).
  Albums you don't have get a **Get** button: Lidarr finds them through Prowlarr, qBittorrent
  downloads them, and they're in your library a few minutes later.
- **Artists** with their popular songs, every album, what you're missing, and similar artists.
- **Radio** from any song, album or artist; liked songs, playlists, shuffle and repeat.
- **Lyrics** that follow the song (from the file, or LRCLIB).
- **Discover** with ListenBrainz: suggestions from what you listen to, with Get.
- **Everyone has their own** likes, playlists, mixes and history.
- **Apps** for Mac, Windows, iPhone and iPad, Android, Android TV and Fire TV, and Samsung TVs.
  The apps play the music themselves, so it keeps going with the screen off and the lock screen,
  headphones and keyboard media keys all work.
- English and Italian.

## What you need

- A home server that runs Docker (a mini PC, a NAS, a Raspberry Pi 4 or 5).
- **Navidrome** with your music folder. Tuna plays from it and uses its accounts.
- **Lidarr** (optional) for Get, connected to your Prowlarr and qBittorrent.

`docker-compose.yml` has all three; drop Navidrome or Lidarr if you already run them.

## Install the server

In Portainer: **Stacks → Add stack**, paste [`docker-compose.yml`](docker-compose.yml), set
`DATA_BASE_PATH` to your data folder (music goes in `media/music`), **Deploy**. Open
`http://<your-server>:7778`: Tuna asks for Navidrome's address (and Lidarr's), with the setup code
from its log. Then sign in with your Navidrome account. More in [docs/install/server.md](docs/install/server.md).

Image: `ghcr.io/ravifrancesco/tuna:0.1.0` (amd64 and arm64).

## The apps

From the [latest release](https://github.com/ravifrancesco/tuna/releases/latest): Tuna-mac.dmg,
Tuna-windows.exe, Tuna-android.apk (phones, tablets, Android TV, Fire TV), Tuna-samsung.wgt and
Tuna-ios.ipa. Each asks for your server's address once.

## Developing

See [CLAUDE.md](CLAUDE.md). In short: Node 22, `npm install`, `npm run dev:mock` (fake Navidrome,
Lidarr and friends; sign in as demo/demo), and the interface is on http://localhost:5174.

MIT licence.

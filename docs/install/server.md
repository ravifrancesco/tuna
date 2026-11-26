# Installing the Tuna server

Tuna runs in Docker next to Navidrome and Lidarr. These steps use Portainer; plain
`docker compose up -d` with the same file works too.

## 1. The stack

Portainer → **Stacks → Add stack** → name it `tuna` → paste [`docker-compose.yml`](../../docker-compose.yml).

- `DATA_BASE_PATH`: the data folder Sonarr, Radarr and qBittorrent already use (mounted as `/data`).
  Music goes in its `media/music` folder.
- Before deploying, create `media/music` in the data folder and `/docker-data-volumes/navidrome-data`,
  both owned by user 1000. Navidrome runs as that user and can't fix the owner itself, unlike Lidarr:

  ```bash
  sudo mkdir -p /docker-data-volumes/navidrome-data <data folder>/media/music
  sudo chown 1000:1000 /docker-data-volumes/navidrome-data <data folder>/media/music
  ```
- Already running Navidrome or Lidarr? Delete that service from the file.

**Deploy the stack.**

## 2. Navidrome

Open `http://<your-server>:4533` and create the first account: it's the admin, and it's the one you'll
sign in to Tuna with. Navidrome scans the music folder by itself.

## 3. Lidarr (for Get)

Open `http://<your-server>:8686`:

1. **Settings → Media Management → Root Folders**: add `/data/media/music`.
2. **Settings → Media Management → Rename Tracks**: on, so albums land as `Artist/Album (Year)/01 - Title`.
3. **Settings → Metadata → Tag Audio Files with Metadata**: **For new downloads only**. Navidrome builds
   your library from the tags inside the files, and Tuna uses their MusicBrainz IDs.
4. **Settings → Download Clients**: add your qBittorrent (category `lidarr`).
5. In **Prowlarr → Settings → Apps**, add Lidarr (`http://<your-server>:8686`, with Lidarr's API key)
   so it gets your indexers.
6. Copy Lidarr's API key from **Settings → General → Security**.

## 4. Tuna

Open `http://<your-server>:7778`. The first time it asks for:

- the **setup code**: Portainer → Containers → Tuna → **Logs**;
- **Navidrome's address**, e.g. `http://<your-server>:4533`;
- **Lidarr's address and API key** (optional; you can add them later in Settings → Connections).

Sign in with your Navidrome account. Add the rest of the household in **Settings → Household**.

## Optional

- **Last.fm API key** (free at last.fm/api) in Settings → Connections: similar artists you don't have yet.
- **ListenBrainz**: each person links their own account in Settings for Discover.
- **slskd** (Soulseek), for single songs instead of whole albums: a playlist's missing songs, Get all
  after a Spotify import, and new songs for each person every Monday in their Fresh catch. Add its
  address and API key (slskd's `web.authentication.api_keys`, the same kind Tubifarry uses) in
  Settings → Connections. Lidarr files each song into its album, so slskd's downloads folder must
  be visible to Lidarr at the same path, or through a remote path mapping in Lidarr for slskd's
  host (as Tubifarry needs too). The number of new songs a week is in Settings → Weekly picks.
  **Songs from Soulseek**, under slskd's address, chooses which copies it gets: lossless up to CD
  quality (the default: no hi-res files of 100 MB or more a song), any lossless, or MP3 320. Sharing
  a folder in slskd (your music, read-only) means fewer people refuse to send you files.

## Updating

Portainer → Stacks → tuna → **Pull and redeploy**.

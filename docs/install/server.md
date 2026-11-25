# Installing the Tuna server

Tuna runs in Docker next to Navidrome and Lidarr. These steps use Portainer; plain
`docker compose up -d` with the same file works too.

## 1. The stack

Portainer → **Stacks → Add stack** → name it `tuna` → paste [`docker-compose.yml`](../../docker-compose.yml).

- `MUSIC_DIR`: your music folder on the server (Navidrome reads it, Lidarr adds to it).
- `DOWNLOADS_DIR`: where qBittorrent puts finished downloads, so Lidarr can move them into the music folder.
- Already running Navidrome or Lidarr? Delete that service from the file.

**Deploy the stack.**

## 2. Navidrome

Open `http://<your-server>:4533` and create the first account: it's the admin, and it's the one you'll
sign in to Tuna with. Navidrome scans the music folder by itself.

## 3. Lidarr (for Get)

Open `http://<your-server>:8686`:

1. **Settings → Media Management → Root Folders**: add `/music`.
2. **Settings → Download Clients**: add your qBittorrent (category `lidarr`).
3. In **Prowlarr → Settings → Apps**, add Lidarr (`http://lidarr:8686` or the server's address, with
   Lidarr's API key) so it gets your indexers.
4. Copy Lidarr's API key from **Settings → General → Security**.

## 4. Tuna

Open `http://<your-server>:7778`. The first time it asks for:

- the **setup code**: Portainer → Containers → tuna → **Logs**;
- **Navidrome's address**, e.g. `http://<your-server>:4533`;
- **Lidarr's address and API key** (optional; you can add them later in Settings → Connections).

Sign in with your Navidrome account. Add the rest of the household in **Settings → Household**.

## Optional

- **Last.fm API key** (free at last.fm/api) in Settings → Connections: similar artists you don't have yet.
- **ListenBrainz**: each person links their own account in Settings for Discover.

## Updating

Portainer → Stacks → tuna → **Pull and redeploy**.

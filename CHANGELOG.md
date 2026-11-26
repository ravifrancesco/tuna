# Changelog

## 0.4.0 (2026-11-26)

**New**
- **Single songs**: with slskd connected (Settings → Connections), Tuna gets one song instead of its
  whole album. slskd finds it on Soulseek and downloads just that file, and Lidarr files it into
  its album and keeps track of it like everything else (the album stays unwatched).
  - Greyed songs in playlists and Liked songs, songs in search and each song on an album page have
    their own small Get; once the song is here, it turns into the round arrow that keeps it on the
    device (in the apps).
  - Get the missing songs and Get all ask for the songs themselves, most played first, four at a
    time. Without slskd, their albums, as before.
- **Songs you don't have, in search**: after the library's songs, songs from all music, each with Get.
- **New songs every Monday**: each person gets songs they don't have (ListenBrainz's suggestions and
  songs like the ones they play most), first in their Fresh catch, which is Home's big card while
  there are some. Songs nobody likes or adds to a playlist go the next week. An admin sets how many
  in Settings → Weekly picks.
- **Song radio finds new songs**: a few songs like it that aren't here join it as they arrive.

**Changed**
- **iPhone**: tapping a text box no longer zooms the page in (which pushed the tabs off the
  screen), and text on phones is sized as in Netfish.
- **On its way** shows songs too, with their progress; albums taken out of Lidarr leave it.
- The opening animation always ends on the logo, and the empty-list fish shows on coloured
  backgrounds.

To update: the server (pull the new image); the apps don't need updating. For single songs, add
slskd's address and API key in Settings → Connections; its downloads folder has to be visible to
Lidarr (docs/install/server.md).

## 0.3.1 (2026-11-26)

**New**
- **When songs went in**: drag a playlist's scrollbar (on phones, the handle that shows at the edge
  while it scrolls) and the month each song went in shows beside it. Playlists from Spotify keep
  Spotify's dates; likes from Spotify's library file have none.
- **The equalizer is a curve**: drag its points up or down, or pick a preset.
- **Get all can be stopped**: On its way shows how many albums are still to ask for, with Stop.

**Changed**
- **Loading**: the fish nibbles at the hook while Tuna starts, and bites once it's ready.
- **Get all** asks for a few albums at a time (five on their way at once, the next as one arrives),
  and carries on after a restart.
- **On its way**: albums that arrived show until your next visit.
- **Settings**: Language has its own section; Download quality sits with Sound quality and the
  equalizer.

**Fixed**
- Albums by several artists in Spotify's files ("Gorillaz;Black Thought") weren't found.
- Albums looked up while Lidarr or MusicBrainz was too busy to answer were called missing; they're
  looked up again later, and Couldn't find has Try again.

To update: the server (pull the new image) and the apps (the loading animation is in them).

## 0.3.0 (2026-11-26)

**New**
- **Equalizer**: six bands and presets (bass boost, vocals, rock, small speakers…), in the player's
  menu and in Settings. It's kept on each device, for every song, in the iPhone, Mac and Android
  apps and in a browser. Not on Windows yet, and not while casting. On iPhone and Mac, songs have
  a short pause between them while it's on.
- **Download quality**: Normal, High or Original for the songs you download on a device, in
  Settings. High is the default (about 8 MB a song instead of 30 MB in FLAC).
- **Get the missing songs**: on your playlists from Spotify and on Liked songs, one button asks for
  every album that's missing, in the playlist's order.
- **Couldn't find**: On its way lists the albums Tuna couldn't find when asked for them by name.

**Changed**
- **Liked songs from Spotify** are all there, in Spotify's order: songs not in the library yet show
  greyed where they belong and are liked by themselves as they arrive. Likes made in Tuna come first.
- **Get all** asks for every missing album (it stopped at 100), most played first, a few seconds
  apart so Lidarr and the indexers aren't flooded.
- Albums are found through Lidarr first, and without Spotify's extras: "Currents (Deluxe Edition)"
  or "Currents - Single" is looked for as "Currents".
- **The apps play ahead** five songs, on Wi-Fi and mobile data alike, in the sound quality you
  chose: when it changes, the songs kept ahead are fetched again.

**Fixed**
- Liked songs from Spotify showed only the songs already in the library.
- Some songs from Spotify playlists were never asked for (album names like "… (Deluxe Edition)").

To update: the server (pull the new image) and the apps.

## 0.2.0 (2026-11-26)

The first release on GitHub, with everything in 0.1.0 below.

**New**
- **Swipe on a song** (phones): right to add it to the queue, left to like it; hold for its menu.
- **The queue**: drag songs into a new order, swipe one away, or clear what's coming up.
- **Sleep timer**: stop after 15, 30, 45 or 60 minutes, or at the end of the song. The apps keep it
  themselves, so it works with the screen off.
- **The apps play ahead**: the next songs of the queue are kept on the device, so music carries on
  through a dropped connection or a switch to the tunnel; songs follow each other without a gap.
- **Blends**: one mix of what two people in the household play, on Home.
- **Your year in music**: on your profile, the year so far in a few cards, ending with your top songs.
- **Search**: recent searches, and only songs, artists, albums or playlists. What's in the library
  and what Lidarr can get show together in the same rows.
- **Albums you don't have** open a page with their songs and Get.
- **Playlists from Spotify** are there straight away: songs not in the library yet show greyed where
  they belong, and go in by themselves as they arrive. What you change in them stays.
- **Casting**: Chromecast from the Android app and from Chrome; AirPlay on iPhone and Mac.
- **Android Auto**: your mixes, playlists, liked songs and downloads in the car. Apps not from the
  Play Store show up there once Android Auto's developer settings allow unknown sources.
- **On its way** shows how many albums are coming, in the sidebar and on Home (phones).
- **Loading** shows the note-fish swimming, as Netfish's fish does.

**Changed**
- Search finds music through Lidarr (MusicBrainz only if Lidarr can't), and retries MusicBrainz when
  it's busy.
- New albums are in the library about a minute after Lidarr files them: Tuna asks Navidrome to scan.
- "On its way" has its own icon (the round arrow is for downloads on the device).

**Fixed**
- Search with an empty library ("Library not found or empty" from Navidrome).
- Search said nothing when it couldn't search beyond the library; now it says so and the log says why.

To update: the server (pull the new image) and the apps.

## 0.1.0 (2026-11-24)

The first version.

- **Home**: "Good evening" with your name and your profile at the top; recently
  played, Daily Mixes, Fresh catch (thirty songs new to you, every Monday) and a liked-songs mix,
  new in the library, on repeat, your playlists and artists, and Discover (ListenBrainz) with Get.
- **Your profile**: listening time, plays, top artists, songs and albums for the week, month, year
  or all time, and your listening history, from every play Tuna counts.
- **Search** your library, then everything that exists (MusicBrainz), with Get for what you don't have.
- **Get**: Lidarr finds and downloads an album; "On its way" shows how far it is. After a Spotify
  import, Get all asks for the missing albums at once, most played first.
- **Weekly picks** (admins choose how many albums a week): albums the household played elsewhere
  (ListenBrainz, Last.fm), new releases by the artists they play most, ListenBrainz suggestions and
  more by artists they play a lot, all through Get. Settings shows how much of what the household
  played in the last 30 days is in the library.
- **Play together**: from the player's menu, a room with what's playing; others join with its link
  or from Home, and anyone can play, pause, skip or seek for everyone, as Netfish's watch together.
- **Downloads** (the apps): albums, playlists, Liked songs and songs kept on the device and played
  from it, with a page of what's downloaded when the server can't be reached.
- **Albums, artists and playlists**: popular songs, every album, what you're missing, similar artists,
  liking, following, playlists you can make and change.
- **The look**: your playlists in a sidebar, and the player as a glass pill floating over the music in the colour of what's playing; Home opens with today's mix.
- **The player**: queue, shuffle, repeat, radio from any song, album or artist, synced lyrics
  (from the file or LRCLIB), and Now Playing with the song's waveform as its seek bar.
- **Sound quality**: Automatic, Low, Normal, High or Original, from the player or Settings.
- **Settings**, laid out as Netfish's: bring your playlists, liked songs, saved albums, followed
  artists and listening history over from Spotify (its "Download your data" ZIP, or Exportify's CSV
  files); ListenBrainz and Last.fm; away from home through WireGuard (the apps, as in Netfish);
  connections, the household's accounts, and measuring waveforms overnight.
- **Apps**: Mac, Windows, iPhone and iPad, Android (phones, tablets, Android TV, Fire TV) and Samsung TVs.
- **Starting**: the apps' loading page and the opening animation carry on into each other, as in
  Netfish, through the WireGuard tunnel too.
- **Phones**: Now Playing with the lyrics (or queue) on a card in the cover's colour, the controls kept
  above it, closed by pulling it down; the lock screen's player (with a heart on Android); and where it plays (AirPods,
  Bluetooth, AirPlay, a car), with the system's list of speakers and headphones a tap away.
- English and Italian.

To update: this is the first version. Install the server (README) and the apps you want.

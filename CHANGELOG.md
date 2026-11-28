# Changelog

## 0.5.3 (2026-11-27)

**New**
- **Albums show all their songs:** an album you have only some songs of shows the rest too, greyed
  where they belong, each with Get, and **Get the missing songs** for all of them. It says whether
  it's an album, an EP or a single as its sources do (not guessed from how many songs are here).
- **Songs Tuna filed itself go to Lidarr once it knows their album** (after you turn on Deezer in
  Lidarr, or singles and EPs): Lidarr files them into the album with its names, and its cover if it
  writes covers (Settings → Metadata → Kodi/Emby → Album Images). Every few hours, and right away
  with **Look again**.

**Changed**
- **Any source Lidarr knows albums from** (Deezer, Discogs… through Tubifarry's MetaMix) works in
  Tuna the same way: Tuna asks Lidarr for the artist and the cover rather than each source.

**Fixed**
- **Songs that had arrived still showed as not here** in playlists when the library names them a
  little differently: now the same artist's song with nearly the same title counts.

To update: the server (pull the new image). The apps need nothing new.

## 0.5.2 (2026-11-27)

**Changed**
- **Songs that aren't on an album Lidarr has** (singles and EPs its metadata profile leaves out, songs
  MusicBrainz doesn't know) are now got from Soulseek all the same, and go straight into the music
  folder, named and tagged as the playlist has them. Before, Tuna gave up on them without looking.
  This needs slskd's downloads folder inside the data folder Tuna has (the log says if it isn't).
- **One more search on Soulseek:** the song's title alone, as people search (a copy still needs the
  artist in its path).

**Fixed**
- **Long playlists scrolled slowly** (a big Liked songs with many songs not here yet): songs off
  screen are no longer laid out or drawn until they come near, songs not here yet are dimmed in a
  way that's quicker to draw, and only the song playing hears about play and pause.
- **The fish's tail was cut** in the opening away from home (iPhone and Mac): as it swung, its
  rounded edge was clipped. It now swings about its tip.

To update: the server (pull the new image), and the apps for the tail.

## 0.5.1 (2026-11-27)

**Fixed**
- **The apps used a lot of energy on playlists with songs on their way:** each of those songs asked
  the server where it was at by itself, every five seconds, for the whole list of what's on its way
  (on a playlist with 77 songs waiting, over 200 requests in 15 seconds, and every one of them
  spinning). Now one small look every five seconds covers every song on screen, and only what's
  moving is sent. Songs far down a long list now update too.

**Changed**
- **A dot instead of a spinning circle:** faint and still while a song waits its turn, glowing while
  it's looked for (a few at a time), then a little circle that fills up as it downloads. The button
  lines up with the ⋯ of the songs around it.

To update: the server (pull the new image). The apps need nothing new.

## 0.5.0 (2026-11-27)

**New**
- **Import your own files:** a song Get couldn't find, an album, or anything you have. On a song or
  album that wasn't found, its button now offers **Look again** or **Import files**; Your library
  has **Import files** for anything. Choose the files (on a computer, a whole folder) and a cover if
  you like (a folder's cover.jpg is used by itself). The files are sent, then shown with their names
  filled in, from the song or album asked for, what MusicBrainz knows (titles, track numbers, year)
  and their tags, for you to change: artist, album, year, and each song's number, title and artist.
  Then Lidarr files them into the album when it knows it, or Tuna puts them straight into the music
  folder. Files that don't play are turned away, and so are songs whose length is more than 10
  seconds off the album's, or that are in the library already, each with why.
- **Songs Soulseek seems not to have are looked for again in other ways:** some names (Kanye West's,
  for one) get no answer at all on Soulseek, so when the first search finds nothing that fits, Tuna
  searches by the title and the album, then by the title and one word of the artist's name.

**Changed**
- **Playlists show where each missing song is at:** the + with its circle going round while it's
  looked for, then a quiet + when it wasn't found.
- **The log says why a song wasn't found on Soulseek:** how many people answered and why none fit
  (without the title, without the artist, the wrong length).

**Fixed**
- Missing songs in playlists always showed **Get**, even while being looked for or after they
  weren't found.

To update: the server (pull the new image), and in Tuna's stack add the data folder as Lidarr has it,
`- ${DATA_BASE_PATH}:/data`, to its volumes (Importing files needs it; Settings → Connections says if
Tuna can't reach Lidarr's music folder). The apps: on a Mac a whole folder can be chosen, on Android
several files at once.

## 0.4.13 (2026-11-27)

**New**
- **Away from home, a new opening:** the tunnel hangs above the logo, the line running up into it.
  Once connected the fish bites, the logo is reeled up into the tunnel, the tunnel comes down below
  it, and the logo rises out of its top into place.

**Changed**
- **The next song is ready before it plays:** its cover, colours, waveform and lyrics are fetched
  while the song before plays, so the pill and Now Playing change all at once. Covers in lists fade
  in as they arrive.
- **Now Playing:** when there's no room for the device's name beside the whole sound quality, the
  device shows as its icon (its menu has the name).

**Fixed**
- **The apps used a lot of power while playing:** Now Playing's waveform was drawn 60 times a second
  (on a Mac, about a third of a core); now only when it changes. Fresh catch's cover moves for a
  while when it comes on screen, then rests.
- **"On its way"** counted songs as albums ("2638 more albums to ask for"); it now says how many
  songs and how many albums.
- **Phones:** long playlists showed two scroll bars.

To update: the server (pull the new image) and the apps (the new opening away from home).

## 0.4.12 (2026-11-27)

**Fixed**
- **Songs said "nobody on Soulseek has it" when plenty of people did** (Ultralight Beam, say). slskd
  says a search is done a moment before it has saved what came back, longer on a Raspberry Pi, and
  Tuna read it too soon. It now waits until everything is there.
- **Songs with several artists from Exportify** ("Kanye West, Chance the Rapper, …") were searched
  with all of them at once, and Soulseek found nothing. Now with the main artist.

**New**
- **Albums Lidarr knows from Deezer** (Tubifarry's Deezer metadata source, if you turn it on) can be
  got too, with their covers; MusicBrainz's version is still used when both have an album. Without
  it, nothing changes.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.11 (2026-11-27)

**Changed**
- **Songs found by their code.** Playlists brought in from Exportify carry each song's ISRC, and Tuna
  now looks songs and albums up by it first, so they're found whatever Spotify calls them. Spotify's
  own data export has no codes: bring playlists in again from Exportify, then Look again.
- **Names that differ a little still match:** spacing, punctuation, accents or a letter here and there
  ("De I Cani" is "dei cani"); a soundtrack is found under its composer; and an album the search
  doesn't find is looked for among the artist's own albums.
- **Soulseek:** when MusicBrainz names a song or its artist differently from Spotify, Tuna searches
  for both.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.10 (2026-11-26)

**Fixed**
- **Famous songs weren't found.** Tuna read only MusicBrainz's first 10 matches for a song, and for a
  famous one those are mostly compilations, live albums and DJ mixes, so it said "not in
  MusicBrainz". It now reads up to 300, until it finds the song on an album. A song a playlist lists
  on a greatest hits now comes from the album it's on (Lidarr doesn't keep greatest hits).
- **Automatic played Original on mobile data** on the iPhone, after the app came back from the
  background or when you left Wi-Fi with the screen off. The iPhone app now follows the network
  itself, and the page asks again as soon as it's opened.
- **Lyrics:** going back to a song showed its lyrics from where the other song had been; they now
  start at the top. They also keep time between the apps' once-a-second updates, and the next song's
  lyrics are ready before you skip.
- The sound quality badge in Now Playing stays on one line.

**New**
- **Settings → Couldn't find** (admins): how many songs and albums people asked for weren't found,
  and Look again, which looks for all of them once more.

To update: the server (pull the new image) and the iPhone app; the other apps don't need updating.

## 0.4.9 (2026-11-26)

**Fixed**
- **Songs got stuck.** When Lidarr couldn't look up a few songs ("Invalid response received from
  LidarrAPI"), Tuna tried those same songs every 10 seconds and never got to the rest of the list.
  Now such a song is looked up through MusicBrainz instead; if that fails too, it's tried again in 1,
  5 and 30 minutes and then shown as not found, and the songs behind it carry on.
- **Soulseek:** copies Tuna gave up on no longer stay in slskd's list as "Completed, Cancelled" (and
  ones earlier versions left there are cleared).

**Changed**
- **Soulseek:** someone who refuses to send a song isn't asked again for an hour, for any song, and
  Tuna asks each person for one song at a time when someone else has it too. Refusals no longer use
  up a song's tries, and the log says why each one came.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.8 (2026-11-26)

**Changed**
- **Covers show at once.** Every album's cover is made ready ahead, a minute after Tuna starts and
  then every 6 hours for new albums, so the first time a page shows them they no longer come in one
  by one. Browsers and the apps now keep covers for good instead of a week.
- **Pages open at once.** Each device keeps what Home, the library, playlists and the last albums and
  artists showed, for the person signed in, and opens on that while the server answers. Signing out
  removes it.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.7 (2026-11-26)

**New**
- **Songs from Soulseek** (Settings → Connections, under slskd): which copies of a song Tuna gets.
  **Lossless, CD quality** (the default now), **Lossless, hi-res too**, or **MP3 320**. Until now it
  took any lossless copy, so hi-res files of 100 MB or more a song came in. When nobody has the kind
  chosen, the nearest one comes instead.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.6 (2026-11-26)

**New**
- **Music on another of your devices** shows in the normal player, glowing, instead of a bar: play,
  pause, skip, seek and the heart act on that device, and the line along the player follows the
  song. Now Playing says where it's playing, has **Play here**, and shows what's next there.

**Fixed**
- **Single songs from Soulseek:** a song could be given up on just as it finished downloading
  ("Lidarr can't see slskd's downloads"), because Tuna took it off slskd's list a moment before slskd
  moved the file into its downloads folder. Tuna now waits until the file is there and Lidarr has
  filed it. Copies that fail or are refused no longer pile up in slskd's list.
- **Play here** after a seek on the other device carries on from where the song was, not from before
  the seek.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.5 (2026-11-26)

**New**
- **Away from home on iPhone and iPad**, as in the Android, Mac and Windows apps: Tuna reaches your
  server through WireGuard, built in and used only by Tuna, with no VPN to switch on. Set it up in
  Settings → **Away from home** with the device's WireGuard `.conf` file. Needs iOS 17 or later.
  - Pages, songs, the songs kept ahead and downloads all go through it. Away from home, downloads
    carry on while Tuna is running (playing music keeps it running).
  - Installing with Xcode now also needs Go (`brew install go`).

**Fixed**
- **Away from home:** the WireGuard `.conf` file couldn't be chosen on iPhone and iPad (it was
  greyed out). Any file can be chosen now, and Tuna says if it isn't a WireGuard file.

To update: the server (pull the new image) and the iPhone app.

## 0.4.4 (2026-11-26)

**Fixed**
- **Get all** after bringing in several files from Spotify at once (Exportify's CSV files) asked for
  only the 50 most played albums. It now asks for every missing song, each once, however many
  playlists it's in, and the count of songs not in the library no longer counts them twice.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.3 (2026-11-26)

**New**
- **Fresh catch has its own cover**: a school of fish swimming through space into a glowing nebula,
  on Home and on its page.

To update: the server (pull the new image); the apps don't need updating.

## 0.4.2 (2026-11-26)

**New**
- **Your devices, in sync** (as Spotify Connect): every Tuna you have open on your account (phone,
  computer, browser) sees what the others are playing.
  - While music plays on another one, a bar shows where and what, with pause and Play here.
  - The button by the sound quality in Now Playing lists your devices: pick one and the music moves
    there, carrying on where it was. Starting music on one pauses the others.
- **Autoplay**: when an album, a playlist or a radio is about to end, songs like the last few carry
  on, with a new song of the week now and then. On by default; each device can turn it off in
  Settings → Listening.

**Changed**
- **Fresh catch** is the week's new songs only (30 a week for each person by default; an admin can
  change it). What's in the library but not played yet has its own mix, **Not played yet**.
- **Song radio** is mostly new songs: it asks for songs like the one it started from as it plays,
  keeping six ready ahead, with songs from the library in between until they're here.
- Radios are 50 songs, as Spotify's (Autoplay carries on after).
- Fresh catch's page is called Fresh catch (it said "Mix").

To update: the server (pull the new image); the apps don't need updating.

## 0.4.1 (2026-11-26)

**Changed**
- **Loading**: while a page loads, the fish nibbles at the hook, as in the opening animation,
  instead of swimming.

To update: the server (pull the new image); the apps don't need updating.

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

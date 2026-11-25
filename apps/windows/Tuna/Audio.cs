using System.Net;
using System.Text.Json.Nodes;
using Windows.Media;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage.Streams;

namespace Tuna;

/// <summary>A song in the queue, as the page sends it (a NativeTrack).</summary>
sealed record Track(string Id, Uri? Url, string Title, string Artist, string Album, Uri? Artwork, double Duration)
{
    public static Track From(JsonNode? node)
    {
        static string Text(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
        static Uri? Link(JsonNode? n) => Uri.TryCreate(Text(n), UriKind.Absolute, out var u) && u.Scheme is "http" or "https" ? u : null;
        var duration = node?["duration"] is JsonValue d && d.TryGetValue<double>(out var seconds) ? seconds : 0;
        return new Track(Text(node?["id"]), Link(node?["url"]), Text(node?["title"]), Text(node?["artist"]), Text(node?["album"]), Link(node?["artwork"]), duration);
    }

    public bool Same(Track other) => Id == other.Id && Url == other.Url;
}

/// <summary>
/// The player: the queue lives here, not in the page, so the music carries on whatever the page
/// does (reloading, the setup page, a minimised window). Windows' own MediaPlayer plays it, which
/// brings the media overlay, the media keys and the lock screen. Its list only ever holds the song
/// that's playing and the one after it, loaded ahead so they follow each other without a gap; what
/// "after" means (the next song, the first again, the same again) is worked out here, so changing
/// the queue or repeat never touches the song that's playing.
/// </summary>
sealed class AudioPlayer : IDisposable
{
    /// <summary>A song in the player's list: the one playing, or the one after it.</summary>
    sealed class Slot(Track track, int index)
    {
        public readonly Track Track = track;
        /// <summary>Where it is in the queue (changes when the queue does).</summary>
        public int Index = index;
        public MediaPlaybackItem Item = null!;
        /// <summary>What it's read from, when the player doesn't fetch it itself: its download, or the tunnel.</summary>
        public Stream? Stream;
        /// <summary>Couldn't be loaded or played.</summary>
        public bool Failed;
        /// <summary>Its failure has been reported and dealt with.</summary>
        public bool Handled;
    }

    public static readonly string[] Formats = ["mp3", "aac", "m4a", "flac", "wav", "alac"];

    readonly MediaPlayer player = new();
    readonly Action<Action> ui;
    readonly DownloadStore downloads;
    readonly System.Windows.Forms.Timer ticker = new() { Interval = 1000 };
    readonly HttpClient direct = new() { Timeout = TimeSpan.FromSeconds(20) };
    /// <summary>Through the tunnel (away from home), while there is one.</summary>
    HttpClient? proxied;
    string? proxyUrl;
    readonly Dictionary<Uri, byte[]> covers = new();

    JsonArray sent = new();
    List<Track> tracks = new();
    int index = -1;
    string repeat = "off";
    MediaPlaybackList? list;
    Slot? current, next;
    /// <summary>Where to start the song once it has opened (a queue restored after a reload).</summary>
    double? pendingSeek;
    bool wantPlay, ended, stalled, disposed;
    /// <summary>Songs that failed in a row, so a queue where nothing plays doesn't go round forever.</summary>
    int failures;

    /// <summary>The state for the page (NativeAudioState), on every change and every second while playing.</summary>
    public event Action<JsonObject>? Changed;

    /// <param name="post">Runs an action on the window's thread, where everything here happens.</param>
    public AudioPlayer(Action<Action> post, DownloadStore downloads)
    {
        ui = action => post(() => Safely(action));
        this.downloads = downloads;
        player.AutoPlay = false;
        player.AudioCategory = MediaPlayerAudioCategory.Media;

        // The media overlay, the media keys and the lock screen: their buttons do what the page's do.
        var commands = player.CommandManager;
        commands.IsEnabled = true;
        commands.PlayReceived += (_, e) => { e.Handled = true; ui(Play); };
        commands.PauseReceived += (_, e) => { e.Handled = true; ui(Pause); };
        commands.NextReceived += (_, e) => { e.Handled = true; ui(Next); };
        commands.PreviousReceived += (_, e) => { e.Handled = true; ui(Previous); };
        commands.PositionReceived += (_, e) =>
        {
            e.Handled = true;
            var at = e.Position.TotalSeconds;
            ui(() => Seek(at));
        };
        commands.ShuffleBehavior.EnablingRule = MediaCommandEnablingRule.Never;
        commands.AutoRepeatModeBehavior.EnablingRule = MediaCommandEnablingRule.Never;
        commands.RewindBehavior.EnablingRule = MediaCommandEnablingRule.Never;
        commands.FastForwardBehavior.EnablingRule = MediaCommandEnablingRule.Never;
        UpdateButtons();

        // The player's events come on other threads: everything is done on the window's.
        player.MediaOpened += (_, _) => ui(Refresh);
        player.MediaEnded += (_, _) => ui(OnEnded);
        player.MediaFailed += (_, _) => ui(() =>
        {
            CatchUp();
            OnFailed(current?.Item);
        });
        var session = player.PlaybackSession;
        session.PlaybackStateChanged += (_, _) => ui(OnPlaybackState);
        session.NaturalDurationChanged += (_, _) => ui(Refresh);
        session.SeekCompleted += (_, _) => ui(Report);
        ticker.Tick += (_, _) => Safely(() =>
        {
            if (Playing) Report();
        });
        ticker.Start();
    }

    /// <summary>Music is playing (or about to): closing the window then keeps it going.</summary>
    public bool Playing => current != null && !ended && (wantPlay || player.PlaybackSession.PlaybackState == MediaPlaybackState.Playing);

    /// <summary>Away from home, songs and covers come through the tunnel's proxy (null: straight from the server).</summary>
    public void UseProxy(string? proxy)
    {
        if (proxy == proxyUrl) return;
        proxyUrl = proxy;
        // (The old one isn't disposed: a song may still be reading through it. It goes when nothing does.)
        proxied = proxy == null ? null : new HttpClient(new SocketsHttpHandler
        {
            Proxy = new WebProxy(proxy),
            UseProxy = true,
            ConnectTimeout = TimeSpan.FromSeconds(10),
        }) { Timeout = TimeSpan.FromSeconds(30) };
        if (list != null && current != null)
        {
            // The song after this one, the new way.
            if (next != null) Drop(next, now: true);
            next = null;
            FillNext();
        }
    }

    // ---------- What the page asks for ----------

    /// <summary>audio.load: a new queue, starting at <paramref name="at"/>.</summary>
    public void Load(JsonArray? items, int at, double start, bool play)
    {
        SetQueue(items);
        if (tracks.Count == 0)
        {
            Stop();
            return;
        }
        StartAt(Math.Clamp(at, 0, tracks.Count - 1), Math.Max(0, start), play);
    }

    /// <summary>audio.update: a new queue around the song that's playing, which carries on without a gap.</summary>
    public void Update(JsonArray? items, int at)
    {
        CatchUp();
        SetQueue(items);
        if (tracks.Count == 0)
        {
            Stop();
            return;
        }
        if (current == null || list == null)
        {
            index = Math.Clamp(at, 0, tracks.Count - 1);
            Report();
            return;
        }
        // Normally the playing song is at `at`. If it moved on to the next song while the page was
        // working this out, it's the one after that (or wherever it is in the new queue).
        current.Index = Find(current.Track, at);
        index = current.Index;
        FillNext();
        Report();
    }

    /// <summary>audio.command</summary>
    public void Command(string name, JsonNode? value)
    {
        double? number = value is JsonValue v && v.TryGetValue<double>(out var n) ? n : null;
        switch (name)
        {
            case "play": Play(); break;
            case "pause": Pause(); break;
            case "toggle":
                if (Playing) Pause();
                else Play();
                break;
            case "next": Next(); break;
            case "previous": Previous(); break;
            case "seek": if (number is { } at) Seek(at); break;
            case "jump": if (number is { } i) Jump((int)i); break;
            case "stop": Stop(); break;
            case "repeat":
                if (value is JsonValue r && r.TryGetValue<string>(out var mode) && mode is "off" or "all" or "one") Repeat(mode);
                break;
            case "volume":
                if (number is { } volume) player.Volume = Math.Clamp(volume, 0, 1);
                break;
        }
    }

    /// <summary>audio.current: what's playing, for a page that has just reloaded; null when nothing is.</summary>
    public JsonObject? Current()
    {
        CatchUp();
        if (current == null || tracks.Count == 0) return null;
        return new JsonObject { ["tracks"] = sent.DeepClone(), ["index"] = index, ["state"] = State() };
    }

    void Play()
    {
        CatchUp();
        if (current == null || ended)
        {
            // After the end (or a stop with a queue left): the song again, from the start.
            if (index >= 0 && index < tracks.Count) StartAt(index, 0, true);
            return;
        }
        wantPlay = true;
        player.Play();
        Report();
    }

    void Pause()
    {
        wantPlay = false;
        player.Pause();
        Report();
    }

    void Next()
    {
        CatchUp();
        if (current == null || list == null) return;
        var target = NextIndex(natural: false);
        if (target < 0) return;
        if (next is { Failed: false } ahead && ahead.Index == target && ReferenceEquals(list.CurrentItem, current.Item))
        {
            // Already loaded ahead.
            wantPlay = true;
            list.MoveNext();
            player.Play();
            CatchUp();
            Report();
        }
        else
        {
            StartAt(target, 0, true);
        }
    }

    /// <summary>More than 3 seconds in: the start of this song. Otherwise the one before.</summary>
    void Previous()
    {
        CatchUp();
        if (current == null) return;
        if ((!ended && player.PlaybackSession.Position.TotalSeconds > 3) || index <= 0) Seek(0);
        else StartAt(index - 1, 0, true);
    }

    void Jump(int i)
    {
        if (i >= 0 && i < tracks.Count) StartAt(i, 0, true);
    }

    void Seek(double seconds)
    {
        CatchUp();
        if (current == null) return;
        seconds = Math.Max(0, seconds);
        if (ended)
        {
            StartAt(index, seconds, false);
            return;
        }
        if (pendingSeek != null || !Opened()) pendingSeek = seconds;
        else player.PlaybackSession.Position = TimeSpan.FromSeconds(seconds);
        Report();
    }

    void Repeat(string mode)
    {
        repeat = mode;
        CatchUp();
        if (list != null && current != null && !ended) FillNext();
        UpdateButtons();
        Report();
    }

    public void Stop()
    {
        wantPlay = false;
        ended = false;
        stalled = false;
        pendingSeek = null;
        player.Pause();
        player.Source = null;
        if (current != null) Drop(current);
        if (next != null) Drop(next);
        current = next = null;
        list = null;
        tracks = new();
        sent = new();
        index = -1;
        UpdateButtons();
        Report();
    }

    // ---------- The list ----------

    void SetQueue(JsonArray? items)
    {
        sent = (JsonArray?)items?.DeepClone() ?? new JsonArray();
        tracks = sent.Select(Track.From).ToList();
    }

    /// <summary>Where a song is in the new queue: at <paramref name="at"/>, the one after, or anywhere.</summary>
    int Find(Track track, int at)
    {
        foreach (var i in new[] { at, at + 1 })
            if (i >= 0 && i < tracks.Count && tracks[i].Same(track)) return i;
        var found = tracks.FindIndex(t => t.Same(track));
        return found >= 0 ? found : Math.Clamp(at, 0, tracks.Count - 1);
    }

    /// <summary>
    /// The song after this one: when this one ends by itself (<paramref name="natural"/>: repeat one
    /// plays it again), or for the Next button. -1: none, the queue is over.
    /// </summary>
    int NextIndex(bool natural)
    {
        if (current == null || tracks.Count == 0) return -1;
        if (natural && repeat == "one") return index;
        if (index + 1 < tracks.Count) return index + 1;
        return repeat is "all" || (repeat == "one" && natural) ? 0 : -1;
    }

    /// <summary>A fresh list with this song, and the one after it loaded ahead.</summary>
    void StartAt(int i, double start, bool play)
    {
        var old = (current, next);
        list = new MediaPlaybackList { AutoRepeatEnabled = false, MaxPrefetchTime = TimeSpan.FromSeconds(30) };
        // A new song (it moved on by itself, or the first one is in): catch up, and say so.
        list.CurrentItemChanged += (sender, _) => ui(() =>
        {
            if (sender == list) Refresh();
        });
        list.ItemFailed += (sender, e) =>
        {
            var item = e.Item;
            ui(() =>
            {
                if (sender == list) OnFailed(item);
            });
        };
        index = i;
        current = NewSlot(i);
        next = null;
        list.Items.Add(current.Item);
        ended = false;
        stalled = false;
        wantPlay = play;
        pendingSeek = start > 0.5 ? start : null;
        FillNext();
        player.Source = list;
        if (play) player.Play();
        if (old.current != null) Drop(old.current);
        if (old.next != null) Drop(old.next);
        UpdateButtons();
        Report();
    }

    /// <summary>Makes sure the song loaded ahead is the right one for the queue and repeat as they are now.</summary>
    void FillNext()
    {
        if (list == null || current == null) return;
        var target = NextIndex(natural: true);
        if (next != null && target >= 0 && next.Track.Same(tracks[target]))
        {
            // Still the right song (maybe somewhere else in the queue now).
            next.Index = target;
        }
        else
        {
            if (next != null) Drop(next, now: true);
            next = null;
            if (target >= 0)
            {
                next = NewSlot(target);
                list.Items.Add(next.Item);
            }
        }
        UpdateButtons();
    }

    Slot NewSlot(int i)
    {
        var slot = new Slot(tracks[i], i);
        var track = slot.Track;
        MediaSource source;
        if (downloads.Open(track.Id) is { } local)
        {
            // Downloaded: the file, online too (it saves data).
            slot.Stream = local.File;
            source = MediaSource.CreateFromStream(local.File.AsRandomAccessStream(), local.Type);
        }
        else if (track.Url != null && proxied == null)
        {
            source = MediaSource.CreateFromUri(track.Url);
        }
        else
        {
            // Through the tunnel, the player's own downloads can't reach the server: the song is
            // read through the proxy here instead, when the player gets to it.
            var binder = new MediaBinder();
            var http = proxied;
            binder.Binding += (_, e) => Bind(slot, http, e);
            source = MediaSource.CreateFromMediaBinder(binder);
        }
        slot.Item = new MediaPlaybackItem(source);
        var display = slot.Item.GetDisplayProperties();
        display.Type = MediaPlaybackType.Music;
        display.MusicProperties.Title = track.Title;
        display.MusicProperties.Artist = track.Artist;
        display.MusicProperties.AlbumTitle = track.Album;
        slot.Item.ApplyDisplayProperties(display);
        if (track.Artwork != null) _ = Cover(slot.Item, track.Artwork);
        return slot;
    }

    static async void Bind(Slot slot, HttpClient? http, MediaBindingEventArgs e)
    {
        var deferral = e.GetDeferral();
        try
        {
            // No address or no way through: nothing is set, so the song fails and the next one plays.
            if (slot.Track.Url is { } url && http != null)
            {
                var stream = await HttpRangeStream.Open(http, url);
                slot.Stream = stream;
                e.SetStream(stream.AsRandomAccessStream(), stream.ContentType);
            }
        }
        catch
        {
        }
        finally
        {
            deferral.Complete();
        }
    }

    /// <summary>The cover, for the media overlay and the lock screen.</summary>
    async Task Cover(MediaPlaybackItem item, Uri url)
    {
        try
        {
            if (!covers.TryGetValue(url, out var bytes))
            {
                bytes = downloads.Image(url) is { } file ? await File.ReadAllBytesAsync(file) : await (proxied ?? direct).GetByteArrayAsync(url);
                if (covers.Count > 30) covers.Clear();
                covers[url] = bytes;
            }
            var stream = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(stream))
            {
                writer.WriteBytes(bytes);
                await writer.StoreAsync();
                writer.DetachStream();
            }
            stream.Seek(0);
            var display = item.GetDisplayProperties();
            display.Thumbnail = RandomAccessStreamReference.CreateFromStream(stream);
            item.ApplyDisplayProperties(display);
        }
        catch
        {
            // No cover, then.
        }
    }

    /// <summary>
    /// A song that's done with: out of the list and its download closed. Songs that have just finished
    /// go a few seconds later, so the list isn't changed at the very moment it moves on.
    /// </summary>
    void Drop(Slot slot, bool now = false)
    {
        var from = list;
        void Release()
        {
            try { if (from != null && from.Items.IndexOf(slot.Item) is var at && at >= 0) from.Items.RemoveAt(at); } catch { }
            try { slot.Item.Source.Dispose(); } catch { }
            slot.Stream?.Dispose();
        }
        if (now) Release();
        else _ = Task.Delay(5000).ContinueWith(_ => ui(Release));
    }

    // ---------- What the player says ----------

    /// <summary>The list has moved on to the song loaded ahead (by itself, or Next): catch up with it.</summary>
    void CatchUp()
    {
        if (list == null || current == null || next == null) return;
        if (!ReferenceEquals(list.CurrentItem, next.Item)) return;
        var done = current;
        current = next;
        next = null;
        index = current.Index;
        pendingSeek = null;
        stalled = false;
        ended = false;
        Drop(done);
        FillNext();
        // It couldn't be loaded ahead: one fresh try now that it's its turn.
        if (current.Failed)
        {
            var retry = current;
            ui(() =>
            {
                if (current == retry) StartAt(retry.Index, 0, true);
            });
        }
    }

    void OnFailed(MediaPlaybackItem? item)
    {
        CatchUp();
        if (item == null) return;
        if (next != null && ReferenceEquals(item, next.Item))
        {
            // Found out while loading it ahead: dealt with when it's its turn.
            next.Failed = true;
            if (stalled) StartAt(next.Index, 0, true);
            return;
        }
        if (current != null && ReferenceEquals(item, current.Item))
        {
            current.Failed = true;
            Fail(current);
        }
    }

    /// <summary>A song that can't be played: said, then the next one.</summary>
    void Fail(Slot slot)
    {
        if (current != slot || slot.Handled) return;
        slot.Handled = true;
        failures++;
        var resume = wantPlay || player.PlaybackSession.PlaybackState == MediaPlaybackState.Playing;
        wantPlay = false;
        player.Pause();
        Emit(State(L("Couldn't play this song")));
        _ = Task.Delay(800).ContinueWith(_ => ui(() =>
        {
            if (current != slot) return;
            var target = NextIndex(natural: false);
            if (target < 0 || failures >= tracks.Count) Finish();
            else StartAt(target, 0, resume);
        }));
    }

    void OnEnded()
    {
        CatchUp();
        if (current == null || ended) return;
        var session = player.PlaybackSession;
        // (Still playing, well before the end: a song just started, nothing has ended.)
        if (session.PlaybackState == MediaPlaybackState.Playing && session.Position < session.NaturalDuration - TimeSpan.FromSeconds(2)) return;
        if (next == null) Finish();
        // It stopped short of the song after: that one couldn't be loaded ahead. One fresh try.
        else if (next.Failed) StartAt(next.Index, 0, true);
        else stalled = true;
    }

    /// <summary>The whole queue has played.</summary>
    void Finish()
    {
        ended = true;
        wantPlay = false;
        pendingSeek = null;
        player.Pause();
        UpdateButtons();
        Report();
    }

    void OnPlaybackState()
    {
        var state = player.PlaybackSession.PlaybackState;
        if (state == MediaPlaybackState.Playing)
        {
            wantPlay = true;
            failures = 0;
        }
        else if (state == MediaPlaybackState.Paused && Opened())
        {
            // Paused by something else (another app, the system): the page shows it.
            wantPlay = false;
        }
        Refresh();
    }

    /// <summary>The song that should be playing is the player's, and it has opened.</summary>
    bool Opened() =>
        list != null && current != null && ReferenceEquals(list.CurrentItem, current.Item)
        && player.PlaybackSession.PlaybackState is MediaPlaybackState.Paused or MediaPlaybackState.Playing or MediaPlaybackState.Buffering;

    void Refresh()
    {
        CatchUp();
        if (pendingSeek is { } at && Opened())
        {
            pendingSeek = null;
            player.PlaybackSession.Position = TimeSpan.FromSeconds(at);
        }
        Report();
    }

    void UpdateButtons()
    {
        var commands = player.CommandManager;
        commands.NextBehavior.EnablingRule = current != null && NextIndex(natural: false) >= 0 ? MediaCommandEnablingRule.Always : MediaCommandEnablingRule.Never;
        commands.PreviousBehavior.EnablingRule = current != null ? MediaCommandEnablingRule.Always : MediaCommandEnablingRule.Never;
    }

    /// <summary>NativeAudioState: { index, playing, buffering, time, duration, ended?, error?, repeat }.</summary>
    JsonObject State(string? error = null)
    {
        var session = player.PlaybackSession;
        var state = session.PlaybackState;
        var live = list != null && current != null && ReferenceEquals(list.CurrentItem, current.Item);
        var buffering = !ended && current != null && wantPlay && state is MediaPlaybackState.Opening or MediaPlaybackState.Buffering or MediaPlaybackState.None;
        var playing = !ended && current != null && error == null && (state == MediaPlaybackState.Playing || buffering);
        var time = ended || !live ? pendingSeek ?? 0 : pendingSeek ?? session.Position.TotalSeconds;
        var duration = live && session.NaturalDuration > TimeSpan.Zero ? session.NaturalDuration.TotalSeconds : current?.Track.Duration ?? 0;
        var o = new JsonObject
        {
            ["index"] = index,
            ["playing"] = playing,
            ["buffering"] = buffering,
            ["time"] = Math.Round(Math.Max(0, time), 3),
            ["duration"] = Math.Round(duration, 3),
            ["repeat"] = repeat,
        };
        if (ended) o["ended"] = true;
        if (error != null) o["error"] = error;
        return o;
    }

    void Report()
    {
        CatchUp();
        Emit(State());
    }

    void Emit(JsonObject state) => Changed?.Invoke(state);

    /// <summary>Something the player said, unless it has gone: a hiccup in one song never takes Tuna down.</summary>
    void Safely(Action action)
    {
        if (disposed) return;
        try { action(); }
        catch (Exception) { }
    }

    public void Dispose()
    {
        disposed = true;
        ticker.Stop();
        try
        {
            player.Pause();
            player.Source = null;
            player.Dispose();
        }
        catch { }
    }
}

/// <summary>
/// A song read over HTTP with range requests, for the player when it can't download it itself
/// (through the tunnel's proxy). Seeking just moves the position; the next read asks the server
/// from there.
/// </summary>
sealed class HttpRangeStream : Stream
{
    readonly HttpClient http;
    readonly Uri url;
    readonly SemaphoreSlim gate = new(1, 1);
    HttpResponseMessage? response;
    Stream? body;
    long bodyAt;
    long position;
    long length;
    volatile bool closed;
    /// <summary>A server that doesn't say how long the song is: the whole of it, read at once.</summary>
    byte[]? whole;

    public string ContentType { get; private set; } = "audio/mpeg";

    HttpRangeStream(HttpClient http, Uri url)
    {
        this.http = http;
        this.url = url;
    }

    public static async Task<HttpRangeStream> Open(HttpClient http, Uri url)
    {
        var stream = new HttpRangeStream(http, url);
        await stream.Reopen(0, CancellationToken.None);
        return stream;
    }

    async Task Reopen(long at, CancellationToken cancel)
    {
        CloseBody();
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(at, null);
        var answer = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel);
        if (!answer.IsSuccessStatusCode)
        {
            answer.Dispose();
            throw new IOException($"HTTP {(int)answer.StatusCode}");
        }
        var headers = answer.Content.Headers;
        var partial = answer.StatusCode == HttpStatusCode.PartialContent;
        var from = partial ? headers.ContentRange?.From ?? at : 0;
        var stream = await answer.Content.ReadAsStreamAsync(cancel);
        if (length == 0)
        {
            ContentType = headers.ContentType?.MediaType ?? ContentType;
            length = (partial ? headers.ContentRange?.Length : headers.ContentLength) ?? 0;
            if (length == 0)
            {
                var all = new MemoryStream();
                await stream.CopyToAsync(all, cancel);
                answer.Dispose();
                whole = all.ToArray();
                length = whole.Length;
                return;
            }
        }
        response = answer;
        body = stream;
        bodyAt = from;
        if (closed) CloseBody();
        // A server that ignores ranges sends it all from the start: skip up to here.
        else if (bodyAt < at) await Skip(at - bodyAt, cancel);
    }

    async Task Skip(long count, CancellationToken cancel)
    {
        var buffer = new byte[Math.Min(count, 64 * 1024)];
        while (count > 0)
        {
            var n = await (body ?? throw new EndOfStreamException()).ReadAsync(buffer.AsMemory(0, (int)Math.Min(count, buffer.Length)), cancel);
            if (n == 0) throw new EndOfStreamException();
            count -= n;
            bodyAt += n;
        }
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancel = default)
    {
        await gate.WaitAsync(cancel);
        try
        {
            var at = position;
            if (closed || at >= length || buffer.Length == 0) return 0;
            var wanted = buffer[..(int)Math.Min(buffer.Length, length - at)];
            if (whole != null)
            {
                whole.AsMemory((int)at, wanted.Length).CopyTo(wanted);
                position = at + wanted.Length;
                return wanted.Length;
            }
            // A dropped connection gets one more try from where it got to.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    if (body == null || bodyAt > at || at - bodyAt > 256 * 1024) await Reopen(at, cancel);
                    else if (bodyAt < at) await Skip(at - bodyAt, cancel);
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
                    timeout.CancelAfter(TimeSpan.FromSeconds(20));
                    var n = await (body ?? throw new EndOfStreamException()).ReadAsync(wanted, timeout.Token);
                    if (n == 0) throw new EndOfStreamException();
                    position = at + n;
                    bodyAt += n;
                    return n;
                }
                catch (Exception) when (!cancel.IsCancellationRequested && !closed && attempt == 0)
                {
                    CloseBody();
                }
                catch (Exception) when (!cancel.IsCancellationRequested)
                {
                    // Nothing more to be had (a length that was only an estimate, or no connection): the end.
                    CloseBody();
                    return 0;
                }
            }
        }
        finally
        {
            gate.Release();
        }
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancel) =>
        ReadAsync(buffer.AsMemory(offset, count), cancel).AsTask();

    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

    public override long Seek(long offset, SeekOrigin origin)
    {
        Position = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => position + offset,
            _ => length + offset,
        };
        return position;
    }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => length;

    // (The player doesn't seek while it reads.)
    public override long Position
    {
        get => position;
        set => position = Math.Clamp(value, 0, length);
    }

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    void CloseBody()
    {
        try { body?.Dispose(); } catch { }
        try { response?.Dispose(); } catch { }
        body = null;
        response = null;
    }

    protected override void Dispose(bool disposing)
    {
        // A read under way ends with nothing (its connection closes under it).
        closed = true;
        if (disposing) CloseBody();
        base.Dispose(disposing);
    }
}

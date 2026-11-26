using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Tuna;

/// <summary>
/// Downloads (docs/native-bridge.md, "Downloads"): albums, playlists, Liked songs and songs kept on
/// this PC, in the app's own folder (%LOCALAPPDATA%\Tuna\Downloads), so they play with no connection
/// at all. downloads.json keeps each download as the page gave it, and which songs are here. Songs
/// are files named by song id; covers are named by their address (one file for a whole album). One
/// song at a time, oldest download first, through the tunnel while there is one.
/// </summary>
sealed class DownloadStore
{
    sealed class Download
    {
        public string Id { get; set; } = "";
        public string Kind { get; set; } = "song";
        public string Title { get; set; } = "";
        public string? Subtitle { get; set; }
        public string? Cover { get; set; }
        /// <summary>NativeTrack[], as given.</summary>
        public JsonArray Tracks { get; set; } = new();
        /// <summary>Something didn't come: tried again when it's added again, or when the server's page next opens.</summary>
        public bool Failed { get; set; }
    }

    sealed class Song
    {
        public string Type { get; set; } = "audio/mpeg";
        public long Bytes { get; set; }
    }

    sealed class Manifest
    {
        public List<Download> Downloads { get; set; } = new();
        /// <summary>The songs on this PC, by id.</summary>
        public Dictionary<string, Song> Songs { get; set; } = new();
    }

    /// <summary>Something changed (on the window's thread): the page hears about it at most about twice a second.</summary>
    public event Action? Changed;

    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    static HttpClient? client;
    static string? clientProxy;
    /// <summary>Through the tunnel while there is one (it goes direct or through WireGuard itself), like the player.</summary>
    static HttpClient Http
    {
        get
        {
            var proxy = Tunnel.ProxyUrl;
            if (client == null || clientProxy != proxy)
            {
                var handler = new SocketsHttpHandler { UseCookies = false, ConnectTimeout = TimeSpan.FromSeconds(15) };
                if (proxy != null)
                {
                    handler.Proxy = new WebProxy(proxy);
                    handler.UseProxy = true;
                }
                // The one before keeps going for a song already under way.
                client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
                clientProxy = proxy;
            }
            return client;
        }
    }

    readonly string songs = Path.Combine(AppData.Root, "Downloads", "Songs");
    readonly string covers = Path.Combine(AppData.Root, "Downloads", "Covers");
    readonly string file = Path.Combine(AppData.Root, "downloads.json");
    readonly Manifest manifest;
    readonly System.Windows.Forms.Timer ticker = new() { Interval = 500 };
    bool dirty, working, stopped;
    long shown = -1;
    /// <summary>The download being worked on, the song coming in, and how much of it has.</summary>
    Download? busy;
    (string Id, CancellationTokenSource Cancel)? fetching;
    long receiving;

    public DownloadStore()
    {
        try { manifest = JsonSerializer.Deserialize<Manifest>(File.ReadAllText(file), Json) ?? new(); }
        catch { manifest = new(); }
        foreach (var id in manifest.Songs.Keys.Where(id => !File.Exists(SongFile(id))).ToList()) manifest.Songs.Remove(id);
        // Anything no download needs (left by a crash, say) goes; half-downloaded songs start again.
        Tidy();
        ticker.Tick += (_, _) =>
        {
            if (dirty || (busy != null && Interlocked.Read(ref receiving) != shown)) Send();
            else if (busy == null) ticker.Stop();
        };
    }

    /// <summary>Something downloaded to play.</summary>
    public bool Any => manifest.Songs.Count > 0;

    static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    static IEnumerable<string> Ids(Download d) => d.Tracks.Select(t => Str(t?["id"])).OfType<string>().Where(id => id.Length > 0);
    static IEnumerable<string?> Images(Download d) => d.Tracks.Select(t => Str(t?["artwork"])).Prepend(d.Cover);

    string SongFile(string id) => Path.Combine(songs, FileName(id));

    /// <summary>A song's file name: its id ("2fd4e1c6…"), or a name made from it when the id isn't one Windows takes as it is.</summary>
    internal static string FileName(string id) => Regex.IsMatch(id, "^[a-z0-9-]{8,64}$") ? id : "_" + Hash(id);

    /// <summary>A cover's file: named by its address without the media key, so a whole album shares one.</summary>
    string? ImageFile(string? address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var url)) return null;
        var query = url.Query.TrimStart('?').Split('&').Where(p => p.Length > 0 && !p.StartsWith("k="));
        return Path.Combine(covers, Hash(url.AbsolutePath + "?" + string.Join("&", query)));
    }

    internal static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)), 0, 16).ToLowerInvariant();

    void Save()
    {
        try
        {
            // Written whole, then swapped in: a list cut short would lose every download.
            Directory.CreateDirectory(AppData.Root);
            File.WriteAllText(file + ".new", JsonSerializer.Serialize(manifest, Json));
            File.Move(file + ".new", file, overwrite: true);
        }
        catch { /* the disk is full or busy; the list is saved next time */ }
    }

    // ---------- What the page sees ----------

    void Announce(bool now = false)
    {
        dirty = true;
        if (now) Send();
        else ticker.Start();
    }

    void Send()
    {
        dirty = false;
        shown = Interlocked.Read(ref receiving);
        Changed?.Invoke();
    }

    /// <summary>NativeDownload[], newest first. The app's own pages also get <c>localCover</c>.</summary>
    public JsonArray List(bool local)
    {
        var list = new JsonArray();
        foreach (var d in manifest.Downloads)
        {
            var ids = Ids(d).Distinct().ToList();
            var ready = ids.Where(manifest.Songs.ContainsKey).ToList();
            var bytes = ready.Sum(id => manifest.Songs[id].Bytes) + (d == busy ? Interlocked.Read(ref receiving) : 0);
            var item = new JsonObject
            {
                ["id"] = d.Id,
                ["kind"] = d.Kind,
                ["title"] = d.Title,
                ["tracks"] = d.Tracks.DeepClone(),
                ["ready"] = new JsonArray(ready.Select(id => (JsonNode)id).ToArray()),
                ["bytes"] = bytes,
                ["state"] = ready.Count == ids.Count ? "done" : d.Failed ? "failed" : d == busy ? "downloading" : "waiting",
            };
            if (d.Subtitle != null) item["subtitle"] = d.Subtitle;
            if (d.Cover != null) item["cover"] = d.Cover;
            if (local && File.Exists(ImageFile(d.Cover))) item["localCover"] = $"{LocalPages.Origin}covers/{Uri.EscapeDataString(d.Id)}";
            list.Add(item);
        }
        return list;
    }

    /// <summary>A download's cover, for the offline page.</summary>
    public byte[]? Cover(string id)
    {
        try { return manifest.Downloads.FirstOrDefault(d => d.Id == id) is { } d && ImageFile(d.Cover) is { } path ? File.ReadAllBytes(path) : null; }
        catch { return null; }
    }

    public static string ImageType(byte[] bytes) =>
        bytes is [0x89, 0x50, ..] ? "image/png" : bytes is [0x52, 0x49, 0x46, 0x46, ..] ? "image/webp" : bytes is [0x47, 0x49, 0x46, ..] ? "image/gif" : "image/jpeg";

    // ---------- What the player asks ----------

    /// <summary>A downloaded song, open for the player (it can still be deleted meanwhile); null when it isn't here.</summary>
    public (FileStream File, string Type)? Open(string songId)
    {
        if (!manifest.Songs.TryGetValue(songId, out var song)) return null;
        try { return (new FileStream(SongFile(songId), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), song.Type); }
        catch { return null; }
    }

    public bool Has(string songId) => manifest.Songs.ContainsKey(songId);

    /// <summary>A cover kept on this PC, for the media overlay; null when it isn't here.</summary>
    public string? Image(Uri url) => ImageFile(url.OriginalString) is { } path && File.Exists(path) ? path : null;

    // ---------- What the page asks ----------

    /// <summary>downloads.add: kept, and whatever isn't here yet comes. The same id again replaces its songs.</summary>
    public void Add(JsonObject args)
    {
        if (Str(args["id"]) is not { Length: > 0 } id) return;
        var d = manifest.Downloads.FirstOrDefault(x => x.Id == id);
        if (d == null) manifest.Downloads.Insert(0, d = new Download { Id = id });
        d.Kind = Str(args["kind"]) ?? "song";
        d.Title = Str(args["title"]) ?? "";
        d.Subtitle = Str(args["subtitle"]);
        d.Cover = Str(args["cover"]);
        d.Tracks = args["tracks"]?.DeepClone() as JsonArray ?? new JsonArray();
        d.Failed = false;
        Tidy();
        Save();
        Announce(now: true);
        Work();
    }

    public void Remove(string id)
    {
        manifest.Downloads.RemoveAll(d => d.Id == id);
        Tidy();
        Save();
        Announce(now: true);
    }

    public void Clear()
    {
        manifest.Downloads.Clear();
        Tidy();
        Save();
        Announce(now: true);
    }

    /// <summary>The server's page has opened: carry on with what isn't here yet, failed ones too.</summary>
    public void Resume()
    {
        foreach (var d in manifest.Downloads) d.Failed = false;
        Announce();
        Work();
    }

    /// <summary>Tuna is quitting: the song coming in stops (it starts again next time).</summary>
    public void Stop()
    {
        stopped = true;
        fetching?.Cancel.Cancel();
    }

    /// <summary>Deletes the files no download needs any more, stopping the song coming in if it's one of them.</summary>
    void Tidy()
    {
        var needed = manifest.Downloads.SelectMany(Ids).ToHashSet();
        foreach (var id in manifest.Songs.Keys.Where(id => !needed.Contains(id)).ToList()) manifest.Songs.Remove(id);
        if (fetching is { } f && !needed.Contains(f.Id)) f.Cancel.Cancel();
        var keep = needed.Select(SongFile).Concat(manifest.Downloads.SelectMany(Images).Select(ImageFile).OfType<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var folder in new[] { songs, covers })
        {
            if (!Directory.Exists(folder)) continue;
            foreach (var path in Directory.EnumerateFiles(folder))
                if (!keep.Contains(path.EndsWith(".part") ? path[..^5] : path)) Delete(path);
        }
    }

    internal static void Delete(string path)
    {
        try { File.Delete(path); } catch { /* still closing; it goes next time */ }
    }

    // ---------- Downloading ----------

    /// <summary>The first song of a download that isn't here yet (and hasn't been refused this time round).</summary>
    JsonNode? Missing(Download d, HashSet<string>? refused = null) =>
        d.Tracks.FirstOrDefault(t => Str(t?["id"]) is { Length: > 0 } id && !manifest.Songs.ContainsKey(id) && refused?.Contains(id) != true);

    /// <summary>One song at a time, oldest download first, until everything is here or has failed. On the window's thread.</summary>
    async void Work()
    {
        if (working || stopped) return;
        working = true;
        try
        {
            while (!stopped && manifest.Downloads.LastOrDefault(x => !x.Failed && Missing(x) != null) is { } d)
            {
                busy = d;
                Announce();
                await KeepImage(d.Cover);
                // Songs the server said no to are skipped; with no connection, everything waits for next time.
                var refused = new HashSet<string>();
                var lost = false;
                while (!stopped && manifest.Downloads.Contains(d) && Missing(d, refused) is { } track)
                {
                    var id = Str(track["id"])!;
                    if (!Uri.TryCreate(Str(track["url"]), UriKind.Absolute, out var url))
                    {
                        refused.Add(id);
                        continue;
                    }
                    try
                    {
                        await KeepSong(id, url);
                        await KeepImage(Str(track["artwork"]));
                    }
                    catch (HttpRequestException e) when (e.StatusCode != null)
                    {
                        refused.Add(id);
                    }
                    catch
                    {
                        lost = true;
                        break;
                    }
                }
                busy = null;
                foreach (var x in manifest.Downloads.Where(x => (x == d || lost) && Missing(x) != null)) x.Failed = true;
                Save();
                Announce(now: true);
                if (lost) break;
            }
        }
        finally
        {
            working = false;
            busy = null;
        }
    }

    async Task KeepSong(string id, Uri url)
    {
        using var cancel = new CancellationTokenSource();
        var path = SongFile(id);
        fetching = (id, cancel);
        Interlocked.Exchange(ref receiving, 0);
        try
        {
            var (type, bytes) = await Task.Run(() => Fetch(url, path, cancel.Token, n => Interlocked.Exchange(ref receiving, n)));
            // (Removed while it came.)
            if (!manifest.Downloads.Any(d => Ids(d).Contains(id)))
            {
                Delete(path);
                return;
            }
            manifest.Songs[id] = new Song { Type = type, Bytes = bytes };
            Save();
            Announce();
        }
        catch (Exception) when (cancel.IsCancellationRequested)
        {
            // No download needs it any more, or Tuna is quitting.
        }
        finally
        {
            fetching = null;
            Interlocked.Exchange(ref receiving, 0);
        }
    }

    /// <summary>A cover, once: a song without it still plays.</summary>
    async Task KeepImage(string? address)
    {
        if (ImageFile(address) is not { } path || File.Exists(path) || !Uri.TryCreate(address, UriKind.Absolute, out var url)) return;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await Task.Run(() => Fetch(url, path, timeout.Token));
        }
        catch { }
    }

    /// <summary>Saves an address to a file (by way of a .part file): its type and size.</summary>
    internal static async Task<(string Type, long Bytes)> Fetch(Uri url, string path, CancellationToken cancel, Action<long>? progress = null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var part = path + ".part";
        using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancel);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength ?? 0;
        // A converted song's length is only the server's estimate.
        var estimated = response.Headers.AcceptRanges.Contains("none");
        long received = 0;
        await using (var input = await response.Content.ReadAsStreamAsync(cancel))
        await using (var output = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.Read | FileShare.Delete, 1 << 16, useAsync: true))
        {
            var buffer = new byte[1 << 16];
            try
            {
                while (true)
                {
                    // A connection that goes quiet for half a minute counts as dropped.
                    using var quiet = CancellationTokenSource.CreateLinkedTokenSource(cancel);
                    quiet.CancelAfter(TimeSpan.FromSeconds(30));
                    var n = await input.ReadAsync(buffer, quiet.Token);
                    if (n == 0) break;
                    await output.WriteAsync(buffer.AsMemory(0, n), cancel);
                    received += n;
                    progress?.Invoke(received);
                }
            }
            catch (HttpIOException e) when (e.HttpRequestError == HttpRequestError.ResponseEnded && estimated && received > total * 9 / 10)
            {
                // A little shorter than estimated: that's all of it.
            }
        }
        if (!estimated && total > 0 && received < total) throw new IOException("The connection closed early");
        File.Move(part, path, overwrite: true);
        return (response.Content.Headers.ContentType?.MediaType ?? "audio/mpeg", received);
    }
}

/// <summary>
/// The queue kept ahead (docs/native-bridge.md, "The player"): the next few songs, fetched in full
/// into %LOCALAPPDATA%\Tuna\Ahead so the music carries on through a dropped connection, a switch to
/// the tunnel or a server restart. One song at a time, once the song playing has loaded, at its
/// address with dl=1 (fetching it isn't playing it). About 500 MB at most, oldest first; ahead.json
/// keeps each song's type and size. Songs that are downloaded are never fetched. Copies are kept by
/// their address without the media key, so they follow the sound quality: a song the queue now has
/// at another address is fetched again, and its copy in the old quality deleted.
/// </summary>
sealed class SongCache
{
    sealed class Song
    {
        /// <summary>The song's id, to find its copy in another quality.</summary>
        public string Id { get; set; } = "";
        public string Type { get; set; } = "audio/mpeg";
        public long Bytes { get; set; }
        /// <summary>When it was fetched or last played (ms since 1970): the oldest go first.</summary>
        public long Used { get; set; }
    }

    const long Cap = 500L << 20;

    /// <summary>A song has come (on the window's thread).</summary>
    public event Action? Ready;

    readonly DownloadStore downloads;
    readonly string folder = Path.Combine(AppData.Root, "Ahead");
    readonly string file = Path.Combine(AppData.Root, "ahead.json");
    /// <summary>By <see cref="Key"/>.</summary>
    readonly Dictionary<string, Song> songs;
    /// <summary>The songs to have here, in order, and those that didn't come this time round (by key).</summary>
    List<Track> wanted = new();
    readonly HashSet<string> refused = new();
    bool allowed, working, stopped;
    (string Key, CancellationTokenSource Cancel)? fetching;

    public SongCache(DownloadStore downloads)
    {
        this.downloads = downloads;
        try { songs = JsonSerializer.Deserialize<Dictionary<string, Song>>(File.ReadAllText(file), DownloadStore.Json) ?? new(); }
        catch { songs = new(); }
        // (Copies kept by song id, before they followed the sound quality, go here too.)
        foreach (var key in songs.Keys.Where(key => !File.Exists(SongFile(key))).ToList()) songs.Remove(key);
        // Anything else in the folder (a song cut short) goes.
        var keep = songs.Keys.Select(SongFile).ToHashSet(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (Directory.Exists(folder))
                foreach (var path in Directory.EnumerateFiles(folder))
                    if (!keep.Contains(path)) DownloadStore.Delete(path);
        }
        catch { /* next time */ }
    }

    static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>What a copy is kept by: the song's address without the media key (or dl), so a new sound quality is a new copy.</summary>
    static string? Key(Track? track)
    {
        if (track?.Url is not { } url) return null;
        var query = url.Query.TrimStart('?').Split('&').Where(p => p.Length > 0 && !p.StartsWith("k=") && !p.StartsWith("dl="));
        return url.GetLeftPart(UriPartial.Path) + "?" + string.Join("&", query);
    }

    string SongFile(string key) => Path.Combine(folder, DownloadStore.Hash(key));

    public bool Has(Track track) => Key(track) is { } key && songs.ContainsKey(key);

    /// <summary>A song kept ahead, open for the player (it can still be deleted meanwhile); null when it isn't here.</summary>
    public (FileStream File, string Type)? Open(Track track)
    {
        if (Key(track) is not { } key || !songs.TryGetValue(key, out var song)) return null;
        try
        {
            var stream = new FileStream(SongFile(key), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            song.Used = Now;
            return (stream, song.Type);
        }
        catch
        {
            songs.Remove(key);
            return null;
        }
    }

    /// <summary>
    /// The songs to have here, in order, after <paramref name="playing"/> (the player says on every
    /// change). A song coming in that's no longer one of them stops; their copies at another address
    /// (another sound quality) go. <paramref name="go"/>: the song playing has loaded, so the next may start.
    /// </summary>
    public void Want(Track? playing, List<Track> next, bool go)
    {
        if (!next.Select(Key).SequenceEqual(wanted.Select(Key)))
        {
            refused.Clear();
            if (fetching is { } f && !next.Any(t => Key(t) == f.Key)) f.Cancel.Cancel();
        }
        wanted = next;
        allowed = go;
        Forget(playing == null ? next : next.Prepend(playing));
        if (go) Work();
    }

    /// <summary>Copies of these songs at another address than theirs now (another sound quality): deleted.</summary>
    void Forget(IEnumerable<Track> current)
    {
        var stale = new List<string>();
        foreach (var track in current)
            if (track.Id.Length > 0 && Key(track) is { } key)
                stale.AddRange(songs.Where(s => s.Value.Id == track.Id && s.Key != key).Select(s => s.Key));
        if (stale.Count == 0) return;
        foreach (var key in stale)
        {
            // (The song playing carries on from its copy: open files can be deleted.)
            songs.Remove(key);
            DownloadStore.Delete(SongFile(key));
        }
        Save();
    }

    /// <summary>Tuna is quitting: the song coming in stops.</summary>
    public void Stop()
    {
        stopped = true;
        fetching?.Cancel.Cancel();
    }

    /// <summary>One song at a time, in order, while the player allows. On the window's thread.</summary>
    async void Work()
    {
        if (working || stopped) return;
        working = true;
        try
        {
            while (allowed && !stopped && wanted.FirstOrDefault(t => Key(t) is { } key && !songs.ContainsKey(key) && !downloads.Has(t.Id) && !refused.Contains(key)) is { } track)
                await Keep(track);
        }
        finally
        {
            working = false;
        }
    }

    async Task Keep(Track track)
    {
        using var cancel = new CancellationTokenSource();
        var (url, key) = (track.Url!, Key(track)!);
        var path = SongFile(key);
        fetching = (key, cancel);
        try
        {
            var address = new Uri(url.OriginalString + (url.Query.Length > 1 ? "&" : "?") + "dl=1");
            var (type, bytes) = await Task.Run(() => DownloadStore.Fetch(address, path, cancel.Token));
            songs[key] = new Song { Id = track.Id, Type = type, Bytes = bytes, Used = Now };
            Trim();
            Save();
            Ready?.Invoke();
        }
        catch
        {
            // Not wanted any more, or it didn't come (tried again when the queue changes).
            DownloadStore.Delete(path + ".part");
            if (!cancel.IsCancellationRequested) refused.Add(key);
        }
        finally
        {
            fetching = null;
        }
    }

    /// <summary>About 500 MB at most: the songs fetched or played longest ago go, never the ones wanted now.</summary>
    void Trim()
    {
        var total = songs.Values.Sum(s => s.Bytes);
        foreach (var (key, song) in songs.OrderBy(s => s.Value.Used).ToList())
        {
            if (total <= Cap) break;
            if (wanted.Any(t => Key(t) == key)) continue;
            songs.Remove(key);
            DownloadStore.Delete(SongFile(key));
            total -= song.Bytes;
        }
    }

    void Save()
    {
        try
        {
            Directory.CreateDirectory(AppData.Root);
            File.WriteAllText(file + ".new", JsonSerializer.Serialize(songs, DownloadStore.Json));
            File.Move(file + ".new", file, overwrite: true);
        }
        catch { /* saved next time */ }
    }
}

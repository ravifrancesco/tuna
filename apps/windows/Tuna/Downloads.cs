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

    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
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

    /// <summary>A song's file: its id ("2fd4e1c6…"), or a name made from it when the id isn't one Windows takes as it is.</summary>
    string SongFile(string id) => Path.Combine(songs, Regex.IsMatch(id, "^[a-z0-9-]{8,64}$") ? id : "_" + Hash(id));

    /// <summary>A cover's file: named by its address without the media key, so a whole album shares one.</summary>
    string? ImageFile(string? address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var url)) return null;
        var query = url.Query.TrimStart('?').Split('&').Where(p => p.Length > 0 && !p.StartsWith("k="));
        return Path.Combine(covers, Hash(url.AbsolutePath + "?" + string.Join("&", query)));
    }

    static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)), 0, 16).ToLowerInvariant();

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

    static void Delete(string path)
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
    static async Task<(string Type, long Bytes)> Fetch(Uri url, string path, CancellationToken cancel, Action<long>? progress = null)
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

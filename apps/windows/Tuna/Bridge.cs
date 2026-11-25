using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace Tuna;

/// <summary>The setup, loading and offline pages, served by the app itself.</summary>
static class LocalPages
{
    public const string Host = "tuna.example";
    public const string Origin = "https://" + Host + "/";
    public static readonly string Folder = Path.Combine(AppContext.BaseDirectory, "pages");

    public static bool IsLocal(Uri? url) => url is { Scheme: "https", Host: Host };

    public static Uri Page(string name, IDictionary<string, string>? query = null) =>
        new(Origin + name + (query is { Count: > 0 } ? "?" + string.Join("&", query.Select(q => $"{Uri.EscapeDataString(q.Key)}={Uri.EscapeDataString(q.Value)}")) : ""));
}

/// <summary>
/// How the page and the app talk (docs/native-bridge.md): <c>window.tunaHello</c> says what the app
/// can do before the page's scripts run; the page sends <c>{ cmd, args, id? }</c> with
/// <c>chrome.webview.postMessage</c>; the app answers and reports with web messages the page hands
/// to <c>window.__tuna</c>: <c>{ type: 'reply', id, value }</c>, <c>{ type: 'audio', state }</c>.
/// </summary>
sealed class Bridge(MainWindow window)
{
    /// <summary>The newer release the last check found.</summary>
    Updater.Release? release;

    public static string Script(string version, bool audio)
    {
        string Hello(string[] features) => new JsonObject
        {
            ["platform"] = "windows",
            ["version"] = version,
            ["formats"] = new JsonArray(AudioPlayer.Formats.Select(f => (JsonNode)f).ToArray()),
            ["features"] = new JsonArray(features.Select(f => (JsonNode)f).ToArray()),
        }.ToJsonString();
        // The server's page, and the offline page (what's downloaded, played by the app).
        var server = Hello(audio ? ["audio", "changeServer", "downloads", "tunnel", "update"] : ["changeServer", "tunnel", "update"]);
        var offline = Hello(audio ? ["audio", "downloads"] : []);
        return $"if (window.top === window) window.tunaHello = location.host === '{LocalPages.Host}' ? {offline} : {server};";
    }

    /// <summary>The player's state, on every change.</summary>
    public void Audio(JsonObject state) => Post(new JsonObject { ["type"] = "audio", ["state"] = state });

    /// <summary>Something the page hears about: <c>{ type: 'event', name, value }</c>.</summary>
    public void Event(string name, JsonNode? value) => Post(new JsonObject { ["type"] = "event", ["name"] = name, ["value"] = value });

    void Post(JsonObject message)
    {
        try { window.Web?.PostWebMessageAsJson(message.ToJsonString()); }
        catch (Exception) { /* the page is restarting; it asks again when it's back */ }
    }

    static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    static double? Num(JsonNode? node) => node is JsonValue v && v.TryGetValue<double>(out var n) ? n : null;
    static bool Flag(JsonNode? node) => node is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    public async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonObject? message;
        try { message = JsonNode.Parse(e.WebMessageAsJson) as JsonObject; }
        catch (JsonException) { return; }
        if (message == null) return;
        var id = message["id"]?.DeepClone();
        // Only the app's own pages and the Tuna server may use the app.
        Uri.TryCreate(e.Source, UriKind.Absolute, out var source);
        var local = LocalPages.IsLocal(source);
        if (!local && !Server.Owns(source)) return;
        JsonNode? value = null;
        string? error = null;
        try
        {
            value = await Handle(Str(message["cmd"]) ?? "", message["args"] as JsonObject, local);
        }
        catch (Exception problem)
        {
            error = problem.Message;
        }
        if (id == null) return;
        var reply = new JsonObject { ["type"] = "reply", ["id"] = id, ["value"] = value };
        if (error != null) reply["error"] = error;
        Post(reply);
    }

    void RestartSoon() => _ = Task.Delay(500).ContinueWith(_ => window.BeginInvoke(window.RestartWebView));

    async Task<JsonNode?> Handle(string cmd, JsonObject? args, bool local)
    {
        var audio = window.Audio;
        switch (cmd)
        {
            // The player
            case "audio.load":
                audio?.Load(args?["tracks"] as JsonArray, (int)(Num(args?["index"]) ?? 0), Num(args?["start"]) ?? 0, Flag(args?["play"]));
                return null;
            case "audio.update":
                audio?.Update(args?["tracks"] as JsonArray, (int)(Num(args?["index"]) ?? 0));
                return null;
            case "audio.command":
                audio?.Command(Str(args?["name"]) ?? "", args?["value"]);
                return null;
            case "audio.current":
                return audio?.Current();

            // Downloads, and the offline page that plays them
            case "downloads.add":
                if (args != null) window.Downloads.Add(args);
                return null;
            case "downloads.remove":
                window.Downloads.Remove(Str(args?["id"]) ?? "");
                return null;
            case "downloads.clear":
                window.Downloads.Clear();
                return null;
            case "downloads.list":
                return window.Downloads.List(local);
            case "downloads.offline":
                window.ShowOffline();
                return null;
            case "server.reachable":
                return JsonValue.Create(Server.Url is { } server && (await Server.Reachable(server) || await Tunnel.Reachable(server)));
            case "server.open":
                window.ShowServer();
                return null;

            // The server (the setup page asks for the first two)
            case "changeServer":
                window.ShowSetup(null);
                return null;
            case "currentServer":
                if (!local) throw new Problem(L("Not allowed here"));
                return Server.Url?.GetLeftPart(UriPartial.Authority);
            case "connect":
            {
                if (!local) throw new Problem(L("Not allowed here"));
                var url = await Server.Probe(Server.Normalize(Str(args?["address"]) ?? ""));
                window.BeginInvoke(() => window.Connect(url));
                return url.GetLeftPart(UriPartial.Authority);
            }

            // Away from home (Settings, the server's pages only): never the configuration itself back.
            // A change restarts Edge's engine (it takes its proxy only as it starts), once this is answered.
            case "tunnel.status":
                return Tunnel.Status();
            case "tunnel.save":
            {
                if (local) throw new Problem(L("Not allowed here"));
                var problem = await Tunnel.Save(Str(args?["config"]) ?? "");
                if (problem == null) RestartSoon();
                return problem ?? "";
            }
            case "tunnel.remove":
                if (local) throw new Problem(L("Not allowed here"));
                Tunnel.Remove();
                RestartSoon();
                return null;

            // Updates from GitHub Releases
            case "update.check":
                release = await Updater.Check();
                return new JsonObject
                {
                    ["current"] = MainWindow.Version,
                    ["latest"] = release?.Version,
                    ["available"] = release != null,
                    ["canInstall"] = release?.Download != null,
                    ["page"] = release?.Page,
                };
            case "update.install":
            {
                release ??= await Updater.Check();
                if (release == null) return null;
                await Updater.Install(release);
                // The installer closes whatever is left of Tuna and opens it again.
                window.BeginInvoke(() => Application.Exit());
                return null;
            }

            // Not on Windows (keepAwake, mobileData…): nothing to do.
            default:
                return null;
        }
    }
}

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace Tuna;

/// <summary>
/// The Tuna window: the Tuna interface from your server (WebView2), and Windows' own player
/// behind it (<see cref="AudioPlayer"/>), which the page drives. Closing the window while music
/// plays only minimises it: the music stops when Tuna quits.
/// </summary>
sealed class MainWindow : Form
{
    public static readonly string Version = typeof(MainWindow).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0";

    /// <summary>The player; null when Windows' media features are missing (then the page plays the music itself).</summary>
    public AudioPlayer? Audio { get; private set; }
    /// <summary>What's kept on this PC to play with no connection.</summary>
    public readonly DownloadStore Downloads = new();
    public CoreWebView2? Web => controller?.CoreWebView2;

    readonly Bridge bridge;
    readonly Dictionary<ulong, Uri> navigations = new();
    CoreWebView2Environment? environment;
    CoreWebView2Controller? controller;
    /// <summary>The server's page the offline page took over from, to go back to.</summary>
    Uri? returnUrl;
    bool fullscreen;
    Native.WINDOWPLACEMENT placement;
    Rectangle normalBounds;
    bool maximized;

    public MainWindow()
    {
        Text = "Tuna";
        BackColor = Color.FromArgb(7, 6, 12);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var scale = DeviceDpi / 96f;
        MinimumSize = new Size((int)(720 * scale), (int)(480 * scale));
        PlaceWindow(scale);
        bridge = new Bridge(this);
        Downloads.Changed += () => bridge.Event("downloads", Downloads.List(LocalPages.IsLocal(Uri.TryCreate(Web?.Source, UriKind.Absolute, out var page) ? page : null)));
    }

    /// <summary>Where the window was last time, if that's still on a screen; otherwise centred.</summary>
    void PlaceWindow(float scale)
    {
        StartPosition = FormStartPosition.Manual;
        var saved = AppData.Config()["bounds"] as JsonObject;
        var rect = saved == null ? Rectangle.Empty : new Rectangle(
            (int?)saved["x"] ?? 0, (int?)saved["y"] ?? 0, (int?)saved["width"] ?? 0, (int?)saved["height"] ?? 0);
        if (rect.Width < 400 || !Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect)))
        {
            var area = Screen.PrimaryScreen!.WorkingArea;
            var size = new Size(Math.Min((int)(1280 * scale), area.Width * 9 / 10), Math.Min((int)(820 * scale), area.Height * 9 / 10));
            rect = new Rectangle(area.Left + (area.Width - size.Width) / 2, area.Top + (area.Height - size.Height) / 2, size.Width, size.Height);
        }
        Bounds = normalBounds = rect;
        if ((bool?)AppData.Config()["maximized"] == true) WindowState = FormWindowState.Maximized;
        maximized = WindowState == FormWindowState.Maximized;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.DarkTitleBar(Handle);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            try
            {
                Audio = new AudioPlayer(OnWindowThread, Downloads);
                Audio.Changed += bridge.Audio;
            }
            catch (Exception)
            {
                // No Windows media features (N editions without the Media Feature Pack): the page plays instead.
                Audio = null;
            }
            await CreateWebView();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, L("Tuna couldn't start: {error}", ("error", error.Message)), "Tuna", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    /// <summary>For the player's events, which come on other threads.</summary>
    void OnWindowThread(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(action); }
        catch (InvalidOperationException) { /* closing */ }
    }

    async Task CreateWebView()
    {
        // Away from home: with a tunnel set up, the page and the player go through it (it goes straight
        // to the server when that answers directly). Edge's engine takes its proxy only as it starts.
        await Tunnel.Start();
        Audio?.UseProxy(Tunnel.ProxyUrl);
        var arguments = new List<string>();
        // The media keys and the media overlay are the player's, not the page's.
        if (Audio != null) arguments.Add("--disable-features=HardwareMediaKeyHandling");
        if (Tunnel.ProxyUrl is { } proxy) arguments.Add($"--proxy-server={proxy}");
        // The interface follows navigator.language: the same language as Windows (and these messages).
        var options = new CoreWebView2EnvironmentOptions(string.Join(" ", arguments)) { Language = Strings.Language };
        environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(AppData.Root, "WebView2"), options);
        controller = await environment.CreateCoreWebView2ControllerAsync(Handle);
        controller.DefaultBackgroundColor = BackColor;
        controller.Bounds = ClientRectangle;
        controller.IsVisible = WindowState != FormWindowState.Minimized;
        controller.AcceleratorKeyPressed += OnAcceleratorKey;

        var web = controller.CoreWebView2;
        var settings = web.Settings;
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreDefaultScriptDialogsEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsSwipeNavigationEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        // window.tunaHello, there before any of the page's own scripts run (awaited before the first page).
        await web.AddScriptToExecuteOnDocumentCreatedAsync(Bridge.Script(Version, Audio != null));
        web.AddWebResourceRequestedFilter($"{LocalPages.Origin}*", CoreWebView2WebResourceContext.All);
        web.WebResourceRequested += ServeLocal;
        web.WebMessageReceived += bridge.OnMessage;
        web.NavigationStarting += OnNavigationStarting;
        web.NavigationCompleted += OnNavigationCompleted;
        web.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenInBrowser(e.Uri);
        };
        web.ScriptDialogOpening += OnScriptDialog;
        // A page asking for full screen gets the whole window.
        web.ContainsFullScreenElementChanged += (_, _) =>
        {
            if (web.ContainsFullScreenElement != fullscreen) ToggleFullscreen();
        };
        web.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive) web.Reload();
            else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) BeginInvoke(RestartWebView);
        };
        controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);

        if (Server.Url is { } server) _ = Start(server);
        else ShowSetup(null);
    }

    /// <summary>
    /// Opening: the hook and the fish while the server is checked (a few seconds at most), then
    /// Tuna, or (when it doesn't answer) what's downloaded, else the setup page saying the server
    /// can't be reached, ready to try again.
    /// </summary>
    async Task Start(Uri server)
    {
        Navigate(LocalPages.Page("loading.html"));
        if (await Server.Reachable(server))
        {
            Navigate(server);
            return;
        }
        // Away from home, through the tunnel when there is one, as in Netfish: the loading page shows
        // a ring ahead of the mark, the mark swims in, and Tuna (#tunnel) takes the ring over.
        if (Tunnel.Port != null)
        {
            await LoadingTunnel("connecting");
            if (await Tunnel.Reachable(server))
            {
                await LoadingTunnel("connected");
                await Task.Delay(900);
                Navigate(new UriBuilder(server) { Fragment = "tunnel" }.Uri);
                return;
            }
        }
        Unreachable(server);
    }

    void Unreachable(Uri server)
    {
        if (Audio != null && Downloads.Any) ShowOffline();
        else ShowSetup(L("Can't reach {server}", ("server", server.GetLeftPart(UriPartial.Authority))));
    }

    async Task LoadingTunnel(string state)
    {
        try { if (Web != null) await Web.ExecuteScriptAsync($"window.tunaTunnel && window.tunaTunnel('{state}')"); } catch { }
    }

    /// <summary>Edge's engine went away (crashed or updated), or the tunnel changed: start it again. The music carries on.</summary>
    internal async void RestartWebView()
    {
        var old = controller;
        controller = null;
        try { old?.Close(); } catch { }
        try { await CreateWebView(); }
        catch (Exception error)
        {
            MessageBox.Show(this, L("Tuna's window stopped working ({error}). Please open Tuna again.", ("error", error.Message)), "Tuna");
            Close();
        }
    }

    // ---------- Pages ----------

    void Navigate(Uri url) => Web?.Navigate(url.ToString());

    public void ShowSetup(string? error) =>
        Navigate(LocalPages.Page("setup.html", error == null ? null : new Dictionary<string, string> { ["error"] = error }));

    /// <summary>What's downloaded (apps/common/offline.html), played by the app. The music carries on.</summary>
    public void ShowOffline()
    {
        Uri.TryCreate(Web?.Source, UriKind.Absolute, out var page);
        if (LocalPages.IsLocal(page) && page!.AbsolutePath == "/offline.html") return;
        if (Server.Owns(page)) returnUrl = page;
        Navigate(LocalPages.Page("offline.html"));
    }

    /// <summary>From the offline page, back to the server's page it took over from.</summary>
    public void ShowServer()
    {
        var target = Server.Owns(returnUrl) ? returnUrl : Server.Url;
        returnUrl = null;
        if (target != null) Navigate(target);
        else ShowSetup(null);
    }

    /// <summary>The setup page found a Tuna server: keep it and open it. Another server's songs stop.</summary>
    public void Connect(Uri server)
    {
        if (Server.Url?.GetLeftPart(UriPartial.Authority) != server.GetLeftPart(UriPartial.Authority)) Audio?.Stop();
        Server.Url = server;
        Navigate(server);
    }

    static void OpenInBrowser(string url)
    {
        if (!Regex.IsMatch(url, "^https?://", RegexOptions.IgnoreCase)) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    /// <summary>The setup, loading and offline pages, from the pages folder next to Tuna.exe, and the downloads' covers.</summary>
    void ServeLocal(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (environment == null || !Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var url) || !LocalPages.IsLocal(url)) return;
        var name = Uri.UnescapeDataString(url.AbsolutePath.Trim('/'));
        var file = Path.Combine(LocalPages.Folder, name);
        byte[]? body = null;
        var type = "";
        if (name.StartsWith("covers/"))
        {
            body = Downloads.Cover(name["covers/".Length..]);
            if (body != null) type = DownloadStore.ImageType(body);
        }
        else if (Regex.IsMatch(name, @"^[\w.-]+\.(html|js|css|svg)$") && File.Exists(file))
        {
            body = File.ReadAllBytes(file);
            type = name.EndsWith(".html") ? "text/html; charset=utf-8" : name.EndsWith(".css") ? "text/css" : name.EndsWith(".svg") ? "image/svg+xml" : "text/javascript";
        }
        if (body == null)
        {
            e.Response = environment.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain");
            return;
        }
        e.Response = environment.CreateWebResourceResponse(new MemoryStream(body), 200, "OK", $"Content-Type: {type}\r\nCache-Control: no-store");
    }

    void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var url))
        {
            e.Cancel = true;
            return;
        }
        if (url.Scheme is "about" or "data" || LocalPages.IsLocal(url) || Server.Owns(url))
        {
            navigations[e.NavigationId] = url;
            return;
        }
        // Anything else (an artist's site, MusicBrainz…) opens in the browser.
        e.Cancel = true;
        OpenInBrowser(e.Uri);
    }

    void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        navigations.Remove(e.NavigationId, out var url);
        if (url == null || !Server.Owns(url)) return;
        // The server's there: downloads that didn't finish carry on.
        if (e.IsSuccess) Downloads.Resume();
        // Only a server that didn't answer at all counts (an error page from it is still the server).
        if (e.IsSuccess || e.HttpStatusCode != 0 || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
        Unreachable(url);
    }

    // confirm() / alert() from the pages.
    void OnScriptDialog(object? sender, CoreWebView2ScriptDialogOpeningEventArgs e)
    {
        var deferral = e.GetDeferral();
        BeginInvoke(() =>
        {
            try
            {
                switch (e.Kind)
                {
                    case CoreWebView2ScriptDialogKind.Alert:
                        MessageBox.Show(this, e.Message, "Tuna");
                        break;
                    case CoreWebView2ScriptDialogKind.Confirm:
                        if (MessageBox.Show(this, e.Message, "Tuna", MessageBoxButtons.OKCancel) == DialogResult.OK) e.Accept();
                        break;
                    case CoreWebView2ScriptDialogKind.Beforeunload:
                        e.Accept();
                        break;
                }
            }
            finally
            {
                deferral.Complete();
            }
        });
    }

    void OnAcceleratorKey(object? sender, CoreWebView2AcceleratorKeyPressedEventArgs e)
    {
        if (e.KeyEventKind is not (CoreWebView2KeyEventKind.KeyDown or CoreWebView2KeyEventKind.SystemKeyDown) || e.PhysicalKeyStatus.WasKeyDown != 0) return;
        if ((Keys)e.VirtualKey != Keys.F11) return;
        ToggleFullscreen();
        e.Handled = true;
    }

    // ---------- Window ----------

    /// <summary>Full screen: the window without its frame, covering the whole monitor.</summary>
    public void ToggleFullscreen()
    {
        var style = (long)Native.GetWindowLongPtr(Handle, Native.GWL_STYLE);
        if (!fullscreen)
        {
            var monitor = new Native.MONITORINFO { cbSize = Marshal.SizeOf<Native.MONITORINFO>() };
            placement = new Native.WINDOWPLACEMENT { length = Marshal.SizeOf<Native.WINDOWPLACEMENT>() };
            if (!Native.GetWindowPlacement(Handle, ref placement) || !Native.GetMonitorInfo(Native.MonitorFromWindow(Handle, Native.MONITOR_DEFAULTTONEAREST), ref monitor)) return;
            fullscreen = true;
            Native.SetWindowLongPtr(Handle, Native.GWL_STYLE, (IntPtr)(style & ~Native.WS_OVERLAPPEDWINDOW));
            var r = monitor.rcMonitor;
            Native.SetWindowPos(Handle, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, Native.SWP_NOOWNERZORDER | Native.SWP_FRAMECHANGED);
        }
        else
        {
            fullscreen = false;
            Native.SetWindowLongPtr(Handle, Native.GWL_STYLE, (IntPtr)(style | Native.WS_OVERLAPPEDWINDOW));
            Native.SetWindowPlacement(Handle, ref placement);
            Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOZORDER | Native.SWP_NOOWNERZORDER | Native.SWP_FRAMECHANGED);
        }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (controller != null)
        {
            controller.Bounds = ClientRectangle;
            controller.IsVisible = WindowState != FormWindowState.Minimized;
        }
        if (WindowState == FormWindowState.Normal && !fullscreen) normalBounds = Bounds;
        // (Kept through minimising: the window is often closed from the taskbar.)
        if (WindowState != FormWindowState.Minimized && !fullscreen) maximized = WindowState == FormWindowState.Maximized;
    }

    protected override void OnMove(EventArgs e)
    {
        base.OnMove(e);
        controller?.NotifyParentWindowPositionChanged();
        if (WindowState == FormWindowState.Normal && !fullscreen) normalBounds = Bounds;
    }

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        // Typing goes to the page.
        controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Closing the window while music plays tucks it away on the taskbar, and the music carries on.
        // Closing it from there (or once the music has stopped) quits Tuna.
        if (e.CloseReason == CloseReason.UserClosing && Audio?.Playing == true && WindowState != FormWindowState.Minimized)
        {
            e.Cancel = true;
            if (fullscreen) ToggleFullscreen();
            WindowState = FormWindowState.Minimized;
            return;
        }
        AppData.SaveConfig(c =>
        {
            c["bounds"] = new JsonObject { ["x"] = normalBounds.X, ["y"] = normalBounds.Y, ["width"] = normalBounds.Width, ["height"] = normalBounds.Height };
            c["maximized"] = maximized;
        });
        Hide(); // gone at once, while the rest winds down
        Downloads.Stop();
        Audio?.Dispose();
        Audio = null;
        Tunnel.Stop();
        try { controller?.Close(); } catch { }
        controller = null;
        base.OnFormClosing(e);
    }
}

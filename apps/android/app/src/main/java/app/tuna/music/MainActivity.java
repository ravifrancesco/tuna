package app.tuna.music;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.media.MediaRouter2;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.annotation.RequiresApi;
import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.google.android.gms.cast.CastMediaControlIntent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * Tuna for Android: phones, tablets, Fire TV and Android TV. A full-screen web view of the Tuna
 * server on your network; the app only remembers the server address, everything else comes from
 * the server. The music is the app's own (AudioService): the page hands it the queue and shows
 * what it reports, so it keeps playing with the screen off and after the window has gone.
 * Phones and tablets keep downloads (Downloads) and, with no server, show them on the app's own
 * offline page. The page and the app talk as docs/native-bridge.md says.
 */
public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    private static final String LOADING = "file:///android_asset/loading.html";
    private static final String OFFLINE = Downloads.ORIGIN + "/offline.html";

    /** Windows open (AudioService leaves the tunnel up while there's one). */
    static volatile int open;

    private FrameLayout root;
    private WebView web;
    private Updater updater;
    private Tunnel tunnel;
    /** Phones and tablets only (TVs don't keep downloads). */
    private Downloads downloads;
    private boolean tv;
    /** Chromecasts (phones with Google Play services): looked for while the window is open, harder just after the outputs list opens. */
    private MediaRouter router;
    private MediaRouteSelector chromecasts;
    private final MediaRouter.Callback found = new MediaRouter.Callback() {};
    private final Runnable lookLess = () -> {
        if (router != null && MainActivity.this.visible) router.addCallback(chromecasts, found, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY);
    };
    private volatile String currentUrl = "";
    private boolean forgetHistory;
    private View splash;
    /** On screen: only then does the page hear every tick of the player. */
    private boolean visible;
    /** A page waiting for the file someone's choosing. */
    private ValueCallback<Uri[]> chosen;
    private static final int CHOOSE_FILE = 7;

    private AudioService audio;
    private final List<Consumer<AudioService>> waitingForAudio = new ArrayList<>();
    /** What the player tells this window's page. */
    private final AudioService.Page page = new AudioService.Page() {
        @Override
        public void audio(JSONObject state) {
            if (visible) toPage(message("audio", "state", state));
        }

        @Override
        public void rerouted() {
            tunnel.applyToPage(() -> toPage(event("tunnel", tunnelStatus())));
        }

        @Override
        public void liked(String id, boolean liked) {
            JSONObject value = new JSONObject();
            try {
                value.put("id", id).put("liked", liked);
            } catch (JSONException ignored) {
                // can't happen
            }
            // Out of sight the page may be asleep: it hears when it's back.
            if (visible) toPage(event("liked", value));
            else likedAway.add(value);
        }
    };
    private String downloadsSaid;
    /** Downloads changed: the page (the server's or the offline one) hears, while it's on screen. */
    private final Downloads.Listener downloadsChanged = () -> {
        if (!visible) return;
        // (A file ending and the next one starting often say the same.)
        JSONArray list = downloads.list(offlinePage());
        String said = list.toString();
        if (said.equals(downloadsSaid)) return;
        downloadsSaid = said;
        toPage(event("downloads", list));
    };
    /** Songs liked or unliked on the lock screen while the window was out of sight. */
    private final List<JSONObject> likedAway = new ArrayList<>();
    private final ServiceConnection audioConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            audio = ((AudioService.Local) binder).service();
            audio.setPage(page);
            for (Consumer<AudioService> waiting : waitingForAudio) waiting.accept(audio);
            waitingForAudio.clear();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            audio = null;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        open++;
        tunnel = Tunnel.get(this);
        tv = isTv(this);
        if (AudioService.castable(this)) {
            router = MediaRouter.getInstance(this);
            chromecasts = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                    .build();
        }
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        if (tv) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        } else {
            getWindow().setStatusBarColor(0xff0b0a10);
            getWindow().setNavigationBarColor(0xff0b0a10);
            downloads = Downloads.get(this);
            downloads.setListener(downloadsChanged);
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xff0b0a10);
        setContentView(root);
        buildWebView();
        // The mark on top until the first page has drawn: on a slow TV box the web view takes seconds.
        splash = new View(this);
        splash.setBackgroundResource(R.drawable.splash);
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Whether the on-screen keyboard is open, for Back (see dispatchKeyEvent).
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().getDecorView().setOnApplyWindowInsetsListener((v, insets) -> {
                boolean shown = insets.isVisible(WindowInsets.Type.ime());
                if (keyboardOpen && !shown) keyboardClosedAt = SystemClock.uptimeMillis();
                keyboardOpen = shown;
                return v.onApplyWindowInsets(insets);
            });
        }
        updater = new Updater(this, tv, e -> toPage(event("update", e)));
        bindService(new Intent(this, AudioService.class).setAction(AudioService.ACTION_LOCAL), audioConnection, BIND_AUTO_CREATE);

        String server = server();
        if (server == null) showSetup(null);
        else start(server);
    }

    /** The web view, with what it's allowed to do. Again after its renderer has gone (memory, a crash). */
    private void buildWebView() {
        web = new WebView(this);
        web.setBackgroundColor(0xff0b0a10);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Pages fit the screen as they are: no pinch zoom (Tuna's pages size themselves).
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + (tv ? " TunaTV/" : " TunaAndroid/") + BuildConfig.TUNA_VERSION);

        web.addJavascriptInterface(new Bridge(), "TunaAndroid");
        web.setWebChromeClient(new WebChromeClient() {
            // A page's "choose a file": Android's own picker.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chosen != null) chosen.onReceiveValue(null);
                chosen = callback;
                try {
                    startActivityForResult(new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), CHOOSE_FILE);
                } catch (ActivityNotFoundException e) {
                    // (A TV without a file picker: pasting is the way there.)
                    chosen.onReceiveValue(null);
                    chosen = null;
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Stay on the Tuna server (and the app's own pages).
                if (url.startsWith("file:///android_asset/") || url.startsWith(Downloads.ORIGIN + "/") || Server.owns(url, server())) return false;
                // Anything else opens in the browser, where there is one.
                if (request.isForMainFrame() && (url.startsWith("https://") || url.startsWith("http://"))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                    } catch (ActivityNotFoundException ignored) {
                        // TVs often have no browser
                    }
                }
                return true;
            }

            /** The offline page and its covers, from the app itself. */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (downloads == null || !Downloads.HOST.equals(request.getUrl().getHost())) return null;
                // (For hello(): served at once, its script can ask before onPageStarted has said it's here.)
                if (request.isForMainFrame()) currentUrl = request.getUrl().toString();
                return downloads.serve(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                currentUrl = url;
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                hideSplash(url.startsWith(LOADING));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash(url.startsWith(LOADING));
                if (forgetHistory && !url.startsWith(SETUP) && !url.startsWith(LOADING)) {
                    // Back from the home screen shouldn't land on the setup or loading page again.
                    forgetHistory = false;
                    view.clearHistory();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                String url = request.getUrl().toString();
                if (!request.isForMainFrame() || url.startsWith("file:") || url.startsWith(Downloads.ORIGIN)) return;
                if (downloads != null && downloads.hasSongs()) showOffline();
                else showSetup(getString(R.string.error_server_unreachable, server(), error.getDescription()));
            }

            /** The page's renderer went (Android needed the memory, or it crashed): a new web view, the music untouched. */
            @RequiresApi(Build.VERSION_CODES.O)
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (view != web) return true;
                root.removeView(view);
                view.destroy();
                buildWebView();
                String server = server();
                if (server == null) showSetup(null);
                else start(server);
                return true;
            }
        });
        web.requestFocus();
    }

    /**
     * The loading page while a quick check finds the server (a few seconds at most), then Tuna;
     * with no server, what's downloaded.
     */
    private void start(String server) {
        web.loadUrl(LOADING);
        new Thread(() -> {
            // Away from home, as in Netfish: a ring ahead of the mark on the loading page, then through it.
            Server.Route route = Server.route(server, tunnel, () -> runOnUiThread(() -> loadingSays("connecting")));
            if (route != Server.Route.NONE && downloads != null) downloads.resume();
            runOnUiThread(() -> tunnel.applyToPage(() -> {
                if (isDestroyed()) return;
                if (route == Server.Route.NONE) {
                    if (downloads != null && downloads.hasSongs()) showOffline();
                    else showSetup(getString(R.string.error_server_unreachable, server, getString(R.string.nothing_answered)));
                    return;
                }
                forgetHistory = true; // back never lands on the loading page
                // The mark swims into the tunnel (timed from when the page has it); Tuna (#tunnel) takes it over.
                if (route == Server.Route.AWAY) loadingSays("connected", () -> web.postDelayed(() -> web.loadUrl(server + "/#tunnel"), 900));
                else web.loadUrl(server + "/");
            }));
        }, "tuna-start").start();
    }

    private void loadingSays(String tunnelState) {
        loadingSays(tunnelState, null);
    }

    /** The loading page's tunnel: 'connecting' or 'connected'; then, once the page has it. */
    private void loadingSays(String tunnelState, Runnable then) {
        if (!LOADING.equals(currentUrl)) {
            if (then != null) then.run();
            return;
        }
        web.evaluateJavascript("window.tunaTunnel&&window.tunaTunnel('" + tunnelState + "')", then == null ? null : result -> then.run());
    }

    /**
     * The first page has drawn: the start-up mark goes. Over the loading page, whose mark is in the
     * same place, it lingers a moment so the hand-over can't be seen.
     */
    private void hideSplash(boolean overLoadingPage) {
        if (splash == null) return;
        View gone = splash;
        splash = null;
        gone.animate().alpha(0f).setStartDelay(overLoadingPage ? 300 : 0).setDuration(200)
                .withEndAction(() -> ((ViewGroup) gone.getParent()).removeView(gone));
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != CHOOSE_FILE || chosen == null) return;
        chosen.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        chosen = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // The system's installer, about an update started from Settings.
        if (Updater.ACTION_STATUS.equals(intent.getAction())) updater.onStatus(intent);
    }

    private String server() {
        return Server.address(this);
    }

    /** Fire TV, Android TV (no downloads, no Chromecasts, no vibration). */
    static boolean isTv(Context context) {
        UiModeManager modes = (UiModeManager) context.getSystemService(UI_MODE_SERVICE);
        return modes.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION
                || context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    private void showSetup(String error) {
        web.loadUrl(SETUP + (error != null ? "?error=" + Uri.encode(error) : ""));
    }

    private void showOffline() {
        web.loadUrl(OFFLINE);
    }

    /**
     * The offline page is the one showing. Main thread: the web view itself says, as currentUrl
     * can't always (at start, the loading page's onPageStarted can come after the offline page's script runs).
     */
    private boolean offlinePage() {
        String url = web.getUrl();
        return url != null && url.startsWith(Downloads.ORIGIN + "/");
    }

    // ---------- Back (remote, gesture, Esc) and media keys ----------

    /** Back went down here, not in the on-screen keyboard: only then does letting go of it go back. */
    private boolean backDown;
    /** The on-screen keyboard: open now, or when it last closed (uptime). */
    private boolean keyboardOpen;
    private long keyboardClosedAt;

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        // Esc too, for keyboards (and the emulator): the remote's Back button sends KEYCODE_BACK.
        if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                // The Back that closes the keyboard can reach the app too (Android 16, while the
                // keyboard slides away): it only closes the keyboard.
                backDown = !keyboardOpen && SystemClock.uptimeMillis() - keyboardClosedAt > 700;
                if (keyboardOpen) ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(web.getWindowToken(), 0);
            } else if (event.getAction() == KeyEvent.ACTION_UP) {
                if (backDown && !event.isCanceled()) back();
                backDown = false;
            }
            return true;
        }
        // A remote's or keyboard's media keys: straight to the player, whatever the page is doing.
        String media = mediaKey(code);
        if (media != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && audio != null) {
                if (media.equals("forward")) audio.seekBy(10);
                else if (media.equals("rewind")) audio.seekBy(-10);
                else audio.key(media);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private static String mediaKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return "toggle";
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                return "play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                return "pause";
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                return "next";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                return "previous";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                return "forward";
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                return "rewind";
            default:
                return null;
        }
    }

    /**
     * Back closes whatever is open on top in the page first (Now playing, a menu, a sheet), then goes
     * back a page; on Home it leaves the app, and the music plays on.
     */
    private void back() {
        String closeTop = "(function(){try{if(window.tunaBack)return !!window.tunaBack();"
                + "var l=document.querySelectorAll('[data-layer=\"top\"]');if(!l.length)return false;"
                + "var top=l[l.length-1];(top.querySelector('[data-close]')||top).click();return true}catch(e){return false}})()";
        web.evaluateJavascript(closeTop, handled -> {
            if ("true".equals(handled)) return;
            String url = web.getUrl() == null ? "" : web.getUrl();
            String server = server();
            if (url.startsWith(LOADING) || url.startsWith(Downloads.ORIGIN)) {
                moveTaskToBack(true);
            } else if (url.startsWith(SETUP)) {
                if (server != null && !url.contains("error=")) start(server);
                else moveTaskToBack(true);
            } else if (Server.owns(url, server) && isHome(url)) {
                moveTaskToBack(true);
            } else if (web.canGoBack()) {
                web.goBack();
            } else if (server != null) {
                web.loadUrl(server + "/");
            } else {
                moveTaskToBack(true);
            }
        });
    }

    private static boolean isHome(String url) {
        String path = Uri.parse(url).getPath();
        return path == null || path.isEmpty() || path.equals("/");
    }

    // ---------- Lifecycle: the music isn't the window's ----------

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        web.onResume();
        web.resumeTimers();
        lookLess.run();
        // The page catches up with what played while it was away.
        if (audio != null) {
            JSONObject now = audio.current();
            if (now != null) toPage(message("audio", "state", now.opt("state")));
        }
        for (JSONObject liked : likedAway) toPage(event("liked", liked));
        likedAway.clear();
        if (downloads != null) toPage(event("downloads", downloads.list(offlinePage())));
    }

    @Override
    protected void onStop() {
        super.onStop();
        visible = false;
        if (router != null) {
            web.removeCallbacks(lookLess);
            router.removeCallback(found);
        }
        // Nothing to draw or count while it's out of sight; the music is AudioService's.
        web.onPause();
        web.pauseTimers();
    }

    @Override
    protected void onDestroy() {
        open--;
        // Music playing or songs coming keep the tunnel up; whichever ends last stops it.
        boolean downloading = downloads != null && downloads.busy();
        if (downloads != null) downloads.leave(downloadsChanged);
        if (audio != null) {
            audio.leave(page);
            if (!audio.busy() && !downloading) tunnel.stop();
        } else if (!downloading) {
            tunnel.stop();
        }
        unbindService(audioConnection);
        web.destroy();
        super.onDestroy();
    }

    // ---------- Talking to the page ----------

    private static JSONObject message(String type, String key, Object value) {
        try {
            return new JSONObject().put("type", type).put(key, value == null ? JSONObject.NULL : value);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static JSONObject event(String name, Object value) {
        JSONObject msg = message("event", "value", value);
        try {
            msg.put("name", name);
        } catch (JSONException ignored) {
            // can't happen
        }
        return msg;
    }

    private void reply(int id, Object value) {
        JSONObject msg = message("reply", "value", value);
        try {
            msg.put("id", id);
        } catch (JSONException ignored) {
            // can't happen
        }
        toPage(msg);
    }

    /** window.__tuna(message), on the main thread, only ever to the Tuna server's page (or the offline page). */
    private void toPage(JSONObject msg) {
        String js = "window.__tuna&&window.__tuna(" + msg + ")";
        runOnUiThread(() -> {
            if (web != null && !isDestroyed() && (Server.owns(currentUrl, server()) || offlinePage())) web.evaluateJavascript(js, null);
        });
    }

    /** The system's own list of speakers and headphones (the same one the lock screen's player opens). */
    private void showOutputs() {
        if (router != null) {
            router.addCallback(chromecasts, found, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY | MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
            web.removeCallbacks(lookLess);
            web.postDelayed(lookLess, 30_000);
        }
        if (Build.VERSION.SDK_INT >= 34 && MediaRouter2.getInstance(this).showSystemOutputSwitcher()) return;
        if (Build.VERSION.SDK_INT >= 31) {
            sendBroadcast(new Intent("com.android.systemui.action.LAUNCH_MEDIA_OUTPUT_DIALOG")
                    .setPackage("com.android.systemui")
                    .putExtra("package_name", getPackageName()));
            return;
        }
        try {
            startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS));
        } catch (ActivityNotFoundException ignored) {
            // nowhere to choose
        }
    }

    /** With the player once it's there (it's bound as the window opens). Main thread. */
    private void withAudio(Consumer<AudioService> then) {
        if (audio != null) then.accept(audio);
        else waitingForAudio.add(then);
    }

    private JSONObject tunnelStatus() {
        try {
            JSONObject status = new JSONObject().put("configured", tunnel.configured()).put("active", tunnel.active());
            if (tunnel.problem() != null) status.put("problem", tunnel.problem());
            return status;
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private boolean onMobileData() {
        ConnectivityManager networks = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        NetworkCapabilities now = networks == null ? null : networks.getNetworkCapabilities(networks.getActiveNetwork());
        return now != null && now.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
    }

    /** The streams and covers the page hands over must be the server's own (or songs on the device). */
    private boolean ownTracks(JSONArray tracks, String server) {
        for (int i = 0; tracks != null && i < tracks.length(); i++) {
            JSONObject t = tracks.optJSONObject(i);
            if (t == null) return false;
            if (!Server.owns(t.optString("url"), server) && (downloads == null || downloads.song(t.optString("id")) == null)) return false;
            String artwork = t.optString("artwork", "");
            if (!artwork.isEmpty() && !Server.owns(artwork, server)) t.remove("artwork");
        }
        return tracks != null;
    }

    /**
     * window.TunaAndroid: hello() and post(json) for the Tuna server's pages and the offline page
     * (which only plays and lists downloads); connect() for the setup page.
     */
    private class Bridge {
        private boolean fromServer() {
            return Server.owns(currentUrl, server());
        }

        /** What this app can do (window.tunaHello), read by the page as it starts. */
        @JavascriptInterface
        public String hello() {
            try {
                boolean offline = currentUrl.startsWith(Downloads.ORIGIN + "/");
                JSONArray formats = new JSONArray();
                for (String f : AudioService.FORMATS) formats.put(f);
                JSONArray features = new JSONArray();
                String[] can = offline ? new String[] {"audio"} : new String[] {"audio", "changeServer", "keepAwake", "mobileData", "tunnel", "update"};
                for (String f : can) features.put(f);
                if (!tv && !offline) features.put("outputs");
                if (downloads != null) features.put("downloads");
                if (!offline) features.put("sleep");
                if (!tv && !offline) features.put("haptics");
                if (router != null && !offline) features.put("cast");
                features.put("eq");
                return new JSONObject()
                        .put("platform", tv ? "androidtv" : "android")
                        .put("version", BuildConfig.TUNA_VERSION)
                        .put("formats", formats)
                        .put("features", features)
                        .toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        /** {cmd, args?, id?}: an answer, when there's an id, through window.__tuna({type: "reply", id, value}). */
        @JavascriptInterface
        public void post(String json) {
            JSONObject msg;
            try {
                msg = new JSONObject(json);
            } catch (JSONException e) {
                return;
            }
            String cmd = msg.optString("cmd");
            JSONObject parsed = msg.optJSONObject("args");
            JSONObject args = parsed != null ? parsed : new JSONObject();
            int id = msg.has("id") ? msg.optInt("id") : -1;
            if (fromServer()) {
                handle(cmd, args, id, false);
                return;
            }
            // The offline page plays and lists what's downloaded, and goes back to the server.
            if (!cmd.startsWith("audio.") && !cmd.startsWith("server.") && !cmd.equals("downloads.list")) return;
            runOnUiThread(() -> {
                if (offlinePage()) handle(cmd, args, id, true);
            });
        }

        private void handle(String cmd, JSONObject args, int id, boolean offline) {
            String server = server();
            switch (cmd) {
                case "audio.load": {
                    JSONArray tracks = args.optJSONArray("tracks");
                    if (!ownTracks(tracks, server)) break;
                    int index = args.optInt("index", 0);
                    double start = args.optDouble("start", 0);
                    boolean play = args.optBoolean("play", true);
                    runOnUiThread(() -> withAudio(a -> a.load(tracks, index, Double.isNaN(start) ? 0 : start, play)));
                    break;
                }
                case "audio.update": {
                    JSONArray tracks = args.optJSONArray("tracks");
                    if (!ownTracks(tracks, server)) break;
                    int index = args.optInt("index", 0);
                    runOnUiThread(() -> withAudio(a -> a.update(tracks, index)));
                    break;
                }
                case "audio.command": {
                    String name = args.optString("name");
                    Object value = args.opt("value");
                    runOnUiThread(() -> withAudio(a -> a.command(name, value == JSONObject.NULL ? null : value)));
                    break;
                }
                case "audio.current":
                    runOnUiThread(() -> withAudio(a -> reply(id, a.current())));
                    break;
                case "audio.liked": {
                    String song = args.optString("id");
                    boolean liked = args.optBoolean("liked");
                    runOnUiThread(() -> withAudio(a -> a.liked(song, liked)));
                    break;
                }
                case "audio.outputs":
                    runOnUiThread(MainActivity.this::showOutputs);
                    break;
                case "audio.sleep": {
                    double minutes = args.optDouble("minutes", 0);
                    boolean endOfSong = args.optBoolean("endOfSong");
                    runOnUiThread(() -> withAudio(a -> a.sleep(Double.isNaN(minutes) ? 0 : minutes, endOfSong)));
                    break;
                }
                case "audio.eq":
                    runOnUiThread(() -> withAudio(a -> a.eq(args)));
                    break;
                case "app.haptic": {
                    if (tv) break;
                    boolean success = "success".equals(args.optString("style"));
                    // (A phone's own touch feedback: off when the person has turned it off.)
                    int feel = success ? (Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY)
                            : HapticFeedbackConstants.KEYBOARD_TAP;
                    runOnUiThread(() -> web.performHapticFeedback(feel));
                    break;
                }
                case "changeServer":
                    runOnUiThread(() -> showSetup(null));
                    break;
                case "keepAwake": {
                    boolean on = args.optBoolean("on");
                    runOnUiThread(() -> {
                        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    });
                    break;
                }
                case "mobileData":
                    reply(id, onMobileData());
                    break;
                case "tunnel.status":
                    reply(id, tunnelStatus());
                    break;
                case "tunnel.save": {
                    String config = args.optString("config", "");
                    new Thread(() -> {
                        String problem = tunnel.save(config);
                        reply(id, problem == null ? "" : problem);
                        if (problem == null && server != null) {
                            Server.route(server, tunnel, () -> {});
                            runOnUiThread(() -> tunnel.applyToPage(() -> toPage(event("tunnel", tunnelStatus()))));
                        }
                    }, "tuna-tunnel-save").start();
                    break;
                }
                case "tunnel.remove":
                    tunnel.remove();
                    runOnUiThread(() -> tunnel.applyToPage(() -> {
                        reply(id, null);
                        toPage(event("tunnel", tunnelStatus()));
                    }));
                    break;
                case "update.check":
                    updater.check(status -> reply(id, status));
                    break;
                case "update.install":
                    updater.install();
                    break;
                case "downloads.add": {
                    JSONArray tracks = args.optJSONArray("tracks");
                    if (downloads == null || !ownTracks(tracks, server)) break;
                    if (!Server.owns(args.optString("cover"), server)) args.remove("cover");
                    downloads.add(args);
                    break;
                }
                case "downloads.remove":
                    if (downloads != null) downloads.remove(args.optString("id"));
                    break;
                case "downloads.clear":
                    if (downloads != null) downloads.clear();
                    break;
                case "downloads.list":
                    reply(id, downloads != null ? downloads.list(offline) : new JSONArray());
                    break;
                case "downloads.offline":
                    if (downloads != null) runOnUiThread(MainActivity.this::showOffline);
                    break;
                case "server.reachable":
                    if (server == null) {
                        reply(id, false);
                        break;
                    }
                    new Thread(() -> {
                        boolean up = Server.route(server, tunnel, () -> {}) != Server.Route.NONE;
                        runOnUiThread(() -> tunnel.applyToPage(() -> reply(id, up)));
                    }, "tuna-reachable").start();
                    break;
                case "server.open":
                    if (server == null) break;
                    if (downloads != null) downloads.resume();
                    runOnUiThread(() -> {
                        forgetHistory = true; // back never lands on the offline page
                        web.loadUrl(server + "/");
                    });
                    break;
                default:
                    if (id >= 0) reply(id, null);
                    break;
            }
        }

        // ----- The setup page (file:///android_asset/setup.html) -----

        @JavascriptInterface
        public String currentServer() {
            String server = server();
            return server == null ? "" : server;
        }

        /** Returns "" on success, otherwise what went wrong. Blocks while checking. */
        @JavascriptInterface
        public String connect(String input) {
            if (!currentUrl.startsWith(SETUP)) return getString(R.string.error_not_allowed);
            try {
                String origin = Server.normalize(MainActivity.this, input);
                Server.probe(MainActivity.this, origin);
                Server.prefs(MainActivity.this).edit().putString("server", origin).apply();
                runOnUiThread(() -> start(origin));
                return "";
            } catch (Exception e) {
                return e.getMessage();
            }
        }
    }
}

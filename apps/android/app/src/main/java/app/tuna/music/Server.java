package app.tuna.music;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.CookieManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** The Tuna server: its address (the only thing the app keeps), and whether and how it answers. */
final class Server {
    private Server() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences("tuna", Context.MODE_PRIVATE);
    }

    /** The saved address ("http://192.168.1.10:7778"), or null before the first run's setup. */
    static String address(Context context) {
        return prefs(context).getString("server", null);
    }

    /** Only the server's own pages (and the files they name) may use the app. */
    static boolean owns(String url, String server) {
        return server != null && url != null && (url.equals(server) || url.startsWith(server + "/") || url.startsWith(server + "?"));
    }

    /** "192.168.1.50" → "http://192.168.1.50:7778"; real domains keep their own port. */
    static String normalize(Context context, String input) throws Exception {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) throw new Exception(context.getString(R.string.error_enter_address));
        if (!value.matches("(?i)^https?://.*")) value = "http://" + value;
        Uri uri = Uri.parse(value);
        String host = uri.getHost();
        if (host == null || host.isEmpty()) throw new Exception(context.getString(R.string.error_not_an_address));
        String scheme = uri.getScheme().toLowerCase();
        boolean local = host.matches("^\\d{1,3}(\\.\\d{1,3}){3}$") || host.endsWith(".local") || !host.contains(".");
        int port = uri.getPort();
        if (port == -1 && scheme.equals("http") && local) port = 7778;
        return scheme + "://" + host + (port == -1 ? "" : ":" + port);
    }

    /** Whether anything answers at the server, quickly (through the tunnel when it's on). */
    static boolean reachable(String origin) {
        return reachable(origin, null);
    }

    /** Straight there, never through the tunnel: at home? */
    static boolean reachableDirectly(String origin) {
        return reachable(origin, Proxy.NO_PROXY);
    }

    private static boolean reachable(String origin, Proxy proxy) {
        HttpURLConnection conn = null;
        try {
            URL health = new URL(origin + "/api/health");
            conn = (HttpURLConnection) (proxy != null ? health.openConnection(proxy) : health.openConnection());
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            conn.setUseCaches(false);
            return conn.getResponseCode() > 0;
        } catch (java.io.IOException e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Makes sure the address really is a Tuna server ({"ok":true} at /api/health) before it's saved. */
    static void probe(Context context, String origin) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            int status = conn.getResponseCode();
            InputStream in = status < 400 ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int n; in != null && (n = in.read(buffer)) > 0; ) body.write(buffer, 0, n);
            JSONObject json = new JSONObject(body.toString("UTF-8"));
            if (status >= 400 || !json.optBoolean("ok")) throw new Exception(context.getString(R.string.error_not_tuna, origin));
        } catch (JSONException e) {
            throw new Exception(context.getString(R.string.error_not_tuna, origin));
        } catch (java.io.IOException e) {
            throw new Exception(context.getString(R.string.error_cant_reach, origin, e.getMessage()));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Likes or unlikes a song as whoever is signed in on the page (its cookie), for the heart on
     * the lock screen. Through the tunnel too, when it's up (it's the default proxy then). Off the
     * main thread.
     */
    static boolean like(Context context, String id, boolean on) {
        String server = address(context);
        if (server == null) return false;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(server + "/api/like").openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            String cookie = CookieManager.getInstance().getCookie(server);
            if (cookie != null) conn.setRequestProperty("Cookie", cookie);
            byte[] body = new JSONObject().put("kind", "track").put("id", id).put("on", on).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body);
            }
            return conn.getResponseCode() / 100 == 2;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** How the server answers: directly (at home), through the tunnel (away), or not at all. */
    enum Route { HOME, AWAY, NONE }

    /**
     * Directly when it can, else, away, through the tunnel when there is one, started here
     * (`connecting` first). A tunnel that isn't needed (or doesn't get through) stops. Off the main thread.
     */
    static Route route(String server, Tunnel tunnel, Runnable connecting) {
        if (reachableDirectly(server)) {
            tunnel.stop();
            return Route.HOME;
        }
        if (!tunnel.configured()) return Route.NONE;
        connecting.run();
        if (tunnel.start(server) && reachable(server)) return Route.AWAY;
        tunnel.stop();
        return Route.NONE;
    }
}

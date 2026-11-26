package app.tuna.music;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.webkit.CookieManager;

import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.SessionError;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.ListeningExecutorService;
import com.google.common.util.concurrent.MoreExecutors;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/**
 * Android Auto's browse tree (docs/native-bridge.md, "Android Auto"): Home's mixes, Playlists, Liked
 * songs and Downloads, read from the server as whoever is signed in on the page (its cookie). Songs
 * become NativeTracks as the page would make them, so the queue is the same whoever started it.
 * Lists ("liked", "playlist/<id>", "download/<id>") hold songs "<list>/<song id>"; "mix/<id>" plays.
 */
@OptIn(markerClass = UnstableApi.class)
final class Library {
    static final String ROOT = "root";
    private static final String HOME = "home", PLAYLISTS = "playlists", LIKED = "liked", DOWNLOADS = "downloads";

    /** Songs and where to start, to play. */
    static final class Queue {
        final JSONArray tracks;
        final int index;

        Queue(JSONArray tracks, int index) {
            this.tracks = tracks;
            this.index = index;
        }
    }

    private final Context context;
    private final Downloads downloads;
    private final ListeningExecutorService worker = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor());
    /** Each list's songs as last shown: a tap plays what was on the screen. */
    private final Map<String, List<JSONObject>> shown = new ConcurrentHashMap<>();

    Library(Context context, Downloads downloads) {
        this.context = context.getApplicationContext();
        this.downloads = downloads;
    }

    MediaItem root() {
        return folder(ROOT, "Tuna", null, null, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED);
    }

    ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> children(String parent, int page, int size) {
        return worker.submit(() -> {
            try {
                List<MediaItem> items = items(parent);
                long from = Math.min(items.size(), (long) page * Math.max(1, size));
                return LibraryResult.ofItemList(items.subList((int) from, (int) Math.min(items.size(), from + Math.max(1, size))), null);
            } catch (IOException | JSONException e) {
                return LibraryResult.ofError(SessionError.ERROR_IO);
            }
        });
    }

    /** What a tap plays: a mix, or a list from the song tapped. Null when it's nothing here. */
    ListenableFuture<Queue> play(String id) {
        return worker.submit(() -> {
            if (id.startsWith("mix/")) return new Queue(new JSONArray(tracks(get("/api/mix/" + Uri.encode(id.substring(4))))), 0);
            int slash = id.lastIndexOf('/');
            if (slash < 0) return null;
            String list = id.substring(0, slash), song = id.substring(slash + 1);
            List<JSONObject> songs = shown.get(list);
            if (songs == null) songs = songs(list);
            if (songs == null) return null;
            int index = 0;
            for (int i = 0; i < songs.size(); i++) if (song.equals(songs.get(i).optString("id"))) index = i;
            return new Queue(new JSONArray(songs), index);
        });
    }

    // ---------- The tree ----------

    private List<MediaItem> items(String parent) throws IOException, JSONException {
        List<MediaItem> out = new ArrayList<>();
        if (parent.equals(ROOT)) {
            out.add(folder(HOME, context.getString(R.string.auto_home), null, null, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED));
            out.add(folder(PLAYLISTS, context.getString(R.string.auto_playlists), null, null, MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS));
            out.add(folder(LIKED, context.getString(R.string.auto_liked), null, null, MediaMetadata.MEDIA_TYPE_PLAYLIST));
            out.add(folder(DOWNLOADS, context.getString(R.string.auto_downloads), null, null, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED));
        } else if (parent.equals(HOME)) {
            Me me = me();
            JSONArray rows = new JSONObject(get("/api/home")).optJSONArray("rows");
            for (int r = 0; rows != null && r < rows.length(); r++) {
                JSONObject row = rows.getJSONObject(r);
                JSONArray mixes = "mixes".equals(row.optString("kind")) ? row.optJSONArray("items") : null;
                for (int i = 0; mixes != null && i < mixes.length(); i++) {
                    JSONObject mix = mixes.getJSONObject(i);
                    JSONArray covers = mix.optJSONArray("covers");
                    String art = covers == null || covers.length() == 0 ? null : me.cover(covers.optString(0), 300);
                    out.add(new MediaItem.Builder().setMediaId("mix/" + mix.optString("id")).setMediaMetadata(new MediaMetadata.Builder()
                            .setTitle(mix.optString("title")).setSubtitle(mix.optString("subtitle", null))
                            .setArtworkUri(art == null ? null : Uri.parse(art))
                            .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST).build()).build());
                }
            }
        } else if (parent.equals(PLAYLISTS)) {
            Me me = me();
            JSONArray lists = new JSONArray(get("/api/playlists"));
            for (int i = 0; i < lists.length(); i++) {
                JSONObject p = lists.getJSONObject(i);
                String cover = p.optString("cover", "");
                out.add(folder("playlist/" + p.optString("id"), p.optString("name"), null, cover.isEmpty() ? null : me.cover(cover, 300), MediaMetadata.MEDIA_TYPE_PLAYLIST));
            }
        } else if (parent.equals(DOWNLOADS)) {
            JSONArray kept = downloads.list(false);
            for (int i = 0; i < kept.length(); i++) {
                JSONObject d = kept.getJSONObject(i);
                String cover = d.optString("cover", "");
                out.add(folder("download/" + d.optString("id"), d.optString("title"), d.optString("subtitle", null), cover.isEmpty() ? null : cover, MediaMetadata.MEDIA_TYPE_ALBUM));
            }
        } else {
            List<JSONObject> songs = songs(parent);
            if (songs == null) return out;
            shown.put(parent, songs);
            for (JSONObject t : songs) out.add(song(parent + "/" + t.optString("id"), t));
        }
        return out;
    }

    /** A list's songs as NativeTracks: Liked songs, a playlist or a download. */
    private List<JSONObject> songs(String list) throws IOException, JSONException {
        if (list.equals(LIKED)) return tracks(new JSONObject(get("/api/liked")).optJSONArray("tracks").toString());
        if (list.startsWith("playlist/")) return tracks(new JSONObject(get("/api/playlist/" + Uri.encode(list.substring(9)))).optJSONArray("tracks").toString());
        if (list.startsWith("download/")) {
            JSONArray kept = downloads.list(false);
            for (int i = 0; i < kept.length(); i++) {
                JSONObject d = kept.getJSONObject(i);
                if (!list.substring(9).equals(d.optString("id"))) continue;
                List<JSONObject> out = new ArrayList<>();
                JSONArray tracks = d.optJSONArray("tracks");
                for (int n = 0; tracks != null && n < tracks.length(); n++) out.add(tracks.getJSONObject(n));
                return out;
            }
        }
        return null;
    }

    private static MediaItem folder(String id, String title, String subtitle, String art, int type) {
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(new MediaMetadata.Builder()
                .setTitle(title).setSubtitle(subtitle).setArtworkUri(art == null ? null : Uri.parse(art))
                .setIsBrowsable(true).setIsPlayable(false).setMediaType(type).build()).build();
    }

    private static MediaItem song(String id, JSONObject t) {
        String art = t.optString("artwork", "");
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(new MediaMetadata.Builder()
                .setTitle(t.optString("title")).setArtist(t.optString("artist")).setAlbumTitle(t.optString("album"))
                .setArtworkUri(art.isEmpty() ? null : Uri.parse(art))
                .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC).build()).build();
    }

    // ---------- Songs as the page makes them ----------

    /** The media key and sound quality of whoever is signed in (GET /api/me). */
    private final class Me {
        final String server;
        final String key;
        final String quality;

        Me(String server, JSONObject me) {
            this.server = server;
            key = me.optString("mediaKey");
            JSONObject prefs = me.optJSONObject("prefs");
            String q = prefs == null ? "auto" : prefs.optString("quality", "auto");
            quality = q.equals("auto") ? (onMobileData() ? "normal" : "original") : q;
        }

        String cover(String cover, int size) {
            return server + "/api/cover/" + Uri.encode(cover) + "?s=" + size + "&k=" + Uri.encode(key);
        }

        /** Original plays the file as it is when the player can, else Opus: 256, 160 or 96 kbps. */
        JSONObject track(JSONObject t) throws JSONException {
            String id = t.optString("id");
            boolean raw = quality.equals("original") && Arrays.asList(AudioService.FORMATS).contains(t.optString("suffix").toLowerCase());
            int rate = quality.equals("low") ? 96 : quality.equals("normal") ? 160 : 256;
            JSONObject out = new JSONObject()
                    .put("id", id)
                    .put("url", server + "/api/stream/" + Uri.encode(id) + (raw ? "?f=raw" : "?f=opus&br=" + rate) + "&k=" + Uri.encode(key))
                    .put("title", t.optString("title"))
                    .put("artist", t.optString("artist"))
                    .put("album", t.optString("album"))
                    .put("duration", t.optDouble("duration", 0))
                    .put("liked", t.optBoolean("liked"));
            String cover = t.optString("cover", "");
            if (!cover.isEmpty()) out.put("artwork", cover(cover, 600));
            return out;
        }
    }

    private Me me() throws IOException, JSONException {
        return new Me(Server.address(context), new JSONObject(get("/api/me")));
    }

    private List<JSONObject> tracks(String json) throws IOException, JSONException {
        Me me = me();
        JSONArray list = new JSONArray(json);
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) out.add(me.track(list.getJSONObject(i)));
        return out;
    }

    private boolean onMobileData() {
        ConnectivityManager networks = context.getSystemService(ConnectivityManager.class);
        NetworkCapabilities now = networks == null ? null : networks.getNetworkCapabilities(networks.getActiveNetwork());
        return now != null && now.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
    }

    /** The server's answer, as the page's (its cookie; through the tunnel when it's up). */
    private String get(String path) throws IOException {
        String server = Server.address(context);
        if (server == null) throw new IOException("no server");
        HttpURLConnection conn = (HttpURLConnection) new URL(server + path).openConnection();
        try {
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            String cookie = CookieManager.getInstance().getCookie(server);
            if (cookie != null) conn.setRequestProperty("Cookie", cookie);
            if (conn.getResponseCode() / 100 != 2) throw new IOException("HTTP " + conn.getResponseCode());
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[16384];
                for (int n; (n = in.read(buffer)) != -1; ) body.write(buffer, 0, n);
                return body.toString(StandardCharsets.UTF_8.name());
            }
        } finally {
            conn.disconnect();
        }
    }
}

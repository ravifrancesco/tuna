package app.tuna.music;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.ProtocolException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Downloads (docs/native-bridge.md, "Downloads"): albums, playlists, Liked songs and songs kept in
 * the app's own storage, so they play with no connection at all. One file at a time on its own
 * thread, through the tunnel when it's up (Tunnel's proxy selector). Songs are named by their id
 * and pictures by their address, so what's in two downloads is kept once, and whatever no
 * download needs any more is deleted. downloads.json says what's kept. The offline page
 * (apps/common/offline.html) and its covers are served from ORIGIN, the app's own address.
 */
final class Downloads {
    /** Android's address for an app's own pages: never a real server's. */
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;

    interface Listener {
        /** Something changed (main thread, at most about twice a second). */
        void changed();
    }

    private static Downloads shared;

    static synchronized Downloads get(Context context) {
        if (shared == null) shared = new Downloads(context);
        return shared;
    }

    /** One file to fetch: a song (`song` is its id) or a picture. */
    private static final class Job {
        final String download;
        final String url;
        final String song;
        final File file;
        volatile boolean stop;

        Job(String download, String url, String song, File file) {
            this.download = download;
            this.url = url;
            this.song = song;
            this.file = file;
        }
    }

    private static final int OK = 0, REFUSED = 1, UNREACHABLE = 2;

    private final Context context;
    private final File root;
    private final File songs;
    private final File art;
    private final File manifest;
    /** As the page gave them, newest first. */
    private final List<JSONObject> entries = new ArrayList<>();
    /** The files on the device, songs and pictures, with their sizes. */
    private final Map<File, Long> kept = new HashMap<>();
    /** Files that didn't come: not tried again until resume() or their download is added again. */
    private final Set<File> missed = new HashSet<>();
    private final Map<String, File> pictures = new HashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean working;
    private Job current;
    private Listener listener;
    private long saidAt;
    private boolean saying;

    private Downloads(Context context) {
        this.context = context.getApplicationContext();
        // Kept out of backups: songs are too big for them, and the list is nothing without them.
        root = new File(this.context.getNoBackupFilesDir(), "downloads");
        songs = new File(root, "songs");
        art = new File(root, "art");
        manifest = new File(root, "downloads.json");
        //noinspection ResultOfMethodCallIgnored
        songs.mkdirs();
        //noinspection ResultOfMethodCallIgnored
        art.mkdirs();
        load();
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    /** A window going: it no longer hears (unless a newer one has taken over already). */
    void leave(Listener listener) {
        if (this.listener == listener) this.listener = null;
    }

    // ---------- What's kept ----------

    private synchronized void load() {
        try (InputStream in = new FileInputStream(manifest)) {
            JSONObject saved = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
            JSONArray list = saved.optJSONArray("downloads");
            for (int i = 0; list != null && i < list.length(); i++) entries.add(list.getJSONObject(i));
            JSONObject files = saved.optJSONObject("files");
            for (Iterator<String> names = files == null ? null : files.keys(); names != null && names.hasNext(); ) {
                String name = names.next();
                File f = new File(root, name);
                if (f.isFile() && f.length() == files.optLong(name)) kept.put(f, f.length());
            }
            JSONArray failed = saved.optJSONArray("missed");
            for (int i = 0; failed != null && i < failed.length(); i++) missed.add(new File(root, failed.getString(i)));
        } catch (IOException | JSONException ignored) {
            // nothing downloaded yet
        }
        sweep();
    }

    private synchronized void save() {
        try {
            JSONObject files = new JSONObject();
            for (Map.Entry<File, Long> f : kept.entrySet()) files.put(name(f.getKey()), f.getValue());
            JSONArray failed = new JSONArray();
            for (File f : missed) failed.put(name(f));
            JSONObject saved = new JSONObject().put("downloads", new JSONArray(entries)).put("files", files).put("missed", failed);
            File part = part(manifest);
            try (OutputStream out = new FileOutputStream(part)) {
                out.write(saved.toString().getBytes(StandardCharsets.UTF_8));
            }
            //noinspection ResultOfMethodCallIgnored
            part.renameTo(manifest);
        } catch (IOException | JSONException ignored) {
            // again with the next change
        }
    }

    /** "songs/<id>", "art/<hash>". */
    private String name(File f) {
        return f.getParentFile().getName() + "/" + f.getName();
    }

    private static File part(File f) {
        return new File(f.getPath() + ".part");
    }

    /** Song ids are letters and digits; anything else is hashed. */
    private File songFile(String id) {
        return new File(songs, id.matches("[A-Za-z0-9_-]{1,64}") ? id : hash(id));
    }

    /** A picture by its address without the media key (a new one comes with signing in again). */
    private File pictureFile(String url) {
        File known = pictures.get(url);
        if (known != null) return known;
        Uri u = Uri.parse(url);
        Uri.Builder same = u.buildUpon().clearQuery();
        for (String name : u.getQueryParameterNames()) {
            if (!name.equals("k")) for (String value : u.getQueryParameters(name)) same.appendQueryParameter(name, value);
        }
        File f = new File(art, hash(same.build().toString()));
        pictures.put(url, f);
        return f;
    }

    static String hash(String s) {
        try {
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8))) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            return Integer.toHexString(s.hashCode()); // can't happen
        }
    }

    /** Every file a download needs: its cover, its songs and their pictures. */
    private List<File> files(JSONObject e) {
        List<File> out = new ArrayList<>();
        String cover = e.optString("cover", "");
        if (!cover.isEmpty()) out.add(pictureFile(cover));
        JSONArray tracks = e.optJSONArray("tracks");
        for (int i = 0; tracks != null && i < tracks.length(); i++) {
            JSONObject t = tracks.optJSONObject(i);
            if (t == null) continue;
            out.add(songFile(t.optString("id")));
            String artwork = t.optString("artwork", "");
            if (!artwork.isEmpty()) out.add(pictureFile(artwork));
        }
        return out;
    }

    /** Deletes what no download needs, and stops fetching it. */
    private synchronized void sweep() {
        Set<File> needed = new HashSet<>();
        for (JSONObject e : entries) needed.addAll(files(e));
        kept.keySet().retainAll(needed);
        missed.retainAll(needed);
        if (current != null && !needed.contains(current.file)) current.stop = true;
        for (File dir : new File[] {songs, art}) {
            File[] all = dir.listFiles();
            for (int i = 0; all != null && i < all.length; i++) {
                String name = all[i].getName();
                File whole = name.endsWith(".part") ? new File(dir, name.substring(0, name.length() - 5)) : all[i];
                //noinspection ResultOfMethodCallIgnored
                if (!needed.contains(whole)) all[i].delete();
            }
        }
    }

    private int indexOf(String id) {
        for (int i = 0; i < entries.size(); i++) if (id.equals(entries.get(i).optString("id"))) return i;
        return -1;
    }

    // ---------- What the page asks ----------

    /** downloads.add: kept (in place of one with the same id), and whatever's missing comes. */
    void add(JSONObject d) {
        String id = d.optString("id");
        JSONArray tracks = d.optJSONArray("tracks");
        if (id.isEmpty() || tracks == null) return;
        JSONObject e = new JSONObject();
        try {
            for (String key : new String[] {"id", "kind", "title", "subtitle", "cover"}) if (d.has(key) && !d.isNull(key)) e.put(key, d.get(key));
            e.put("tracks", tracks);
        } catch (JSONException ignored) {
            // can't happen
        }
        synchronized (this) {
            int at = indexOf(id);
            if (at >= 0) entries.set(at, e);
            else entries.add(0, e);
            // What didn't come last time is tried again.
            missed.removeAll(files(e));
            sweep();
            save();
            start();
        }
        changed();
    }

    /** downloads.remove: forgotten, and its files deleted unless another download has them. */
    void remove(String id) {
        synchronized (this) {
            int at = indexOf(id);
            if (at < 0) return;
            entries.remove(at);
            sweep();
            save();
        }
        changed();
    }

    /** downloads.clear */
    void clear() {
        synchronized (this) {
            entries.clear();
            sweep();
            save();
        }
        changed();
    }

    /** The server answers (the app started, or came back to it): what's missing or failed comes now. */
    void resume() {
        synchronized (this) {
            missed.clear();
            if (entries.isEmpty()) return;
            start();
        }
        changed();
    }

    /** NativeDownload[], newest first; `local` (the offline page) adds where each cover is served. */
    synchronized JSONArray list(boolean local) {
        JSONArray out = new JSONArray();
        for (JSONObject e : entries) {
            try {
                String id = e.optString("id");
                JSONObject d = new JSONObject();
                for (String key : new String[] {"id", "kind", "title", "subtitle", "cover"}) if (e.has(key)) d.put(key, e.get(key));
                JSONArray tracks = e.optJSONArray("tracks");
                JSONArray ready = new JSONArray();
                long bytes = 0;
                boolean coming = false;
                for (int i = 0; tracks != null && i < tracks.length(); i++) {
                    String song = tracks.getJSONObject(i).optString("id");
                    File f = songFile(song);
                    Long size = kept.get(f);
                    if (size != null) {
                        ready.put(song);
                        bytes += size;
                    } else if (!missed.contains(f)) {
                        coming = true;
                    }
                }
                String state = tracks == null || ready.length() == tracks.length() ? "done"
                        : current != null && id.equals(current.download) ? "downloading"
                        : coming ? "waiting" : "failed";
                d.put("tracks", tracks).put("ready", ready).put("bytes", bytes).put("state", state);
                String cover = e.optString("cover", "");
                if (local && !cover.isEmpty() && kept.containsKey(pictureFile(cover))) d.put("localCover", ORIGIN + "/art/" + pictureFile(cover).getName());
                out.put(d);
            } catch (JSONException ignored) {
                // a download the page described oddly: left out
            }
        }
        return out;
    }

    /** The song's file, if it's on the device. */
    synchronized File song(String id) {
        File f = songFile(id);
        return kept.containsKey(f) ? f : null;
    }

    /** A picture's file, if it's on the device. */
    synchronized File picture(String url) {
        File f = pictureFile(url);
        return kept.containsKey(f) ? f : null;
    }

    /** Any song on the device (the offline page has something to play). */
    synchronized boolean hasSongs() {
        for (File f : kept.keySet()) if (songs.equals(f.getParentFile())) return true;
        return false;
    }

    /** Fetching (the tunnel stays up for it). */
    synchronized boolean busy() {
        return working;
    }

    // ---------- Fetching ----------

    private synchronized void start() {
        if (working) return;
        working = true;
        worker.execute(this::work);
    }

    /** The oldest download's missing files, its cover first, then each song and its picture. */
    private synchronized Job next() {
        for (int i = entries.size() - 1; i >= 0; i--) {
            JSONObject e = entries.get(i);
            String id = e.optString("id");
            String cover = e.optString("cover", "");
            if (!cover.isEmpty() && wanted(pictureFile(cover))) return new Job(id, cover, null, pictureFile(cover));
            JSONArray tracks = e.optJSONArray("tracks");
            for (int n = 0; tracks != null && n < tracks.length(); n++) {
                JSONObject t = tracks.optJSONObject(n);
                if (t == null) continue;
                File song = songFile(t.optString("id"));
                if (wanted(song)) return new Job(id, t.optString("url"), t.optString("id"), song);
                String artwork = t.optString("artwork", "");
                if (!artwork.isEmpty() && wanted(pictureFile(artwork))) return new Job(id, artwork, null, pictureFile(artwork));
            }
        }
        return null;
    }

    private boolean wanted(File f) {
        return !kept.containsKey(f) && !missed.contains(f);
    }

    private void work() {
        while (true) {
            Job job;
            synchronized (this) {
                job = current = next();
                if (job == null) {
                    working = false;
                    break;
                }
            }
            changed();
            int got = fetch(job);
            synchronized (this) {
                current = null;
                File part = part(job.file);
                if (got == OK && !job.stop && part.renameTo(job.file)) {
                    kept.put(job.file, job.file.length());
                } else {
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    if (!job.stop) missed.add(job.file);
                    // No way through to the server: everything still missing has failed, for now.
                    if (got == UNREACHABLE && !job.stop) {
                        for (JSONObject e : entries) for (File f : files(e)) if (!kept.containsKey(f)) missed.add(f);
                    }
                }
                save();
            }
            changed();
        }
        // Done with the window gone and nothing playing: the tunnel isn't needed any more.
        if (MainActivity.open == 0 && !AudioService.running) Tunnel.get(context).stop();
    }

    /** The file into its .part: OK, REFUSED (the server said no) or UNREACHABLE. */
    private int fetch(Job job) {
        HttpURLConnection conn = null;
        File part = part(job.file);
        try {
            conn = (HttpURLConnection) new URL(job.url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", "Tuna/" + BuildConfig.TUNA_VERSION + " (Android)");
            if (conn.getResponseCode() / 100 != 2) return REFUSED;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[65536];
                for (int n; !job.stop && (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
            }
            return OK;
        } catch (MalformedURLException e) {
            return REFUSED;
        } catch (ProtocolException e) {
            // A converted song comes with an estimated length: ending before it is its end.
            String format = Uri.parse(job.url).getQueryParameter("f");
            return job.song != null && format != null && !format.equals("raw") && part.length() > 0 ? OK : UNREACHABLE;
        } catch (IOException e) {
            return UNREACHABLE;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Tells the listener, at most about twice a second. */
    private void changed() {
        main.post(() -> {
            if (saying) return;
            saying = true;
            main.postDelayed(() -> {
                saying = false;
                saidAt = SystemClock.uptimeMillis();
                if (listener != null) listener.changed();
            }, Math.max(0, saidAt + 500 - SystemClock.uptimeMillis()));
        });
    }

    // ---------- The offline page ----------

    /** ORIGIN/offline.html, and the covers at ORIGIN/art/<name>. */
    WebResourceResponse serve(Uri url) {
        List<String> parts = url.getPathSegments();
        try {
            if (parts.isEmpty() || (parts.size() == 1 && parts.get(0).equals("offline.html"))) {
                return new WebResourceResponse("text/html", "utf-8", context.getAssets().open("offline.html"));
            }
            if (parts.size() == 2 && parts.get(0).equals("art")) {
                File f = new File(art, parts.get(1));
                synchronized (this) {
                    if (!kept.containsKey(f)) return notFound();
                }
                byte[] head = new byte[1];
                try (InputStream peek = new FileInputStream(f)) {
                    //noinspection ResultOfMethodCallIgnored
                    peek.read(head);
                }
                return new WebResourceResponse(head[0] == (byte) 0x89 ? "image/png" : "image/jpeg", null, new FileInputStream(f));
            }
        } catch (IOException ignored) {
            // not there
        }
        return notFound();
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
        return out.toByteArray();
    }
}

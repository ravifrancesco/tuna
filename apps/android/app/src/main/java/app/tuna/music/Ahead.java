package app.tuna.music;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The queue kept ahead (docs/native-bridge.md, "The player"): the next few songs fetched whole into
 * the app's cache, one at a time, so the music carries on through a dropped connection, a switch
 * between home and the tunnel, or a server restart. Files are named by the song's address without
 * the media key (another quality is another file); past the limit (500 MB, TVs 150 MB) the oldest go.
 */
final class Ahead {
    /** A song that didn't come isn't asked for again for this long. */
    private static final long PAUSE = 60_000;

    interface Listener {
        /** The song at `url` is on the device now (main thread). */
        void ready(String url);
    }

    private final File dir;
    private final long limit;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    /** What to fetch, in order (song addresses as the queue has them). */
    private List<String> wanted = new ArrayList<>();
    /** Files to keep whatever their age: the queue's. */
    private Set<File> keep = new HashSet<>();
    private final Map<String, Long> missed = new HashMap<>();
    private boolean working;
    private String fetching;
    private volatile boolean stop;

    Ahead(Context context, long limit, Listener listener) {
        this.limit = limit;
        this.listener = listener;
        dir = new File(context.getCacheDir(), "ahead");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File[] all = dir.listFiles();
        for (int i = 0; all != null && i < all.length; i++) {
            //noinspection ResultOfMethodCallIgnored
            if (all[i].getName().endsWith(".part")) all[i].delete();
        }
    }

    /** The song's file, if it's here (it counts as just used, for the age limit). */
    synchronized File file(String url) {
        File f = fileFor(url);
        if (!f.isFile()) return null;
        //noinspection ResultOfMethodCallIgnored
        f.setLastModified(System.currentTimeMillis());
        return f;
    }

    /** Fetch these (and nothing else); `queue` is every song in the queue, whose files stay. */
    synchronized void want(List<String> urls, Collection<String> queue) {
        keep = new HashSet<>();
        for (String url : queue) keep.add(fileFor(url));
        wanted = new ArrayList<>(urls);
        if (fetching != null && !wanted.contains(fetching)) stop = true;
        if (!working && next() != null) {
            working = true;
            worker.execute(this::work);
        }
    }

    private File fileFor(String url) {
        Uri u = Uri.parse(url);
        Uri.Builder same = u.buildUpon().clearQuery();
        for (String name : u.getQueryParameterNames()) {
            if (!name.equals("k") && !name.equals("dl")) for (String value : u.getQueryParameters(name)) same.appendQueryParameter(name, value);
        }
        return new File(dir, Downloads.hash(same.build().toString()));
    }

    private String next() {
        long now = System.currentTimeMillis();
        for (String url : wanted) {
            Long failed = missed.get(url);
            if (!fileFor(url).isFile() && (failed == null || now - failed > PAUSE)) return url;
        }
        return null;
    }

    private void work() {
        while (true) {
            String url;
            synchronized (this) {
                url = fetching = next();
                stop = false;
                if (url == null) {
                    working = false;
                    return;
                }
            }
            File file = fileFor(url);
            File part = new File(file.getPath() + ".part");
            boolean got = fetch(url, part);
            boolean ready;
            synchronized (this) {
                fetching = null;
                ready = got && !stop && part.renameTo(file);
                if (ready) {
                    trim();
                } else {
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    if (!stop) missed.put(url, System.currentTimeMillis());
                }
            }
            if (ready) main.post(() -> listener.ready(url));
        }
    }

    /** The whole song into `part` (`&dl=1`: fetching it isn't playing it). */
    private boolean fetch(String url, File part) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url + (url.contains("?") ? "&" : "?") + "dl=1").openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", "Tuna/" + BuildConfig.TUNA_VERSION + " (Android)");
            if (conn.getResponseCode() / 100 != 2) return false;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[65536];
                for (int n; !stop && (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
            }
            return part.length() > 0;
        } catch (IOException e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Oldest first, down to the limit, never the queue's own. */
    private void trim() {
        File[] all = dir.listFiles();
        if (all == null) return;
        long total = 0;
        for (File f : all) total += f.length();
        if (total <= limit) return;
        Arrays.sort(all, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : all) {
            if (total <= limit) break;
            if (keep.contains(f) || f.getName().endsWith(".part")) continue;
            total -= f.length();
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }
}

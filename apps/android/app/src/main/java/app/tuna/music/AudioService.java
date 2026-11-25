package app.tuna.music;

import android.app.NotificationManager;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * The player: the queue the page hands over (docs/native-bridge.md), played by ExoPlayer in a
 * media session, so the notification, the lock screen, headset and Bluetooth buttons and TV
 * remotes all work, and the music carries on when the window is gone. Downloaded songs play
 * from the device (Downloads). The page hears what happens through Page (MainActivity), and
 * asks for it all again (audio.current) when it reloads. Everything here runs on the main thread.
 */
@OptIn(markerClass = UnstableApi.class)
public final class AudioService extends MediaSessionService {
    private static final String TAG = "TunaAudio";
    /** MainActivity binds with this action to talk to the player directly. */
    static final String ACTION_LOCAL = "app.tuna.music.AUDIO";
    /** The heart beside the lock screen's controls. */
    private static final SessionCommand LIKE = new SessionCommand("app.tuna.music.LIKE", Bundle.EMPTY);
    /** The player is there (downloads leave the tunnel to it when they finish). */
    static volatile boolean running;

    /** Where the page hears from the player (MainActivity, while it's open). */
    interface Page {
        void audio(JSONObject state);

        /** Home or away changed with the network (the tunnel on or off). */
        void rerouted();

        /** A song liked or unliked with the heart on the lock screen (the server knows already). */
        void liked(String id, boolean liked);
    }

    final class Local extends Binder {
        AudioService service() {
            return AudioService.this;
        }
    }

    private final Local local = new Local();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private MediaSession session;
    private Page page;
    private Downloads downloads;
    private ConnectivityManager.NetworkCallback networkCallback;
    /** The tracks as the page last loaded or updated them, in the player's order. */
    private final List<JSONObject> queue = new ArrayList<>();
    /** What went wrong, said once with the next state. */
    private String error;
    /** Songs that failed in a row: when all of them have, it stops trying. */
    private int failures;
    /** The connection dropped: it tries again when the network comes back. */
    private boolean waitingForNetwork;
    private String lastSaid;
    /** Whether the heart on the lock screen is full, as last shown (null: not shown yet). */
    private Boolean heartShown;
    private AudioManager sound;
    private AudioDeviceCallback devices;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            push();
            if (player != null && player.isPlaying()) handler.postDelayed(this, 1000);
        }
    };

    private final Runnable skip = () -> {
        if (player == null || !player.hasNextMediaItem()) return;
        player.seekToNextMediaItem();
        player.prepare();
    };

    private final Runnable retry = () -> {
        if (player != null && waitingForNetwork && player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
    };

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        downloads = Downloads.get(this);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("Tuna/" + BuildConfig.TUNA_VERSION + " (Android)")
                .setAllowCrossProtocolRedirects(true);
        // Seeking in converted MP3s too (no index in a file that's still being made).
        DefaultExtractorsFactory extractors = new DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true);
        DefaultMediaSourceFactory sources = new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http), extractors)
                // A dropped connection gets a few more tries (time for the tunnel to come up).
                .setLoadErrorHandlingPolicy(new DefaultLoadErrorHandlingPolicy(8));
        // The device's own decoders first; FFmpeg (inside the app) for what it can't decode (ALAC…).
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
                .setEnableDecoderFallback(true);
        AudioAttributes music = new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build();
        player = new ExoPlayer.Builder(this, renderers)
                .setMediaSourceFactory(sources)
                // Calls and other apps' sound pause it (and resume it when the system says so).
                .setAudioAttributes(music, true)
                // Headphones unplugged: pause.
                .setHandleAudioBecomingNoisy(true)
                // Screen off: keep the processor and Wi-Fi going while it plays.
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onEvents(@NonNull Player p, @NonNull Player.Events events) {
                push();
            }

            @Override
            public void onIsPlayingChanged(boolean playing) {
                handler.removeCallbacks(tick);
                if (playing) {
                    failures = 0;
                    waitingForNetwork = false;
                    handler.postDelayed(tick, 1000);
                }
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException e) {
                failed(e);
            }
        });

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaSession.Builder(this, player)
                .setSessionActivity(tap)
                .setCallback(new MediaSession.Callback() {
                    // The queue is the page's: other apps and devices can play, pause, skip and seek, not rearrange it.
                    @NonNull
                    @Override
                    public MediaSession.ConnectionResult onConnect(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller) {
                        Player.Commands commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                                .remove(Player.COMMAND_SET_SHUFFLE_MODE)
                                .remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
                                .remove(Player.COMMAND_SET_MEDIA_ITEM)
                                .build();
                        return new MediaSession.ConnectionResult.AcceptedResultBuilder(s)
                                .setAvailablePlayerCommands(commands)
                                .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon().add(LIKE).build())
                                .setMediaButtonPreferences(buttons())
                                .build();
                    }

                    @NonNull
                    @Override
                    public ListenableFuture<SessionResult> onCustomCommand(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller,
                            @NonNull SessionCommand command, @NonNull Bundle args) {
                        if (LIKE.customAction.equals(command.customAction)) like();
                        return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
                    }
                })
                .build();
        DefaultMediaNotificationProvider notification = new DefaultMediaNotificationProvider.Builder(this)
                .setChannelName(R.string.playing_channel)
                .build();
        notification.setSmallIcon(R.drawable.ic_note);
        setMediaNotificationProvider(notification);
        addSession(session);

        // Headphones, Bluetooth, a car: the page shows where the sound goes.
        sound = getSystemService(AudioManager.class);
        if (sound != null) {
            devices = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                    push();
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                    push();
                }
            };
            sound.registerAudioDeviceCallback(devices, handler);
        }

        // Leaving home with the music on (Wi-Fi to mobile data): the tunnel takes over, and back.
        ConnectivityManager networks = getSystemService(ConnectivityManager.class);
        if (networks != null) {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    reroute();
                }
            };
            networks.registerDefaultNetworkCallback(networkCallback);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(@Nullable Intent intent) {
        IBinder binder = super.onBind(intent);
        return intent != null && ACTION_LOCAL.equals(intent.getAction()) ? local : binder;
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controller) {
        return session;
    }

    // Swiped away from Recents: Media3's own onTaskRemoved keeps the music going if it's playing,
    // else it stops the service.

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        ConnectivityManager networks = getSystemService(ConnectivityManager.class);
        if (networks != null && networkCallback != null) networks.unregisterNetworkCallback(networkCallback);
        if (sound != null && devices != null) sound.unregisterAudioDeviceCallback(devices);
        player.release();
        session.release();
        session = null;
        player = null;
        page = null;
        // A paused song's notification would stay behind, its buttons dead.
        NotificationManager notices = getSystemService(NotificationManager.class);
        if (notices != null) notices.cancel(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID);
        running = false;
        if (MainActivity.open == 0 && !downloads.busy()) Tunnel.get(this).stop();
        super.onDestroy();
    }

    void setPage(Page page) {
        this.page = page;
    }

    /** A window going: it no longer hears (unless a newer one has taken over already). */
    void leave(Page page) {
        if (this.page == page) this.page = null;
    }

    /** Playing (or about to): the music shouldn't stop for anything else the app does. */
    boolean busy() {
        return player != null && player.getMediaItemCount() > 0 && player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED;
    }

    // ---------- What the page asks ----------

    /** audio.load: a new queue, from `index`, `start` seconds in, playing or not. */
    void load(JSONArray tracks, int index, double start, boolean play) {
        handler.removeCallbacks(skip);
        handler.removeCallbacks(retry);
        queue.clear();
        queue.addAll(list(tracks));
        error = null;
        failures = 0;
        waitingForNetwork = false;
        if (queue.isEmpty()) {
            stop();
            return;
        }
        int i = Math.max(0, Math.min(index, queue.size() - 1));
        player.setMediaItems(items(queue, 0, queue.size()), i, Math.max(0, (long) (start * 1000)));
        if (play) {
            player.prepare();
            player.play();
        } else {
            // Ready where it was, nothing fetched (and no notification) until it's played.
            player.pause();
            player.stop();
        }
        push();
    }

    /**
     * audio.update: a new queue around the song that's playing, which carries on without a gap.
     * Everything around it is swapped. If the page's idea of "now" is a song behind (the player
     * has just moved on), the song really playing is found in the new queue instead.
     */
    void update(JSONArray tracks, int index) {
        List<JSONObject> next = list(tracks);
        if (queue.isEmpty() || player.getMediaItemCount() == 0 || next.isEmpty()) {
            load(tracks, index, 0, false);
            return;
        }
        handler.removeCallbacks(skip);
        int now = player.getCurrentMediaItemIndex();
        int around = Math.max(0, Math.min(index, next.size() - 1));
        String playing = now < queue.size() ? queue.get(now).optString("id") : next.get(around).optString("id");
        int keep = find(next, playing, around);
        int count = player.getMediaItemCount();
        if (now + 1 < count) player.removeMediaItems(now + 1, count);
        if (now > 0) player.removeMediaItems(0, now);
        if (keep > 0) player.addMediaItems(0, items(next, 0, keep));
        if (keep + 1 < next.size()) player.addMediaItems(items(next, keep + 1, next.size()));
        queue.clear();
        queue.addAll(next);
        push();
    }

    /** Where `id` is in `tracks`: at `around` if it's there, else the nearest. */
    private static int find(List<JSONObject> tracks, String id, int around) {
        if (id.equals(tracks.get(around).optString("id"))) return around;
        for (int d = 1; d < tracks.size(); d++) {
            if (around + d < tracks.size() && id.equals(tracks.get(around + d).optString("id"))) return around + d;
            if (around - d >= 0 && id.equals(tracks.get(around - d).optString("id"))) return around - d;
        }
        return around;
    }

    /** audio.command: play, pause, toggle, next, previous, seek, jump, stop, repeat, volume. */
    void command(String name, Object value) {
        if (player == null) return;
        switch (name) {
            case "play":
                play();
                break;
            case "pause":
                player.pause();
                break;
            case "toggle":
                if (playing()) player.pause();
                else play();
                break;
            case "next":
                if (player.hasNextMediaItem()) {
                    handler.removeCallbacks(skip);
                    player.seekToNextMediaItem();
                    resume();
                }
                break;
            case "previous":
                handler.removeCallbacks(skip);
                // More than 3 seconds in (or the first song): from the start again.
                if (player.getCurrentPosition() > 3000 || player.getCurrentMediaItemIndex() == 0 || !player.hasPreviousMediaItem()) player.seekTo(0);
                else player.seekToPreviousMediaItem();
                resume();
                break;
            case "seek":
                if (value instanceof Number) player.seekTo(Math.max(0, (long) (((Number) value).doubleValue() * 1000)));
                break;
            case "jump":
                if (value instanceof Number) {
                    int i = ((Number) value).intValue();
                    if (i < 0 || i >= player.getMediaItemCount()) break;
                    handler.removeCallbacks(skip);
                    player.seekTo(i, 0);
                    play();
                }
                break;
            case "stop":
                stop();
                break;
            case "repeat":
                player.setRepeatMode("one".equals(value) ? Player.REPEAT_MODE_ONE : "all".equals(value) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
                break;
            case "volume":
                if (value instanceof Number) player.setVolume((float) Math.max(0, Math.min(1, ((Number) value).doubleValue())));
                break;
            default:
                break;
        }
    }

    /** audio.liked from the page, or the heart here: every copy of the song in the queue, and the heart. */
    void liked(String id, boolean on) {
        for (JSONObject t : queue) {
            if (!id.equals(t.optString("id"))) continue;
            try {
                t.put("liked", on);
            } catch (JSONException ignored) {
                // can't happen
            }
        }
        heart();
    }

    /** The heart on the lock screen: the server is told straight away (the page may be asleep). */
    private void like() {
        int i = player == null ? -1 : player.getCurrentMediaItemIndex();
        if (i < 0 || i >= queue.size()) return;
        String id = queue.get(i).optString("id");
        boolean on = !queue.get(i).optBoolean("liked");
        liked(id, on);
        if (page != null) page.liked(id, on);
        new Thread(() -> {
            if (Server.like(this, id, on)) return;
            handler.post(() -> {
                liked(id, !on);
                if (page != null) page.liked(id, !on);
            });
        }, "tuna-like").start();
    }

    private boolean currentLiked() {
        int i = player == null || queue.isEmpty() ? -1 : player.getCurrentMediaItemIndex();
        return i >= 0 && i < queue.size() && queue.get(i).optBoolean("liked");
    }

    /** The one button beside play, previous and next: the heart, full when the song is liked. */
    private ImmutableList<CommandButton> buttons() {
        if (queue.isEmpty()) return ImmutableList.of();
        boolean on = currentLiked();
        return ImmutableList.of(new CommandButton.Builder(on ? CommandButton.ICON_HEART_FILLED : CommandButton.ICON_HEART_UNFILLED)
                .setDisplayName(getString(on ? R.string.unlike : R.string.like))
                .setSessionCommand(LIKE)
                .build());
    }

    private void heart() {
        if (session == null) return;
        Boolean now = queue.isEmpty() ? null : currentLiked();
        if (now == null ? heartShown == null : now.equals(heartShown)) return;
        heartShown = now;
        session.setMediaButtonPreferences(buttons());
    }

    /** Media keys on a remote or keyboard while the window is open. */
    void key(String name) {
        if (!queue.isEmpty()) command(name, null);
    }

    void seekBy(double seconds) {
        if (queue.isEmpty()) return;
        long to = player.getCurrentPosition() + (long) (seconds * 1000);
        long duration = player.getDuration();
        player.seekTo(Math.max(0, duration == C.TIME_UNSET ? to : Math.min(to, duration)));
    }

    /** audio.current: {tracks, index, state}, or null when nothing's queued. */
    JSONObject current() {
        if (player == null || queue.isEmpty()) return null;
        try {
            return new JSONObject().put("tracks", new JSONArray(queue)).put("index", player.getCurrentMediaItemIndex()).put("state", state());
        } catch (JSONException e) {
            return null;
        }
    }

    private void play() {
        if (queue.isEmpty()) return;
        // The queue had finished: the last song again, from the start.
        if (player.getPlaybackState() == Player.STATE_ENDED) player.seekToDefaultPosition();
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        player.play();
    }

    /** After a skip: an idle player (it was never played, or a song failed) gets going again. */
    private void resume() {
        if (player.getPlaybackState() == Player.STATE_IDLE && player.getPlayWhenReady()) player.prepare();
    }

    private void stop() {
        handler.removeCallbacks(skip);
        handler.removeCallbacks(retry);
        player.stop();
        player.clearMediaItems();
        queue.clear();
        push();
    }

    // ---------- When a song fails ----------

    private void failed(PlaybackException e) {
        Log.w(TAG, "can't play: " + e.getErrorCodeName());
        error = e.getErrorCodeName();
        boolean network = e.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || e.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT;
        push();
        if (network && online()) {
            // Not the song's fault: the same song again once there's a way through.
            waitingForNetwork = true;
            handler.postDelayed(retry, 5000);
        } else if (++failures < queue.size() && player.hasNextMediaItem()) {
            // A song that can't be played: on to the next one.
            handler.postDelayed(skip, 600);
        }
    }

    /** Any connection at all: with none, a song that isn't downloaded is skipped, not waited for. */
    private boolean online() {
        ConnectivityManager networks = getSystemService(ConnectivityManager.class);
        return networks == null || networks.getActiveNetwork() != null;
    }

    private void reroute() {
        String server = Server.address(this);
        Tunnel tunnel = Tunnel.get(this);
        if (server == null) return;
        new Thread(() -> {
            if (tunnel.configured()) Server.route(server, tunnel, () -> {});
            handler.post(() -> {
                if (player == null) return;
                if (page != null) page.rerouted();
                if (waitingForNetwork) {
                    handler.removeCallbacks(retry);
                    handler.postDelayed(retry, 500);
                }
            });
        }, "tuna-route").start();
    }

    // ---------- Telling the page ----------

    private boolean playing() {
        int state = player.getPlaybackState();
        return player.getPlayWhenReady() && player.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE
                && state != Player.STATE_ENDED && state != Player.STATE_IDLE;
    }

    /** {index, playing, buffering?, time, duration, ended?, error?, repeat}. */
    private JSONObject state() throws JSONException {
        JSONObject state = new JSONObject();
        int index = queue.isEmpty() ? -1 : player.getCurrentMediaItemIndex();
        int playback = player.getPlaybackState();
        state.put("index", index);
        state.put("playing", playing());
        if (playback == Player.STATE_BUFFERING) state.put("buffering", true);
        state.put("time", Math.max(0, player.getCurrentPosition()) / 1000.0);
        // The library's own length first: a converted stream's is only an estimate.
        double duration = index >= 0 && index < queue.size() ? queue.get(index).optDouble("duration", 0) : 0;
        if (!(duration > 0) && player.getDuration() != C.TIME_UNSET) duration = player.getDuration() / 1000.0;
        state.put("duration", duration);
        if (playback == Player.STATE_ENDED && index >= 0) state.put("ended", true);
        if (error != null) state.put("error", error);
        int repeat = player.getRepeatMode();
        state.put("repeat", repeat == Player.REPEAT_MODE_ONE ? "one" : repeat == Player.REPEAT_MODE_ALL ? "all" : "off");
        state.put("output", output());
        return state;
    }

    /** Where the sound comes out: {name, kind}, as NativeOutput. */
    private JSONObject output() throws JSONException {
        AudioDeviceInfo device = null;
        if (sound != null && Build.VERSION.SDK_INT >= 33) {
            android.media.AudioAttributes media = new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).build();
            List<AudioDeviceInfo> now = sound.getAudioDevicesForAttributes(media);
            if (!now.isEmpty()) device = now.get(0);
        } else if (sound != null) {
            // Older Android doesn't say which: the one music goes to first.
            int best = -1;
            for (AudioDeviceInfo d : sound.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                int rank = rank(d.getType());
                if (rank > best) {
                    best = rank;
                    device = d;
                }
            }
        }
        String kind = device == null ? "phone" : kind(device.getType());
        CharSequence product = device == null ? null : device.getProductName();
        String name = "phone".equals(kind) || product == null || product.length() == 0 ? Build.MODEL : product.toString();
        return new JSONObject().put("name", name).put("kind", kind);
    }

    private static String kind(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE:
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "phone";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
                return "headphones";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                return "bluetooth";
            case AudioDeviceInfo.TYPE_HDMI:
            case AudioDeviceInfo.TYPE_HDMI_ARC:
            case AudioDeviceInfo.TYPE_HDMI_EARC:
                return "tv";
            default:
                return "speaker";
        }
    }

    private static int rank(int type) {
        switch (kind(type)) {
            case "bluetooth":
                return 4;
            case "headphones":
                return 3;
            case "tv":
                return 2;
            case "speaker":
                return 1;
            default:
                return 0;
        }
    }

    private void push() {
        if (player == null) return;
        heart();
        JSONObject state;
        try {
            state = state();
        } catch (JSONException e) {
            return;
        }
        error = null;
        // (Several of the player's events can come together, each saying the same.)
        String said = state.toString();
        if (said.equals(lastSaid)) return;
        lastSaid = said;
        if (page != null) page.audio(state);
    }

    private static List<JSONObject> list(JSONArray tracks) {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; tracks != null && i < tracks.length(); i++) {
            JSONObject t = tracks.optJSONObject(i);
            if (t != null) out.add(t);
        }
        return out;
    }

    private List<MediaItem> items(List<JSONObject> tracks, int from, int to) {
        List<MediaItem> out = new ArrayList<>();
        for (int i = from; i < to; i++) out.add(item(tracks.get(i)));
        return out;
    }

    /** A NativeTrack as ExoPlayer and the lock screen see it: from the device when it's downloaded. */
    private MediaItem item(JSONObject t) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .setTitle(t.optString("title"))
                .setArtist(t.optString("artist"))
                .setAlbumTitle(t.optString("album"))
                .setIsPlayable(true)
                .setIsBrowsable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC);
        String artwork = t.optString("artwork", "");
        File picture = artwork.isEmpty() ? null : downloads.picture(artwork);
        if (picture != null) meta.setArtworkUri(Uri.fromFile(picture));
        else if (artwork.startsWith("http")) meta.setArtworkUri(Uri.parse(artwork));
        double duration = t.optDouble("duration", 0);
        if (duration > 0) meta.setDurationMs((long) (duration * 1000));
        File song = downloads.song(t.optString("id"));
        Uri uri = song != null ? Uri.fromFile(song) : Uri.parse(t.optString("url"));
        return new MediaItem.Builder().setMediaId(t.optString("id")).setUri(uri).setMediaMetadata(meta.build()).build();
    }
}

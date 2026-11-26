package app.tuna.music;

import android.app.NotificationManager;
import android.content.Context;
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
import androidx.media3.cast.CastPlayer;
import androidx.media3.cast.DefaultMediaItemConverter;
import androidx.media3.cast.SessionAvailabilityListener;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionError;
import androidx.media3.session.SessionResult;

import com.google.android.gms.cast.CastDevice;
import com.google.android.gms.cast.SessionState;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionTransferCallback;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The player: the queue the page hands over (docs/native-bridge.md), played by ExoPlayer in a
 * media session, so the notification, the lock screen, headset and Bluetooth buttons and TV
 * remotes all work, and the music carries on when the window is gone. Downloaded songs play
 * from the device (Downloads), and so do the next few, fetched ahead (Ahead). In the car it's a
 * media app with lists to play from (Library); picked in the output switcher, a Chromecast takes
 * the queue over (CastPlayer). The page hears what happens through Page (MainActivity), and
 * asks for it all again (audio.current) when it reloads. Everything here runs on the main thread.
 */
@OptIn(markerClass = UnstableApi.class)
public final class AudioService extends MediaLibraryService {
    private static final String TAG = "TunaAudio";
    /** MainActivity binds with this action to talk to the player directly. */
    static final String ACTION_LOCAL = "app.tuna.music.AUDIO";
    /** What ExoPlayer plays as it is (with FFmpeg inside the app); the server converts anything else. */
    static final String[] FORMATS = {"mp3", "aac", "m4a", "flac", "alac", "wav", "opus", "ogg"};
    /** The heart beside the lock screen's controls. */
    private static final SessionCommand LIKE = new SessionCommand("app.tuna.music.LIKE", Bundle.EMPTY);
    /** A song from the car's lists, as the page would have handed it over. */
    private static final String TRACK = "app.tuna.music.TRACK";
    /** Songs kept ahead (on mobile data too: the sound quality is the person's choice). */
    private static final int AHEAD = 5;
    /** A long queue goes to the Chromecast this many songs at a time, and more as it gets there. */
    private static final int CAST_WINDOW = 50, CAST_MORE = 10;
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
    /** The phone's own player; the Chromecast's (phones with Google Play services); the one playing now. */
    private ExoPlayer exo;
    /** In the phone's own player (a Chromecast plays as it is), as the page last set it. */
    private final Equalizer equalizer = new Equalizer();
    private CastPlayer cast;
    private Player player;
    private CastContext castContext;
    /** Casting: the queue's songs from castFrom to castTo are on the Chromecast. */
    private int castFrom, castTo;
    /** Casting: where the song playing is in a queue the Chromecast hasn't taken yet (-1: it has). */
    private int castSettling = -1;
    /** Back to the phone from the output switcher: the music carries on here (a Chromecast that went leaves it paused). */
    private boolean backHere, castWasPlaying;
    private MediaLibrarySession session;
    private Page page;
    private Downloads downloads;
    private Ahead ahead;
    /** The song whose having loaded started the fetching ahead (-1: none). */
    private int aheadOf = -1;
    /** The queue is being swapped around the song playing (audio.update). */
    private boolean editing;
    private Library library;
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
    /** The sleep timer: when it stops the music (ms since 1970, 0: not set), or at the end of the song. */
    private long sleepAt;
    private boolean sleepEndOfSong;

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

    private final Runnable sleepDue = new Runnable() {
        @Override
        public void run() {
            if (player == null || sleepAt == 0) return;
            // (The handler's clock stops while the phone sleeps: the timer goes by the real one.)
            long left = sleepAt - System.currentTimeMillis();
            if (left > 500) {
                handler.postDelayed(this, left);
                return;
            }
            player.pause();
            sleep(0, false);
        }
    };

    private final Runnable settled = () -> {
        castSettling = -1;
        push();
    };

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onEvents(@NonNull Player p, @NonNull Player.Events events) {
            if (p != player) return;
            if (events.containsAny(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED)) {
                if (p == cast && castSettling >= 0 && cast.getMediaItemCount() == castTo - castFrom) settled.run();
                ahead();
                castMore();
            }
            // The queue played to its end: nothing left for the sleep timer to stop.
            if (sleepEndOfSong && p.getPlaybackState() == Player.STATE_ENDED) sleep(0, false);
            push();
        }

        @Override
        public void onIsPlayingChanged(boolean playing) {
            handler.removeCallbacks(tick);
            if (player != null && player.isPlaying()) {
                failures = 0;
                waitingForNetwork = false;
                handler.postDelayed(tick, 1000);
            }
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            // The sleep timer, at the end of the song: on to the next one, paused at its start (or the end, after the last).
            if (reason != Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM || player != exo || !sleepEndOfSong) return;
            sleep(0, false);
            if (exo.hasNextMediaItem()) exo.seekToNextMediaItem();
            else if (exo.getRepeatMode() == Player.REPEAT_MODE_OFF) exo.play();
            else exo.seekTo(0);
        }

        @Override
        public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
            // The same on a Chromecast, which can't stop at the end of a song: paused as the next one starts.
            if (player != cast || !sleepEndOfSong) return;
            if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) return;
            cast.pause();
            cast.seekTo(cast.getCurrentMediaItemIndex(), 0);
            sleep(0, false);
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException e) {
            failed(e);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        downloads = Downloads.get(this);
        // (TVs have little room: Fire TV Sticks.)
        ahead = new Ahead(this, MainActivity.isTv(this) ? 150L << 20 : 500L << 20, this::fetched);
        library = new Library(this, downloads);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("Tuna/" + BuildConfig.TUNA_VERSION + " (Android)")
                .setAllowCrossProtocolRedirects(true);
        // Seeking in converted MP3s too (no index in a file that's still being made).
        DefaultExtractorsFactory extractors = new DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true);
        DefaultMediaSourceFactory sources = new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http), extractors)
                // A dropped connection gets a few more tries (time for the tunnel to come up).
                .setLoadErrorHandlingPolicy(new DefaultLoadErrorHandlingPolicy(8));
        // The device's own decoders first; FFmpeg (inside the app) for what it can't decode (ALAC…);
        // the equalizer after either. (16-bit output, as by default: with float output ExoPlayer
        // leaves its processors out for high-resolution files.)
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this) {
            @Override
            protected AudioSink buildAudioSink(@NonNull Context context, boolean floatOutput, boolean playbackParams) {
                return new DefaultAudioSink.Builder(context).setAudioProcessors(new AudioProcessor[] {equalizer}).build();
            }
        }
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
                .setEnableDecoderFallback(true);
        // As the page last set it, so music started without it (the car, the lock screen) sounds the same.
        try {
            equalize(new JSONObject(Server.prefs(this).getString("eq", "{}")));
        } catch (JSONException ignored) {
            // nothing kept
        }
        AudioAttributes music = new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build();
        // (A playlist: the next song is loaded ahead and follows without a gap.)
        exo = new ExoPlayer.Builder(this, renderers)
                .setMediaSourceFactory(sources)
                // Calls and other apps' sound pause it (and resume it when the system says so).
                .setAudioAttributes(music, true)
                // Headphones unplugged: pause.
                .setHandleAudioBecomingNoisy(true)
                // Screen off: keep the processor and Wi-Fi going while it plays.
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
        exo.addListener(listener);
        player = exo;

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaLibrarySession.Builder(this, new Shell(exo), new MediaLibrarySession.Callback() {
                    // The queue is the page's: other apps and devices can play, pause, skip and seek, and start
                    // something from the car's lists (Library), not rearrange it.
                    @NonNull
                    @Override
                    public MediaSession.ConnectionResult onConnect(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller) {
                        Player.Commands commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                                .remove(Player.COMMAND_SET_SHUFFLE_MODE)
                                .remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
                                .build();
                        return new MediaSession.ConnectionResult.AcceptedResultBuilder(s)
                                .setAvailablePlayerCommands(commands)
                                .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(LIKE).build())
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

                    @NonNull
                    @Override
                    public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo controller,
                            @Nullable LibraryParams params) {
                        // (No "recent" list for the system to offer: what plays is the page's queue.)
                        if (params != null && params.isRecent) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_NOT_SUPPORTED));
                        return Futures.immediateFuture(LibraryResult.ofItem(library.root(), params));
                    }

                    @NonNull
                    @Override
                    public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo controller,
                            @NonNull String parent, int page, int size, @Nullable LibraryParams params) {
                        return library.children(parent, page, size);
                    }

                    /** A tap in the car's lists: its songs become the queue (Shell hands them to load()). */
                    @NonNull
                    @Override
                    public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller,
                            @NonNull List<MediaItem> items, int startIndex, long startPositionMs) {
                        if (items.size() != 1) return Futures.immediateFailedFuture(new UnsupportedOperationException());
                        return Futures.transform(library.play(items.get(0).mediaId), q -> {
                            if (q == null || q.tracks.length() == 0) throw new IllegalArgumentException("nothing to play");
                            List<MediaItem> out = new ArrayList<>();
                            for (int i = 0; i < q.tracks.length(); i++) {
                                JSONObject t = q.tracks.optJSONObject(i);
                                Bundle extras = new Bundle();
                                extras.putString(TRACK, t.toString());
                                out.add(item(t).buildUpon().setRequestMetadata(new MediaItem.RequestMetadata.Builder().setExtras(extras).build()).build());
                            }
                            return new MediaSession.MediaItemsWithStartPosition(out, q.index, 0);
                        }, handler::post);
                    }
                })
                .setSessionActivity(tap)
                .build();
        DefaultMediaNotificationProvider notification = new DefaultMediaNotificationProvider.Builder(this)
                .setChannelName(R.string.playing_channel)
                .build();
        notification.setSmallIcon(R.drawable.ic_note);
        setMediaNotificationProvider(notification);
        addSession(session);

        // Chromecasts: the queue moves there when one is picked, and back.
        if (castable(this)) {
            CastContext.getSharedInstance(this, handler::post).addOnSuccessListener(c -> {
                if (exo == null) return;
                castContext = c;
                cast = new CastPlayer(this, c, new DefaultMediaItemConverter(), 10_000, 10_000, 3_000);
                cast.addListener(listener);
                cast.setSessionAvailabilityListener(new SessionAvailabilityListener() {
                    @Override
                    public void onCastSessionAvailable() {
                        toCast();
                    }

                    @Override
                    public void onCastSessionUnavailable() {
                        toPhone();
                    }
                });
                c.addSessionTransferCallback(transfer);
                if (cast.isCastSessionAvailable()) toCast();
            }).addOnFailureListener(e -> Log.w(TAG, "no Cast: " + e));
        }

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

    /** Chromecasts: phones and tablets (not TVs) with Google Play services, where the system's output switcher lists them (Android 13). */
    static boolean castable(Context context) {
        return Build.VERSION.SDK_INT >= 33 && !MainActivity.isTv(context)
                && GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == com.google.android.gms.common.ConnectionResult.SUCCESS;
    }

    @Nullable
    @Override
    public IBinder onBind(@Nullable Intent intent) {
        IBinder binder = super.onBind(intent);
        return intent != null && ACTION_LOCAL.equals(intent.getAction()) ? local : binder;
    }

    @Nullable
    @Override
    public MediaLibrarySession onGetSession(@NonNull MediaSession.ControllerInfo controller) {
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
        if (cast != null) {
            castContext.removeSessionTransferCallback(transfer);
            cast.setSessionAvailabilityListener(null);
            cast.release();
            cast = null;
        }
        exo.release();
        session.release();
        session = null;
        exo = null;
        player = null;
        page = null;
        ahead.want(new ArrayList<>(), new HashMap<>(), null);
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
        long from = Math.max(0, (long) (start * 1000));
        if (player == cast) {
            castLoad(i, from, play);
        } else {
            exo.setMediaItems(items(queue, 0, queue.size()), i, from);
            if (play) {
                exo.prepare();
                exo.play();
            } else {
                // Ready where it was, nothing fetched (and no notification) until it's played.
                exo.pause();
                exo.stop();
            }
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
        int at = player.getCurrentMediaItemIndex();
        int now = index();
        int around = Math.max(0, Math.min(index, next.size() - 1));
        String playing = now < queue.size() ? queue.get(now).optString("id") : next.get(around).optString("id");
        int keep = find(next, playing, around);
        int count = player.getMediaItemCount();
        queue.clear();
        queue.addAll(next);
        if (player == cast) {
            // A long queue: the Chromecast gets it from the song playing on.
            castFrom = next.size() > CAST_WINDOW ? keep : 0;
            castTo = Math.min(next.size(), castFrom + CAST_WINDOW);
            // (Its queue changes when it says so: every position here is as it was before.)
            if (keep > castFrom) cast.addMediaItems(at, items(next, castFrom, keep));
            if (keep + 1 < castTo) cast.addMediaItems(count, items(next, keep + 1, castTo));
            if (at + 1 < count) cast.removeMediaItems(at + 1, count);
            if (at > 0) cast.removeMediaItems(0, at);
            castSettling = keep;
            handler.removeCallbacks(settled);
            handler.postDelayed(settled, 3000);
        } else {
            // (Each step tells the listener: what to fetch ahead waits for the queue as it ends up.)
            editing = true;
            if (at + 1 < count) exo.removeMediaItems(at + 1, count);
            if (at > 0) exo.removeMediaItems(0, at);
            if (keep > 0) exo.addMediaItems(0, items(next, 0, keep));
            if (keep + 1 < next.size()) exo.addMediaItems(items(next, keep + 1, next.size()));
            editing = false;
            ahead();
        }
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
                handler.removeCallbacks(skip);
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem();
                    resume();
                } else if (player == cast && castTo < queue.size()) {
                    castLoad(index() + 1, 0, true);
                }
                break;
            case "previous":
                handler.removeCallbacks(skip);
                // More than 3 seconds in (or the first song): from the start again.
                if (player.getCurrentPosition() > 3000 || index() == 0) player.seekTo(0);
                else if (player.hasPreviousMediaItem()) player.seekToPreviousMediaItem();
                else if (player == cast) castLoad(index() - 1, 0, true);
                else player.seekTo(0);
                resume();
                break;
            case "seek":
                if (value instanceof Number) player.seekTo(Math.max(0, (long) (((Number) value).doubleValue() * 1000)));
                break;
            case "jump":
                if (value instanceof Number) {
                    int i = ((Number) value).intValue();
                    if (i < 0 || i >= queue.size()) break;
                    handler.removeCallbacks(skip);
                    if (player != cast) player.seekTo(i, 0);
                    else if (i >= castFrom && i < castFrom + cast.getMediaItemCount()) cast.seekTo(i - castFrom, 0);
                    else castLoad(i, 0, true);
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

    /**
     * audio.sleep: stop `minutes` from now, or at the end of the song playing; neither turns it off.
     * When it's time the music pauses (the queue stays) and the timer is forgotten.
     */
    void sleep(double minutes, boolean endOfSong) {
        handler.removeCallbacks(sleepDue);
        sleepAt = minutes > 0 ? System.currentTimeMillis() + (long) (minutes * 60_000) : 0;
        sleepEndOfSong = sleepAt == 0 && endOfSong;
        // ExoPlayer stops right at the end of the song (onPlayWhenReadyChanged moves on to the next).
        exo.setPauseAtEndOfMediaItems(sleepEndOfSong);
        if (sleepAt > 0) handler.postDelayed(sleepDue, sleepAt - System.currentTimeMillis());
        push();
    }

    /** audio.eq: the equalizer, kept for next time. On a Chromecast it waits for the music to come back. */
    void eq(JSONObject args) {
        String kept = equalize(args);
        if (kept != null && !kept.equals(Server.prefs(this).getString("eq", null))) Server.prefs(this).edit().putString("eq", kept).apply();
    }

    /** {on, gains} into the equalizer, gains within ±12 dB; what it's set to, as the same JSON. */
    private String equalize(JSONObject args) {
        boolean on = args.optBoolean("on");
        JSONArray given = args.optJSONArray("gains");
        double[] gains = new double[Equalizer.BANDS];
        JSONArray kept = new JSONArray();
        try {
            for (int b = 0; b < gains.length; b++) {
                double g = given == null ? 0 : given.optDouble(b, 0);
                gains[b] = Double.isNaN(g) ? 0 : Math.max(-12, Math.min(12, g));
                kept.put(gains[b]);
            }
            equalizer.set(on, gains);
            return new JSONObject().put("on", on).put("gains", kept).toString();
        } catch (JSONException e) {
            return null;
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
        int i = player == null ? -1 : index();
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
        int i = player == null || queue.isEmpty() ? -1 : index();
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
            return new JSONObject().put("tracks", new JSONArray(queue)).put("index", index()).put("state", state());
        } catch (JSONException e) {
            return null;
        }
    }

    /** Where the player is in the queue (a Chromecast has the part of a long queue from castFrom). */
    private int index() {
        if (player != cast) return player.getCurrentMediaItemIndex();
        return castSettling >= 0 ? castSettling : castFrom + cast.getCurrentMediaItemIndex();
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
        sleep(0, false);
    }

    // ---------- The queue kept ahead ----------

    /**
     * The next few songs fetched whole, once the one playing has loaded (not while it's on a
     * Chromecast). Songs whose address changed (another sound quality) lose their old copies.
     */
    private void ahead() {
        if (editing) return;
        boolean ready = player == exo && exo.getPlaybackState() == Player.STATE_READY && !queue.isEmpty();
        // (A moment's buffering in the middle of a song changes nothing.)
        if (!ready && player == exo && exo.getPlaybackState() == Player.STATE_BUFFERING && aheadOf == index()) return;
        aheadOf = ready ? index() : -1;
        List<String> next = new ArrayList<>();
        Map<String, String> all = new HashMap<>();
        for (JSONObject t : queue) all.put(t.optString("id"), t.optString("url"));
        if (ready) {
            int now = index();
            boolean around = exo.getRepeatMode() == Player.REPEAT_MODE_ALL;
            for (int k = 1; k <= AHEAD && (around ? k < queue.size() : now + k < queue.size()); k++) {
                JSONObject t = queue.get((now + k) % queue.size());
                if (downloads.song(t.optString("id")) == null) next.add(t.optString("url"));
            }
        }
        // (The song playing carries on from the file it started with, whatever its address is now.)
        MediaItem current = player == exo ? exo.getCurrentMediaItem() : null;
        ahead.want(next, all, local(current) ? new File(current.localConfiguration.uri.getPath()) : null);
    }

    /** A song fetched ahead is here: it plays from the file wherever it's still to come in the queue. */
    private void fetched(String url) {
        if (player != exo) return;
        int now = exo.getCurrentMediaItemIndex();
        long left = exo.getDuration() == C.TIME_UNSET ? Long.MAX_VALUE : exo.getDuration() - exo.getCurrentPosition();
        for (int i = 0; i < queue.size() && i < exo.getMediaItemCount(); i++) {
            if (i == now || !url.equals(queue.get(i).optString("url")) || local(exo.getMediaItemAt(i))) continue;
            // (Not the next song in the last seconds of this one: it's on its way in already, gaplessly.)
            if (i == now + 1 && left < 5000) continue;
            exo.replaceMediaItem(i, item(queue.get(i)));
        }
    }

    private static boolean local(@Nullable MediaItem item) {
        return item != null && item.localConfiguration != null && "file".equals(item.localConfiguration.uri.getScheme());
    }

    // ---------- On a Chromecast ----------

    /** A Chromecast was picked: the queue moves there from where it is. */
    private void toCast() {
        if (cast == null || player == cast) return;
        handler.removeCallbacks(skip);
        handler.removeCallbacks(retry);
        int i = index();
        long position = Math.max(0, exo.getCurrentPosition());
        boolean play = exo.getPlayWhenReady() && exo.getPlaybackState() != Player.STATE_ENDED;
        cast.setRepeatMode(exo.getRepeatMode());
        exo.stop();
        player = cast;
        session.setPlayer(new Shell(cast));
        if (!queue.isEmpty()) castLoad(i, position, play);
        ahead();
        push();
    }

    /** The Chromecast went (or the output switcher brought the music back): the phone carries on from there. */
    private void toPhone() {
        if (player != cast) return;
        int i = Math.max(0, Math.min(index(), queue.size() - 1));
        long position = Math.max(0, cast.getCurrentPosition());
        castWasPlaying = cast.getPlayWhenReady();
        castSettling = -1;
        exo.setRepeatMode(cast.getRepeatMode());
        player = exo;
        session.setPlayer(new Shell(exo));
        if (!queue.isEmpty()) {
            exo.setMediaItems(items(queue, 0, queue.size()), i, position);
            exo.prepare();
            exo.setPlayWhenReady(backHere && castWasPlaying);
        }
        backHere = false;
        push();
    }

    private final SessionTransferCallback transfer = new SessionTransferCallback() {
        @Override
        public void onTransferring(int type) {
            if (type == TRANSFER_TYPE_FROM_REMOTE_TO_LOCAL) backHere = true;
        }

        @Override
        public void onTransferred(int type, @Nullable SessionState state) {
            if (type == TRANSFER_TYPE_FROM_REMOTE_TO_LOCAL && player == exo && castWasPlaying) play();
            castWasPlaying = false;
        }
    };

    /** The Chromecast's queue from song `i`: all of it, or the next CAST_WINDOW songs of a long one. */
    private void castLoad(int i, long position, boolean play) {
        castSettling = -1;
        castFrom = queue.size() > CAST_WINDOW ? i : 0;
        castTo = Math.min(queue.size(), castFrom + CAST_WINDOW);
        cast.setMediaItems(items(queue, castFrom, castTo), i - castFrom, position);
        cast.setPlayWhenReady(play);
        cast.prepare();
    }

    /** Nearly at the end of what the Chromecast has: more of the queue. */
    private void castMore() {
        if (player != cast || castSettling >= 0 || castTo >= queue.size() || castTo - index() > 2) return;
        int to = Math.min(queue.size(), castTo + CAST_MORE);
        cast.addMediaItems(items(queue, castTo, to));
        castTo = to;
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

    /** Any connection at all: with none, a song that isn't on the device is skipped, not waited for. */
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

    /** {index, id, playing, buffering?, time, duration, ended?, error?, repeat, output, local?, sleep?}. */
    private JSONObject state() throws JSONException {
        JSONObject state = new JSONObject();
        int index = queue.isEmpty() ? -1 : index();
        int playback = player.getPlaybackState();
        state.put("index", index);
        // (The page sees a queue it didn't set, from the car, by the song not being the one it has there.)
        if (index >= 0 && index < queue.size()) state.put("id", queue.get(index).optString("id"));
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
        // From a file on the device (downloaded, or fetched ahead): the server doesn't see it played.
        if (player == exo && index >= 0 && local(exo.getCurrentMediaItem())) state.put("local", true);
        if (sleepAt > 0) state.put("sleep", new JSONObject().put("at", sleepAt));
        else if (sleepEndOfSong) state.put("sleep", new JSONObject().put("endOfSong", true));
        return state;
    }

    /** Where the sound comes out: {name, kind}, as NativeOutput. */
    private JSONObject output() throws JSONException {
        if (player == cast) {
            CastSession now = castContext.getSessionManager().getCurrentCastSession();
            CastDevice device = now == null ? null : now.getCastDevice();
            return new JSONObject().put("name", device == null ? "Chromecast" : device.getFriendlyName()).put("kind", "cast");
        }
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

    /**
     * A NativeTrack as the player and the lock screen see it: from the device when it's downloaded
     * or fetched ahead. On a Chromecast, the stream itself (it can't read the phone's files), and as
     * Opus or MP3, which it plays (not every file the phone does: ALAC).
     */
    private MediaItem item(JSONObject t) {
        boolean remote = player == cast;
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .setTitle(t.optString("title"))
                .setArtist(t.optString("artist"))
                .setAlbumTitle(t.optString("album"))
                .setIsPlayable(true)
                .setIsBrowsable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC);
        String artwork = t.optString("artwork", "");
        File picture = artwork.isEmpty() || remote ? null : downloads.picture(artwork);
        if (picture != null) meta.setArtworkUri(Uri.fromFile(picture));
        else if (artwork.startsWith("http")) meta.setArtworkUri(Uri.parse(artwork));
        double duration = t.optDouble("duration", 0);
        if (duration > 0) meta.setDurationMs((long) (duration * 1000));
        String url = t.optString("url");
        MediaItem.Builder item = new MediaItem.Builder().setMediaId(t.optString("id")).setMediaMetadata(meta.build());
        if (remote) {
            Uri stream = Uri.parse(url);
            String format = stream.getQueryParameter("f");
            if (!"mp3".equals(format) && !"opus".equals(format)) {
                Uri.Builder opus = stream.buildUpon().clearQuery().appendQueryParameter("f", "opus").appendQueryParameter("br", "256");
                for (String name : stream.getQueryParameterNames()) {
                    if (!name.equals("f") && !name.equals("br")) for (String v : stream.getQueryParameters(name)) opus.appendQueryParameter(name, v);
                }
                stream = opus.build();
            }
            return item.setUri(stream).setMimeType("mp3".equals(format) ? MimeTypes.AUDIO_MPEG : MimeTypes.AUDIO_OGG).build();
        }
        File song = downloads.song(t.optString("id"));
        if (song == null) song = ahead.file(url);
        return item.setUri(song != null ? Uri.fromFile(song) : Uri.parse(url)).build();
    }

    /**
     * The player as the session sees it. A queue set from outside (a tap in the car's lists) comes
     * with its songs as NativeTracks and becomes the queue as the page's would (load()).
     */
    private final class Shell extends ForwardingPlayer {
        Shell(Player player) {
            super(player);
        }

        @Override
        public void setMediaItems(@NonNull List<MediaItem> items, int startIndex, long startPositionMs) {
            fromOutside(items, startIndex, startPositionMs);
        }

        @Override
        public void setMediaItems(@NonNull List<MediaItem> items, boolean resetPosition) {
            fromOutside(items, 0, 0);
        }
    }

    private void fromOutside(List<MediaItem> items, int index, long positionMs) {
        JSONArray tracks = new JSONArray();
        for (MediaItem m : items) {
            String json = m.requestMetadata.extras == null ? null : m.requestMetadata.extras.getString(TRACK);
            if (json == null) return;
            try {
                tracks.put(new JSONObject(json));
            } catch (JSONException e) {
                return;
            }
        }
        load(tracks, index == C.INDEX_UNSET ? 0 : index, positionMs == C.TIME_UNSET ? 0 : positionMs / 1000.0, false);
    }
}

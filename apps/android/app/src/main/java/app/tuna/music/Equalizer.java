package app.tuna.music;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;
import java.util.Arrays;

/**
 * The equalizer (audio.eq), in ExoPlayer's own audio pipeline: the same on every device (Fire TV
 * too) and for everything it plays. A low shelf at 60 Hz, peaks (Q 1) at 150, 400, 1000 and
 * 2400 Hz and a high shelf at 15 kHz, as the browser's own filters (BiquadFilterNode), with the
 * whole lowered by the highest boost so nothing clips. Each band is Andrew Simper's state-variable
 * filter: a biquad's response, and it takes changing settings without a click. A change glides in
 * over 30 ms; off, or flat, the sound passes through untouched.
 */
@OptIn(markerClass = UnstableApi.class)
final class Equalizer extends BaseAudioProcessor {
    static final int BANDS = 6;
    private static final double[] HZ = {60, 150, 400, 1000, 2400, 15000};
    /** The peaks' Q; the shelves' (a slope of 1, as the browser's). */
    private static final double Q = 1, SHELF_Q = Math.sqrt(0.5);
    /** A change glides in over this long, worked out again every BLOCK frames (and smoothly in between). */
    private static final int GLIDE_MS = 30, BLOCK = 64;

    /** What's asked for: the six gains, then the pre-gain, in dB (all 0: flat). Set from any thread. */
    private volatile double[] wanted = new double[BANDS + 1];
    /** The glide from `start` to `target`, `done` of `length` frames in; `now` is where it's got to. */
    private double[] target;
    private final double[] start = new double[BANDS + 1], now = new double[BANDS + 1];
    private int done, length;
    /** Each band's coefficients (a1, a2, a3, m0, m1, m2) at the start and end of a block, and the pre-gain's. */
    private final double[] from = new double[BANDS * 6], to = new double[BANDS * 6];
    private double preFrom = 1, preTo = 1;
    /** Each band's two states per channel; a flat band isn't run (and starts again from silence). */
    private double[] states = new double[0];
    private final boolean[] running = new boolean[BANDS];
    /** The samples as they come and go (16-bit or float), and a block of them while it's worked on. */
    private short[] shorts = new short[0];
    private float[] floats = new float[0];
    private double[] block = new double[0];
    private int rate, channels;
    private boolean isFloat;

    /** audio.eq: six gains in dB (off: flat). */
    void set(boolean on, double[] gains) {
        double[] w = new double[BANDS + 1];
        double top = 0;
        for (int b = 0; b < BANDS && on; b++) {
            w[b] = gains[b];
            top = Math.max(top, gains[b]);
        }
        w[BANDS] = top > 0 ? -top : 0;
        wanted = w;
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat format) {
        // (ExoPlayer hands its processors 16-bit samples; floats too, in case. Anything else passes by.)
        return format.encoding == C.ENCODING_PCM_16BIT || format.encoding == C.ENCODING_PCM_FLOAT ? format : AudioFormat.NOT_SET;
    }

    @Override
    protected void onFlush() {
        if (!isActive()) return;
        // A new format, a seek: straight to what's asked for, from silence.
        rate = inputAudioFormat.sampleRate;
        channels = inputAudioFormat.channelCount;
        isFloat = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT;
        states = new double[BANDS * channels * 2];
        block = new double[BLOCK * channels];
        Arrays.fill(running, false);
        target = wanted;
        System.arraycopy(target, 0, now, 0, BANDS + 1);
        length = Math.max(1, rate * GLIDE_MS / 1000);
        done = length;
        for (int b = 0; b < BANDS; b++) coefficients(b, now[b], to, b * 6);
        preTo = Math.pow(10, now[BANDS] / 20);
    }

    @Override
    public void queueInput(ByteBuffer input) {
        int count = input.remaining() / inputAudioFormat.bytesPerFrame * channels;
        ByteBuffer out = replaceOutputBuffer(input.remaining());
        // (All of it at once through an array: much quicker than sample by sample.)
        if (isFloat) {
            if (floats.length < count) floats = new float[count];
            input.asFloatBuffer().get(floats, 0, count);
        } else {
            if (shorts.length < count) shorts = new short[count];
            input.asShortBuffer().get(shorts, 0, count);
        }
        for (int i = 0; i < count; i += BLOCK * channels) {
            int n = Math.min(BLOCK * channels, count - i);
            if (!glide(n / channels)) filter(i, n);
        }
        if (isFloat) out.asFloatBuffer().put(floats, 0, count);
        else out.asShortBuffer().put(shorts, 0, count);
        input.position(input.limit());
        out.position(count * (isFloat ? 4 : 2));
        out.flip();
    }

    /** The settings moved on by n frames, towards what's asked for; true when they're flat (nothing to do). */
    private boolean glide(int n) {
        double[] w = wanted;
        if (w != target) {
            target = w;
            System.arraycopy(now, 0, start, 0, BANDS + 1);
            done = Arrays.equals(w, now) ? length : 0;
        }
        System.arraycopy(to, 0, from, 0, to.length);
        preFrom = preTo;
        if (done == length) {
            for (double v : now) if (v != 0) return false;
            Arrays.fill(running, false);
            return true;
        }
        done = Math.min(length, done + n);
        double t = (double) done / length;
        t = t * t * (3 - 2 * t); // (easing in and out)
        for (int j = 0; j <= BANDS; j++) now[j] = done == length ? target[j] : start[j] + (target[j] - start[j]) * t;
        for (int b = 0; b < BANDS; b++) coefficients(b, now[b], to, b * 6);
        preTo = Math.pow(10, now[BANDS] / 20);
        return false;
    }

    /** `count` samples from `at` through the bands, every coefficient moving sample by sample from `from` to `to`. */
    private void filter(int at, int count) {
        int n = count / channels;
        double[] x = block;
        if (isFloat) for (int i = 0; i < count; i++) x[i] = floats[at + i];
        else for (int i = 0; i < count; i++) x[i] = shorts[at + i] / 32768.0;
        for (int b = 0, o = 0; b < BANDS; b++, o += 6) {
            if (flat(from, o) && flat(to, o)) {
                running[b] = false;
                continue;
            }
            if (!running[b]) Arrays.fill(states, b * channels * 2, (b + 1) * channels * 2, 0);
            running[b] = true;
            for (int ch = 0; ch < channels; ch++) {
                double a1 = from[o], a2 = from[o + 1], a3 = from[o + 2], m0 = from[o + 3], m1 = from[o + 4], m2 = from[o + 5];
                double da1 = (to[o] - a1) / n, da2 = (to[o + 1] - a2) / n, da3 = (to[o + 2] - a3) / n;
                double dm0 = (to[o + 3] - m0) / n, dm1 = (to[o + 4] - m1) / n, dm2 = (to[o + 5] - m2) / n;
                int s = (b * channels + ch) * 2;
                double ic1 = states[s], ic2 = states[s + 1];
                for (int i = ch; i < count; i += channels) {
                    double v0 = x[i];
                    double v3 = v0 - ic2;
                    double v1 = a1 * ic1 + a2 * v3;
                    double v2 = ic2 + a2 * ic1 + a3 * v3;
                    ic1 = 2 * v1 - ic1;
                    ic2 = 2 * v2 - ic2;
                    x[i] = m0 * v0 + m1 * v1 + m2 * v2;
                    a1 += da1;
                    a2 += da2;
                    a3 += da3;
                    m0 += dm0;
                    m1 += dm1;
                    m2 += dm2;
                }
                states[s] = ic1;
                states[s + 1] = ic2;
            }
        }
        double pre = preFrom, step = (preTo - preFrom) / n;
        for (int f = 0, i = 0; f < n; f++, pre += step) for (int ch = 0; ch < channels; ch++, i++) x[i] *= pre;
        if (isFloat) {
            for (int i = 0; i < count; i++) floats[at + i] = (float) x[i];
        } else {
            // (Rounded, and held at full scale rather than wrapping round.)
            for (int i = 0; i < count; i++) {
                double v = x[i] * 32768;
                shorts[at + i] = (short) (v >= 32767 ? 32767 : v <= -32768 ? -32768 : (int) (v < 0 ? v - 0.5 : v + 0.5));
            }
        }
    }

    private static boolean flat(double[] c, int o) {
        return c[o + 3] == 1 && c[o + 4] == 0 && c[o + 5] == 0;
    }

    /** Band b at `db`, into c at o (a band past what the sample rate holds stays flat). */
    private void coefficients(int b, double db, double[] c, int o) {
        double a = HZ[b] < rate * 0.49 ? Math.pow(10, db / 40) : 1;
        double g = Math.tan(Math.PI * Math.min(HZ[b], rate * 0.49) / rate), k, m0 = 1, m1, m2 = 0;
        if (b == 0) {
            g /= Math.sqrt(a);
            k = 1 / SHELF_Q;
            m1 = k * (a - 1);
            m2 = a * a - 1;
        } else if (b == BANDS - 1) {
            g *= Math.sqrt(a);
            k = 1 / SHELF_Q;
            m0 = a * a;
            m1 = k * (1 - a) * a;
            m2 = 1 - a * a;
        } else {
            k = 1 / (Q * a);
            m1 = k * (a * a - 1);
        }
        double a1 = 1 / (1 + g * (g + k));
        c[o] = a1;
        c[o + 1] = g * a1;
        c[o + 2] = g * g * a1;
        c[o + 3] = m0;
        c[o + 4] = m1;
        c[o + 5] = m2;
    }
}

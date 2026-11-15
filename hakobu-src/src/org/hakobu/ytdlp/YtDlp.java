/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.ytdlp;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.appwork.storage.JSonStorage;
import org.appwork.storage.TypeRef;
import org.appwork.utils.Application;

/**
 * Runs yt-dlp as a separate program. Hakobu does not reimplement any site logic for video sites: yt-dlp does the extraction, Hakobu
 * shows the result in the link grabber and runs the download with progress.
 */
public final class YtDlp {
    private YtDlp() {
    }

    public interface Progress {
        void update(long loaded, long total, String text);
    }

    private static File firstFile(final File... candidates) {
        for (final File f : candidates) {
            if (f != null && f.isFile()) {
                return f;
            }
        }
        return null;
    }

    /** yt-dlp: Hakobu-Java's own tools folder first, then the Electron Hakobu's copy, then PATH. */
    public static String executable() {
        final String appData = System.getenv("APPDATA");
        final File f = firstFile(Application.getResource("tools/hakobu/yt-dlp.exe"), appData == null ? null : new File(appData, "Hakobu/tools/yt-dlp.exe"));
        return f != null ? f.getAbsolutePath() : "yt-dlp";
    }

    public static File ffmpegFolder() {
        final String appData = System.getenv("APPDATA");
        final File f = firstFile(Application.getResource("tools/hakobu/ffmpeg.exe"), appData == null ? null : new File(appData, "Hakobu/tools/ffmpeg.exe"));
        return f != null ? f.getParentFile() : null;
    }

    private static List<String> base() {
        final List<String> cmd = new ArrayList<String>();
        cmd.add(executable());
        cmd.add("--no-warnings");
        final File ff = ffmpegFolder();
        if (ff != null) {
            cmd.add("--ffmpeg-location");
            cmd.add(ff.getAbsolutePath());
        }
        return cmd;
    }

    private static String readAll(final InputStream in) throws IOException {
        final ByteArrayOutputStream bos = new ByteArrayOutputStream();
        final byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /** Metadata for a link: a single video, or a playlist with flat entries. */
    public static Map<String, Object> probe(final String url) throws IOException, InterruptedException {
        final List<String> cmd = base();
        cmd.add("-J");
        cmd.add("--flat-playlist");
        cmd.add(url);
        final Process p = new ProcessBuilder(cmd).redirectErrorStream(false).start();
        final StringBuilder err = new StringBuilder();
        final Thread errReader = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    err.append(readAll(p.getErrorStream()));
                } catch (final IOException ignore) {
                }
            }
        }, "yt-dlp stderr");
        errReader.start();
        final String out = readAll(p.getInputStream());
        if (!p.waitFor(180, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("yt-dlp took too long to answer");
        }
        errReader.join(2000);
        if (p.exitValue() != 0 || out.trim().isEmpty()) {
            throw new IOException(lastLine(err.toString(), "yt-dlp could not read this link"));
        }
        return JSonStorage.restoreFromString(out, TypeRef.MAP);
    }

    static String lastLine(final String text, final String fallback) {
        final String[] lines = text.trim().split("\r?\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            if (lines[i].contains("ERROR")) {
                return lines[i].trim();
            }
        }
        return lines.length > 0 && !lines[lines.length - 1].trim().isEmpty() ? lines[lines.length - 1].trim() : fallback;
    }

    /**
     * Downloads to exactly {@code target} (an .mp4 path). Video and audio streams are fetched one after the other by yt-dlp, so the byte
     * counter is kept across streams.
     */
    public static void download(final String url, final File target, final Progress progress, final AtomicBoolean stop) throws IOException, InterruptedException {
        final List<String> cmd = base();
        cmd.add("--newline");
        cmd.add("--no-playlist");
        cmd.add("-f");
        cmd.add("bv*+ba/b");
        cmd.add("--merge-output-format");
        cmd.add("mp4");
        cmd.add("--remux-video");
        cmd.add("mp4");
        cmd.add("--progress-template");
        cmd.add("download:HKP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s");
        cmd.add("-o");
        final String path = target.getAbsolutePath();
        cmd.add(path.toLowerCase().endsWith(".mp4") ? path.substring(0, path.length() - 4) + ".%(ext)s" : path);
        cmd.add(url);
        final Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        final StringBuilder log = new StringBuilder();
        long base = 0, lastLoaded = 0, lastTotal = 0;
        try {
            final BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = r.readLine()) != null) {
                if (stop.get()) {
                    break;
                }
                if (line.startsWith("HKP ")) {
                    final String[] f = line.split(" ");
                    final long loaded = num(f, 1);
                    long total = num(f, 2);
                    if (total <= 0) {
                        total = num(f, 3);
                    }
                    if (loaded < lastLoaded) {
                        /* next stream (audio after video) */
                        base += Math.max(lastTotal, lastLoaded);
                    }
                    lastLoaded = loaded;
                    lastTotal = total;
                    progress.update(base + loaded, base + Math.max(total, loaded), null);
                } else {
                    if (log.length() < 20000) {
                        log.append(line).append('\n');
                    }
                    if (line.startsWith("[Merger]") || line.startsWith("[VideoRemuxer]")) {
                        progress.update(base + lastLoaded, base + Math.max(lastTotal, lastLoaded), "Merging video and audio");
                    }
                }
            }
        } finally {
            if (stop.get()) {
                kill(p);
            }
        }
        if (stop.get()) {
            return;
        }
        p.waitFor();
        if (p.exitValue() != 0) {
            throw new IOException(lastLine(log.toString(), "yt-dlp failed"));
        }
    }

    private static long num(final String[] f, final int i) {
        if (i >= f.length) {
            return 0;
        }
        try {
            return (long) Double.parseDouble(f[i]);
        } catch (final NumberFormatException e) {
            return 0;
        }
    }

    private static void kill(final Process p) {
        try {
            p.descendants().forEach(ProcessHandle::destroyForcibly);
        } catch (final Throwable ignore) {
        }
        p.destroyForcibly();
    }
}

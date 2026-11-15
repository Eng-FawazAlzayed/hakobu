/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.torrent;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

import org.appwork.utils.Application;
import org.appwork.utils.IO;
import org.appwork.utils.Regex;
import org.hakobu.HakobuSettings;

import com.frostwire.jlibtorrent.SessionManager;
import com.frostwire.jlibtorrent.SessionParams;
import com.frostwire.jlibtorrent.SettingsPack;
import com.frostwire.jlibtorrent.TorrentHandle;
import com.frostwire.jlibtorrent.TorrentInfo;
import com.frostwire.jlibtorrent.TorrentStatus;

/**
 * One shared libtorrent session for the whole app (libtorrent is built to run one session with many torrents). Started lazily on the
 * first torrent, so people who never use torrents never open a BitTorrent port. Also keeps finished torrents seeding until the ratio or
 * time limit in Hakobu's settings is reached.
 */
public final class TorrentEngine {
    private static SessionManager                 session;
    private static Thread                         seedWatcher;
    private static final List<Seed>               SEEDS = new CopyOnWriteArrayList<Seed>();

    /** A finished torrent that keeps uploading for a while. */
    public static final class Seed {
        public final TorrentHandle handle;
        public final String        name;
        public final long          size;
        public final long          started = System.currentTimeMillis();

        Seed(final TorrentHandle handle, final String name, final long size) {
            this.handle = handle;
            this.name = name;
            this.size = size;
        }

        public double ratio() {
            if (!handle.isValid() || size <= 0) {
                return 0;
            }
            return handle.status().allTimeUpload() / (double) size;
        }

        public int uploadRate() {
            return handle.isValid() ? handle.status().uploadRate() : 0;
        }

        public int peers() {
            return handle.isValid() ? handle.status().numPeers() : 0;
        }
    }

    private TorrentEngine() {
    }

    static SettingsPack settingsPack() {
        final HakobuSettings cfg = HakobuSettings.get();
        final SettingsPack sp = new SettingsPack();
        final int port = cfg.getTorrentPort() > 0 && cfg.getTorrentPort() < 65536 ? cfg.getTorrentPort() : 6881;
        sp.listenInterfaces("0.0.0.0:" + port + ",[::]:" + port);
        sp.uploadRateLimit(Math.max(0, cfg.getUploadLimit()) * 1024);
        return sp;
    }

    public static synchronized SessionManager get() {
        if (session == null) {
            final SessionManager s = new SessionManager();
            s.start(new SessionParams(settingsPack()));
            session = s;
            startSeedWatcher();
        } else if (!session.isRunning()) {
            session.start(new SessionParams(settingsPack()));
        }
        return session;
    }

    public static synchronized boolean isRunning() {
        return session != null && session.isRunning();
    }

    /** Applies changed port/upload limit to a running session. */
    public static synchronized void applySettings() {
        if (session != null && session.isRunning()) {
            session.applySettings(settingsPack());
        }
    }

    /** Waits for the DHT so magnet lookups have peers to ask. Returns early once some nodes are known. */
    public static void waitForDht(final SessionManager s, final long maxMs) throws InterruptedException {
        final long end = System.currentTimeMillis() + maxMs;
        while (System.currentTimeMillis() < end && s.stats().dhtNodes() < 10) {
            Thread.sleep(500);
        }
    }

    public static String infoHash(final String magnet) {
        if (magnet == null) {
            return null;
        }
        final String h = new Regex(magnet, "xt=urn:btih:([A-Za-z0-9]{32,40})").getMatch(0);
        return h == null ? null : h.toLowerCase(Locale.ENGLISH);
    }

    private static File cacheFile(final String hash) {
        return Application.getResource("cfg/hakobu/torrents/" + hash + ".torrent");
    }

    /** Metadata from Hakobu's local cache (filled by .torrent files and by earlier magnet lookups). */
    public static TorrentInfo cached(final String hash) {
        if (hash == null) {
            return null;
        }
        final File f = cacheFile(hash);
        if (!f.isFile()) {
            return null;
        }
        try {
            return TorrentInfo.bdecode(IO.readFile(f));
        } catch (final Throwable e) {
            return null;
        }
    }

    /** Stores metadata and returns a magnet link that Hakobu resolves from the cache, with no DHT lookup. */
    public static String store(final TorrentInfo ti) throws Exception {
        final String hash = ti.infoHashV1().toHex().toLowerCase(Locale.ENGLISH);
        final File f = cacheFile(hash);
        if (!f.isFile()) {
            /* The same torrent can be added again later; the cache entry is keyed by info hash, so it is already right. */
            f.getParentFile().mkdirs();
            IO.writeToFile(f, ti.bencode());
        }
        return "magnet:?xt=urn:btih:" + hash + "&dn=" + java.net.URLEncoder.encode(ti.name(), "UTF-8");
    }

    /** Resolves a magnet link to torrent metadata (cache first), or null on timeout. */
    public static TorrentInfo fetchMetadata(final String magnet, final int timeoutSec, final File tempDir) throws Exception {
        final TorrentInfo c = cached(infoHash(magnet));
        if (c != null) {
            return c;
        }
        final SessionManager s = get();
        waitForDht(s, 15000);
        tempDir.mkdirs();
        final byte[] data = s.fetchMagnet(magnet, timeoutSec, tempDir);
        if (data == null) {
            return null;
        }
        final TorrentInfo ti = TorrentInfo.bdecode(data);
        store(ti);
        return ti;
    }

    /** Hands a finished torrent over to seeding, or removes it when seeding is off. */
    public static void finished(final TorrentHandle h, final String name, final long size) {
        final HakobuSettings cfg = HakobuSettings.get();
        if (cfg.getSeedRatio() <= 0 || h == null || !h.isValid()) {
            if (h != null && h.isValid()) {
                get().remove(h);
            }
            return;
        }
        SEEDS.add(new Seed(h, name, size));
    }

    public static List<Seed> seeds() {
        return new ArrayList<Seed>(SEEDS);
    }

    public static void stopSeeding(final Seed seed) {
        SEEDS.remove(seed);
        if (seed.handle.isValid()) {
            get().remove(seed.handle);
        }
    }

    /** True when this torrent is already in the seeding list (it is then taken back for a re-download). */
    public static Seed takeSeed(final String hash) {
        for (final Seed s : SEEDS) {
            if (s.handle.isValid() && s.handle.infoHash().toHex().equalsIgnoreCase(hash)) {
                SEEDS.remove(s);
                return s;
            }
        }
        return null;
    }

    private static void startSeedWatcher() {
        seedWatcher = new Thread(new Runnable() {
            @Override
            public void run() {
                while (true) {
                    try {
                        Thread.sleep(10000);
                        final HakobuSettings cfg = HakobuSettings.get();
                        for (final Seed s : SEEDS) {
                            final boolean ratioReached = cfg.getSeedRatio() <= 0 || s.ratio() >= cfg.getSeedRatio();
                            final boolean timeReached = cfg.getSeedMinutes() > 0 && System.currentTimeMillis() - s.started >= cfg.getSeedMinutes() * 60000l;
                            if (!s.handle.isValid() || ratioReached || timeReached) {
                                stopSeeding(s);
                            }
                        }
                    } catch (final InterruptedException e) {
                        return;
                    } catch (final Throwable e) {
                        e.printStackTrace();
                    }
                }
            }
        }, "Hakobu seeding");
        seedWatcher.setDaemon(true);
        seedWatcher.start();
    }

    public static String describe(final TorrentStatus st) {
        return st.numPeers() + (st.numPeers() == 1 ? " peer, " : " peers, ") + (st.downloadRate() / 1024) + " KB/s down, " + (st.uploadRate() / 1024) + " KB/s up";
    }

    public static synchronized void shutdown() {
        if (session != null) {
            SEEDS.clear();
            session.stop();
            session = null;
        }
    }
}

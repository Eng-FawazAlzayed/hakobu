/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.torrent;

import java.io.File;

import com.frostwire.jlibtorrent.SessionManager;
import com.frostwire.jlibtorrent.TorrentInfo;

/**
 * One shared libtorrent session for the whole app (libtorrent is built to run one session with many torrents). Started lazily on the
 * first torrent, so people who never use torrents never open a BitTorrent port.
 */
public final class TorrentEngine {
    private static SessionManager session;

    private TorrentEngine() {
    }

    public static synchronized SessionManager get() {
        if (session == null) {
            final SessionManager s = new SessionManager();
            s.start();
            session = s;
        }
        if (!session.isRunning()) {
            session.start();
        }
        return session;
    }

    /** Waits for the DHT so magnet lookups have peers to ask. Returns early once some nodes are known. */
    public static void waitForDht(final SessionManager s, final long maxMs) throws InterruptedException {
        final long end = System.currentTimeMillis() + maxMs;
        while (System.currentTimeMillis() < end && s.stats().dhtNodes() < 10) {
            Thread.sleep(500);
        }
    }

    /** Resolves a magnet link to torrent metadata, or null on timeout. */
    public static TorrentInfo fetchMetadata(final String magnet, final int timeoutSec, final File tempDir) throws InterruptedException {
        final SessionManager s = get();
        waitForDht(s, 15000);
        tempDir.mkdirs();
        final byte[] data = s.fetchMagnet(magnet, timeoutSec, tempDir);
        return data == null ? null : TorrentInfo.bdecode(data);
    }

    public static synchronized void shutdown() {
        if (session != null) {
            session.stop();
            session = null;
        }
    }
}

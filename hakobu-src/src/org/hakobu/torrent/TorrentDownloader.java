/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.torrent;

import java.io.File;

import org.hakobu.download.ExternalDownloader;

import com.frostwire.jlibtorrent.SessionManager;
import com.frostwire.jlibtorrent.TorrentHandle;
import com.frostwire.jlibtorrent.TorrentInfo;
import com.frostwire.jlibtorrent.TorrentStatus;

import jd.plugins.DownloadLink;
import jd.plugins.PluginForHost;

/**
 * Downloads one torrent into the package folder with jlibtorrent. Existing data is re-checked by libtorrent, so stopping and starting
 * again resumes. Seeding stops when the download completes (a seeding option is a later milestone).
 */
public class TorrentDownloader extends ExternalDownloader {
    private final TorrentInfo     info;
    private volatile TorrentHandle handle;

    public TorrentDownloader(final PluginForHost plugin, final DownloadLink link, final TorrentInfo info) {
        super(plugin, link);
        this.info = info;
    }

    @Override
    protected boolean transfer(final File target) throws Exception {
        final File saveDir = target.getParentFile();
        final SessionManager s = TorrentEngine.get();
        s.download(info, saveDir);
        handle = s.find(info.infoHashV1());
        if (handle == null) {
            throw new IllegalStateException("libtorrent did not accept the torrent");
        }
        handle.resume();
        try {
            while (!externalDownloadStop()) {
                final TorrentStatus st = handle.status();
                report(st.totalWantedDone(), st.totalWanted());
                switch (st.state()) {
                case CHECKING_FILES:
                case CHECKING_RESUME_DATA:
                    status("Checking existing data " + Math.round(st.progress() * 100) + "%");
                    break;
                case DOWNLOADING_METADATA:
                    status("Fetching torrent metadata");
                    break;
                case DOWNLOADING:
                    status(st.numPeers() + " peers, " + (st.downloadRate() / 1024) + " KB/s");
                    break;
                default:
                    break;
                }
                if (st.isFinished() || st.isSeeding()) {
                    report(st.totalWanted(), st.totalWanted());
                    return true;
                }
                Thread.sleep(1000);
            }
            return false;
        } finally {
            final TorrentHandle h = handle;
            handle = null;
            if (h != null && h.isValid()) {
                /* Remove from the session but keep the files on disk. */
                s.remove(h);
            }
        }
    }

    @Override
    protected void onStop() {
        final TorrentHandle h = handle;
        if (h != null && h.isValid()) {
            h.pause();
        }
    }
}

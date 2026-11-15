/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.torrent;

import java.io.File;
import java.util.HashSet;
import java.util.Set;

import org.hakobu.download.ExternalDownloader;

import com.frostwire.jlibtorrent.Priority;
import com.frostwire.jlibtorrent.SessionManager;
import com.frostwire.jlibtorrent.TorrentHandle;
import com.frostwire.jlibtorrent.TorrentInfo;
import com.frostwire.jlibtorrent.TorrentStatus;
import com.frostwire.jlibtorrent.TorrentFlags;

import jd.plugins.DownloadLink;
import jd.plugins.PluginForHost;

/**
 * Downloads one torrent into the package folder with jlibtorrent. Existing data is re-checked by libtorrent, so stopping and starting
 * again (also after a restart) resumes. Only the files picked in the link grabber are downloaded. When done, the torrent is handed to
 * the seeding list, which stops it at the ratio/time limit from Hakobu's settings.
 */
public class TorrentDownloader extends ExternalDownloader {
    /** Link property: comma separated file indexes to download; absent = all files. */
    public static final String     PROPERTY_FILES = "hakobu_torrent_files";
    private final TorrentInfo      info;
    private volatile TorrentHandle handle;

    public TorrentDownloader(final PluginForHost plugin, final DownloadLink link, final TorrentInfo info) {
        super(plugin, link);
        this.info = info;
    }

    public static Set<Integer> selectedFiles(final DownloadLink link, final int numFiles) {
        final Set<Integer> ret = new HashSet<Integer>();
        final String sel = link.getStringProperty(PROPERTY_FILES, null);
        if (sel == null || sel.trim().isEmpty()) {
            for (int i = 0; i < numFiles; i++) {
                ret.add(i);
            }
            return ret;
        }
        for (final String s : sel.split(",")) {
            try {
                final int i = Integer.parseInt(s.trim());
                if (i >= 0 && i < numFiles) {
                    ret.add(i);
                }
            } catch (final NumberFormatException ignore) {
            }
        }
        return ret;
    }

    /** Bytes of the picked files only. */
    public static long selectedSize(final TorrentInfo ti, final DownloadLink link) {
        final Set<Integer> sel = selectedFiles(link, ti.numFiles());
        long total = 0;
        for (final int i : sel) {
            total += ti.files().fileSize(i);
        }
        return total;
    }

    @Override
    protected boolean transfer(final File target) throws Exception {
        /*
         * JD saves into a folder named after the package, which for a torrent is the torrent's own name; a multi-file torrent brings its
         * own root folder too, so save one level up to avoid "Name\Name\files".
         */
        File saveDir = target.getParentFile();
        if (info.numFiles() > 1 && saveDir.getName().equalsIgnoreCase(info.name()) && saveDir.getParentFile() != null) {
            saveDir = saveDir.getParentFile();
        }
        final SessionManager s = TorrentEngine.get();
        final String hash = info.infoHashV1().toHex();
        final TorrentEngine.Seed seed = TorrentEngine.takeSeed(hash);
        final Priority[] prio = new Priority[info.numFiles()];
        final Set<Integer> sel = selectedFiles(link, info.numFiles());
        for (int i = 0; i < prio.length; i++) {
            prio[i] = sel.contains(i) ? Priority.NORMAL : Priority.IGNORE;
        }
        if (seed != null) {
            handle = seed.handle;
            handle.prioritizeFiles(prio);
        } else {
            status("Checking existing data");
            /*
             * jlibtorrent 2.0 ignores the priorities passed to download(), so add the torrent paused, set the file priorities on the handle,
             * then resume (checked: the unpicked files are then never created).
             */
            s.download(info, saveDir, null, null, null, TorrentFlags.PAUSED);
            handle = s.find(info.infoHashV1());
            if (handle != null) {
                handle.prioritizeFiles(prio);
            }
        }
        if (handle == null) {
            throw new IllegalStateException("libtorrent did not accept the torrent");
        }
        handle.resume();
        boolean done = false;
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
                    status(TorrentEngine.describe(st));
                    break;
                default:
                    break;
                }
                if (st.totalWanted() > 0 && st.totalWantedDone() >= st.totalWanted() && (st.isFinished() || st.isSeeding())) {
                    report(st.totalWanted(), st.totalWanted());
                    done = true;
                    return true;
                }
                Thread.sleep(1000);
            }
            return false;
        } finally {
            final TorrentHandle h = handle;
            handle = null;
            if (h != null && h.isValid()) {
                if (done) {
                    TorrentEngine.finished(h, info.name(), selectedSize(info, link));
                } else {
                    /* Stopped: remove from the session but keep the files, so the next start resumes from them. */
                    s.remove(h);
                }
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

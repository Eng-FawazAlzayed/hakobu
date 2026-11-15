/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.ui;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.appwork.utils.event.queue.QueueAction;
import org.hakobu.torrent.TorrentDownloader;
import org.jdownloader.controlling.UniqueAlltimeID;
import org.jdownloader.plugins.ConditionalSkipReason;
import org.jdownloader.plugins.FinalLinkState;
import org.jdownloader.plugins.SkipReason;
import org.jdownloader.settings.GeneralSettings;

import jd.controlling.downloadcontroller.DownloadController;
import jd.controlling.downloadcontroller.DownloadWatchDog;
import jd.controlling.downloadcontroller.SingleDownloadController;
import jd.controlling.linkcollector.LinkCollectingJob;
import jd.controlling.linkcollector.LinkCollector;
import jd.controlling.linkcollector.LinkOrigin;
import jd.controlling.linkcrawler.CrawledLink;
import jd.controlling.linkcrawler.CrawledPackage;
import jd.plugins.DownloadLink;
import jd.plugins.FilePackage;
import jd.plugins.PluginProgress;
import jd.plugins.hoster.HakobuTorrent;
import jd.plugins.hoster.HakobuYtDlp;

/**
 * The only place the Hakobu window talks to JD's engine. Everything here works on JD's own controllers (link collector, download list,
 * download watchdog), so the engine behaves exactly as in JDownloader; only the screens differ.
 */
public final class Engine {
    private Engine() {
    }

    /* ---------------- link grabber ---------------- */
    public static final class GrabItem {
        public long    id;
        public String  name, host, kind, thumb, heights, quality, packageName, state;
        public long    size, duration;
        public int     torrentFiles;
        public String  torrentSelection;
    }

    /** Sends pasted text through JD's link crawler, exactly like pasting into JDownloader. */
    public static void addLinks(final String text) {
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        final LinkCollectingJob job = new LinkCollectingJob(LinkOrigin.ADD_LINKS_DIALOG.getLinkOriginDetails(), text);
        LinkCollector.getInstance().addCrawlerJob(job);
    }

    public static boolean isCrawling() {
        return LinkCollector.getInstance().isCollecting() || jd.controlling.linkcrawler.LinkCrawler.isCrawling();
    }

    static String kindOf(final DownloadLink dl) {
        final String k = dl.getStringProperty(HakobuTorrent.PROPERTY_KIND, null);
        if (k != null) {
            return k;
        }
        final String host = dl.getHost();
        if ("torrent".equals(host)) {
            return "torrent";
        }
        if ("yt-dlp".equals(host)) {
            return "video";
        }
        return "direct";
    }

    public static List<GrabItem> grabbed() {
        final List<GrabItem> ret = new ArrayList<GrabItem>();
        for (final CrawledPackage pkg : LinkCollector.getInstance().getPackagesCopy()) {
            final List<CrawledLink> children;
            final boolean readL = pkg.getModifyLock().readLock();
            try {
                children = new ArrayList<CrawledLink>(pkg.getChildren());
            } finally {
                pkg.getModifyLock().readUnlock(readL);
            }
            for (final CrawledLink cl : children) {
                final DownloadLink dl = cl.getDownloadLink();
                if (dl == null) {
                    continue;
                }
                final GrabItem g = new GrabItem();
                g.id = cl.getUniqueID().getID();
                g.name = cl.getName();
                g.host = cl.getHost();
                g.size = cl.getSize();
                g.packageName = pkg.getName();
                g.state = String.valueOf(cl.getLinkState());
                g.kind = kindOf(dl);
                g.thumb = dl.getStringProperty(HakobuYtDlp.PROPERTY_THUMB, null);
                g.heights = dl.getStringProperty(HakobuYtDlp.PROPERTY_HEIGHTS, null);
                g.duration = dl.getLongProperty(HakobuYtDlp.PROPERTY_DURATION, 0);
                g.quality = "video".equals(g.kind) ? HakobuYtDlp.quality(dl) : null;
                g.torrentFiles = dl.getIntegerProperty(HakobuTorrent.PROPERTY_FILECOUNT, 0);
                g.torrentSelection = dl.getStringProperty(TorrentDownloader.PROPERTY_FILES, null);
                ret.add(g);
            }
        }
        return ret;
    }

    static CrawledLink findCrawled(final long id) {
        for (final CrawledLink cl : LinkCollector.getInstance().getAllChildren()) {
            if (cl.getUniqueID().getID() == id) {
                return cl;
            }
        }
        return null;
    }

    public static void setQuality(final long id, final String quality) {
        final CrawledLink cl = findCrawled(id);
        if (cl != null && cl.getDownloadLink() != null) {
            HakobuYtDlp.setQuality(cl.getDownloadLink(), quality);
            cl.setName(cl.getDownloadLink().getName());
        }
    }

    /** Torrent file picker result: indexes to download (null = all). Also updates the size shown. */
    public static void setTorrentFiles(final long id, final Set<Integer> files) {
        final CrawledLink cl = findCrawled(id);
        if (cl == null || cl.getDownloadLink() == null) {
            return;
        }
        final DownloadLink dl = cl.getDownloadLink();
        if (files == null) {
            dl.removeProperty(TorrentDownloader.PROPERTY_FILES);
        } else {
            final StringBuilder sb = new StringBuilder();
            for (final Integer i : files) {
                sb.append(sb.length() > 0 ? "," : "").append(i);
            }
            dl.setProperty(TorrentDownloader.PROPERTY_FILES, sb.toString());
        }
        try {
            dl.setVerifiedFileSize(TorrentDownloader.selectedSize(HakobuTorrent.loadInfo(dl), dl));
        } catch (final Throwable ignore) {
        }
    }

    public static DownloadLink grabbedLink(final long id) {
        final CrawledLink cl = findCrawled(id);
        return cl != null ? cl.getDownloadLink() : null;
    }

    public static void removeGrabbed(final Set<Long> ids) {
        final List<CrawledLink> rem = new ArrayList<CrawledLink>();
        for (final CrawledLink cl : LinkCollector.getInstance().getAllChildren()) {
            if (ids.contains(cl.getUniqueID().getID())) {
                rem.add(cl);
            }
        }
        LinkCollector.getInstance().removeChildren(rem);
    }

    /** Moves the picked grabber rows to the download list and starts downloading. */
    public static void startGrabbed(final Set<Long> ids, final boolean start) {
        LinkCollector.getInstance().getQueue().add(new QueueAction<Void, RuntimeException>() {
            @Override
            protected Void run() throws RuntimeException {
                final List<CrawledLink> links = new ArrayList<CrawledLink>();
                for (final CrawledLink cl : LinkCollector.getInstance().getAllChildren()) {
                    if (ids.contains(cl.getUniqueID().getID())) {
                        links.add(cl);
                    }
                }
                if (links.isEmpty()) {
                    return null;
                }
                final List<FilePackage> fps = LinkCollector.getInstance().convert(links, true);
                if (fps != null && !fps.isEmpty()) {
                    DownloadController.getInstance().addAllAt(fps, -(fps.size() + 10));
                }
                if (start) {
                    DownloadWatchDog.getInstance().startDownloads();
                }
                return null;
            }
        });
    }

    /* ---------------- downloads ---------------- */
    public static final class DlItem {
        public long    id;
        public String  name, packageName, host, kind, state, message, folder;
        public long    loaded, total, speed, eta;
        public boolean enabled;
    }

    public static List<DlItem> downloads() {
        final List<DlItem> ret = new ArrayList<DlItem>();
        for (final FilePackage fp : DownloadController.getInstance().getPackagesCopy()) {
            final List<DownloadLink> children;
            final boolean readL = fp.getModifyLock().readLock();
            try {
                children = new ArrayList<DownloadLink>(fp.getChildren());
            } finally {
                fp.getModifyLock().readUnlock(readL);
            }
            for (final DownloadLink dl : children) {
                final DlItem d = new DlItem();
                d.id = dl.getUniqueID().getID();
                d.name = dl.getView().getDisplayName();
                d.packageName = children.size() > 1 ? fp.getName() : null;
                d.host = dl.getHost();
                d.kind = kindOf(dl);
                d.enabled = dl.isEnabled();
                d.loaded = dl.getView().getBytesLoaded();
                d.total = dl.getView().getBytesTotalEstimated();
                d.folder = fp.getDownloadDirectory();
                final SingleDownloadController ctrl = dl.getDownloadLinkController();
                final FinalLinkState fin = dl.getFinalLinkState();
                final SkipReason skip = dl.getSkipReason();
                final ConditionalSkipReason cond = dl.getConditionalSkipReason();
                final PluginProgress pp = dl.getPluginProgress();
                if (fin != null && FinalLinkState.CheckFinished(fin)) {
                    d.state = "completed";
                    d.message = null;
                    if (d.total <= 0) {
                        d.total = d.loaded;
                    }
                } else if (fin != null) {
                    d.state = "error";
                    d.message = fin.getExplanation(null, dl);
                } else if (ctrl != null) {
                    d.state = "downloading";
                    d.speed = Math.max(dl.getView().getSpeedBps(), measuredSpeed(d.id, d.loaded));
                    String msg = null;
                    try {
                        msg = ctrl.getLinkStatus().getStatusText();
                    } catch (final Throwable ignore) {
                    }
                    if (msg == null && pp != null) {
                        msg = pp.getMessage(null);
                    }
                    if (cond != null && !cond.isConditionReached()) {
                        msg = cond.getMessage(null, dl);
                        d.state = "waiting";
                    }
                    d.message = msg;
                    if (d.speed > 0 && d.total > d.loaded) {
                        d.eta = (d.total - d.loaded) / d.speed;
                    }
                } else if (skip != null) {
                    d.state = "error";
                    d.message = skip.getExplanation(null, dl);
                } else if (cond != null && !cond.isConditionReached()) {
                    d.state = "waiting";
                    d.message = cond.getMessage(null, dl);
                } else if (!dl.isEnabled()) {
                    d.state = "paused";
                } else {
                    d.state = "queued";
                }
                ret.add(d);
            }
        }
        return ret;
    }

    private static final java.util.Map<Long, double[]> SPEED = new java.util.concurrent.ConcurrentHashMap<Long, double[]>();

    /**
     * Speed from the change in loaded bytes between two refreshes, smoothed. JD measures speed on its own HTTP connections only, so
     * torrents and yt-dlp downloads need this.
     */
    static long measuredSpeed(final long id, final long loaded) {
        final long now = System.currentTimeMillis();
        final double[] s = SPEED.get(id);
        if (s == null || loaded < s[0]) {
            SPEED.put(id, new double[] { loaded, now, 0 });
            return 0;
        }
        final double dt = (now - s[1]) / 1000.0;
        if (dt < 0.4) {
            return (long) s[2];
        }
        final double inst = (loaded - s[0]) / dt;
        s[2] = s[2] == 0 ? inst : s[2] * 0.6 + inst * 0.4;
        s[0] = loaded;
        s[1] = now;
        return (long) s[2];
    }

    /** Upload speed of all torrents (downloading and seeding). */
    public static long torrentUploadRate() {
        return org.hakobu.torrent.TorrentEngine.isRunning() ? org.hakobu.torrent.TorrentEngine.get().uploadRate() : 0;
    }

    static List<DownloadLink> findLinks(final Set<Long> ids) {
        final List<DownloadLink> ret = new ArrayList<DownloadLink>();
        for (final DownloadLink dl : DownloadController.getInstance().getAllChildren()) {
            if (ids.contains(dl.getUniqueID().getID())) {
                ret.add(dl);
            }
        }
        return ret;
    }

    public static void startAll() {
        DownloadWatchDog.getInstance().startDownloads();
    }

    public static void stopAll() {
        DownloadWatchDog.getInstance().stopDownloads();
    }

    public static boolean isRunning() {
        return DownloadWatchDog.getInstance().isRunning();
    }

    /** Pause = disable the link (JD stops it and skips it); resume = enable and force-start it. */
    public static void pause(final Set<Long> ids) {
        for (final DownloadLink dl : findLinks(ids)) {
            dl.setEnabled(false);
        }
    }

    public static void resume(final Set<Long> ids) {
        final List<DownloadLink> links = findLinks(ids);
        final List<DownloadLink> retry = new ArrayList<DownloadLink>();
        for (final DownloadLink dl : links) {
            dl.setEnabled(true);
            if (dl.getFinalLinkState() != null && !FinalLinkState.CheckFinished(dl.getFinalLinkState())) {
                retry.add(dl);
            } else if (dl.getSkipReason() != null) {
                retry.add(dl);
            }
        }
        if (!retry.isEmpty()) {
            DownloadWatchDog.getInstance().reset(retry);
        }
        DownloadWatchDog.getInstance().forceDownload(links);
    }

    /** Removes from the list; files on disk stay. */
    public static void remove(final Set<Long> ids) {
        final List<DownloadLink> links = findLinks(ids);
        for (final DownloadLink dl : links) {
            dl.setEnabled(false);
        }
        DownloadController.getInstance().removeChildren(links);
    }

    public static void clearCompleted() {
        final Set<Long> ids = new HashSet<Long>();
        for (final DownloadLink dl : DownloadController.getInstance().getAllChildren()) {
            if (dl.getFinalLinkState() != null && FinalLinkState.CheckFinished(dl.getFinalLinkState())) {
                ids.add(dl.getUniqueID().getID());
            }
        }
        remove(ids);
    }

    public static File fileOf(final long id) {
        final Set<Long> ids = new HashSet<Long>();
        ids.add(id);
        for (final DownloadLink dl : findLinks(ids)) {
            return new File(dl.getFileOutput());
        }
        return null;
    }

    public static String downloadFolder() {
        return org.appwork.storage.config.JsonConfig.create(GeneralSettings.class).getDefaultDownloadFolder();
    }

    public static void setDownloadFolder(final String folder) {
        org.appwork.storage.config.JsonConfig.create(GeneralSettings.class).setDefaultDownloadFolder(folder);
    }

    public static int maxDownloads() {
        return org.appwork.storage.config.JsonConfig.create(GeneralSettings.class).getMaxSimultaneDownloads();
    }

    public static void setMaxDownloads(final int n) {
        org.appwork.storage.config.JsonConfig.create(GeneralSettings.class).setMaxSimultaneDownloads(n);
    }

    @SuppressWarnings("unused")
    private static UniqueAlltimeID unusedImport() {
        return null;
    }
}

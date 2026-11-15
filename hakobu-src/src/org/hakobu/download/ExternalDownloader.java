/*
 * Hakobu (Java) - a fork built on JDownloader 2.
 * Copyright (C) 2026 Hakobu contributors. Based on JDownloader 2 (C) JD-Team / AppWork GmbH.
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 */
package org.hakobu.download;

import java.awt.Color;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;

import org.appwork.exceptions.WTFException;
import org.appwork.utils.logging2.LogSource;
import org.jdownloader.plugins.DownloadPluginProgress;

import jd.http.Browser;
import jd.http.URLConnectionAdapter;
import jd.plugins.DownloadLink;
import jd.plugins.DownloadLink.AvailableStatus;
import jd.plugins.LinkStatus;
import jd.plugins.PluginException;
import jd.plugins.PluginForHost;
import jd.controlling.downloadcontroller.DiskSpaceReservation;
import jd.plugins.download.DownloadInterface;
import jd.plugins.download.DownloadLinkDownloadable;
import jd.plugins.download.Downloadable;
import jd.controlling.downloadcontroller.ManagedThrottledConnectionHandler;

/**
 * Base class for downloads that are not done by JD's own HTTP engine (torrents through jlibtorrent, video sites through yt-dlp). It
 * hooks into JD's download controller the same way JD's TextDownloader does: reserve disk space, show a progress bar, report bytes,
 * honour the stop button, and mark the link finished.
 */
public abstract class ExternalDownloader extends DownloadInterface {
    protected final Downloadable                    downloadable;
    protected final DownloadLink                    link;
    private final ManagedThrottledConnectionHandler connectionHandler = new ManagedThrottledConnectionHandler();
    private final AtomicBoolean                     abort             = new AtomicBoolean(false);
    private volatile long                           bytesLoaded       = 0;
    private long                                    startTimeStamp    = -1;

    protected ExternalDownloader(final PluginForHost plugin, final DownloadLink link) {
        if (plugin == null || link == null) {
            throw new IllegalArgumentException();
        }
        this.link = link;
        this.downloadable = new DownloadLinkDownloadable(link);
        downloadable.setDownloadInterface(this);
    }

    /** Progress callback for subclasses. */
    protected void report(final long loaded, final long total) {
        this.bytesLoaded = loaded;
        if (total > 0) {
            downloadable.setDownloadTotalBytes(total);
        }
        downloadable.setDownloadBytesLoaded(loaded);
    }

    /** Status text under the link, such as "Fetching torrent metadata". */
    protected void status(final String text) {
        downloadable.setLinkStatusText(text);
    }

    /**
     * Does the transfer. Must poll {@link #externalDownloadStop()} and return quickly once it is true.
     *
     * @param target
     *            the file JD expects (its parent folder is the package download folder)
     * @return true when the transfer completed
     */
    protected abstract boolean transfer(File target) throws Exception;

    @Override
    public boolean startDownload() throws Exception {
        downloadable.validateLastChallengeResponse();
        downloadable.setConnectionHandler(connectionHandler);
        final DiskSpaceReservation reservation = downloadable.createDiskSpaceReservation();
        DownloadPluginProgress progress = null;
        final File target = new File(downloadable.getFinalFileOutput());
        try {
            downloadable.checkAndReserve(reservation);
            if (target.getParentFile() != null) {
                target.getParentFile().mkdirs();
            }
            startTimeStamp = System.currentTimeMillis();
            progress = new DownloadPluginProgress(downloadable, this, new Color(0x2f, 0x80, 0xed));
            downloadable.addPluginProgress(progress);
            downloadable.setAvailable(AvailableStatus.TRUE);
            final boolean done = transfer(target);
            if (externalDownloadStop()) {
                return false;
            }
            if (!done) {
                throw new PluginException(LinkStatus.ERROR_DOWNLOAD_FAILED);
            }
            downloadable.setVerifiedFileSize(bytesLoaded);
            downloadable.setLinkStatus(LinkStatus.FINISHED);
            return true;
        } finally {
            try {
                downloadable.free(reservation);
            } catch (final Throwable e) {
                LogSource.exception(downloadable.getLogger(), e);
            }
            if (startTimeStamp > 0) {
                downloadable.addDownloadTime(System.currentTimeMillis() - startTimeStamp);
            }
            if (progress != null) {
                downloadable.removePluginProgress(progress);
            }
            downloadable.removeConnectionHandler(connectionHandler);
        }
    }

    public long getBytesLoaded() {
        return bytesLoaded;
    }

    @Override
    public ManagedThrottledConnectionHandler getManagedConnetionHandler() {
        return connectionHandler;
    }

    @Override
    public URLConnectionAdapter connect(final Browser br) throws Exception {
        throw new WTFException("Not used by external downloads");
    }

    @Override
    public long getTotalLinkBytesLoadedLive() {
        return bytesLoaded;
    }

    @Override
    public URLConnectionAdapter getConnection() {
        return null;
    }

    @Override
    public void stopDownload() {
        if (!abort.getAndSet(true)) {
            downloadable.getLogger().info("Stop requested");
            onStop();
        }
    }

    /** Called once when the user presses stop. */
    protected void onStop() {
    }

    @Override
    public boolean externalDownloadStop() {
        return abort.get();
    }

    @Override
    public long getStartTimeStamp() {
        return startTimeStamp;
    }

    @Override
    public void close() {
    }

    @Override
    public Downloadable getDownloadable() {
        return downloadable;
    }

    @Override
    public boolean isResumedDownload() {
        return false;
    }

}

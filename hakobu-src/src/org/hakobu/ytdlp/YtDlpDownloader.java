/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.ytdlp;

import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;

import org.hakobu.download.ExternalDownloader;

import jd.plugins.DownloadLink;
import jd.plugins.PluginForHost;

/** Runs one yt-dlp download inside JD's download controller. */
public class YtDlpDownloader extends ExternalDownloader {
    private final String        url;
    private final String        quality;
    private final AtomicBoolean stop = new AtomicBoolean(false);

    public YtDlpDownloader(final PluginForHost plugin, final DownloadLink link, final String url, final String quality) {
        super(plugin, link);
        this.url = url;
        this.quality = quality;
    }

    @Override
    protected boolean transfer(final File target) throws Exception {
        status("Starting yt-dlp");
        YtDlp.download(url, target, quality, new YtDlp.Progress() {
            @Override
            public void update(final long loaded, final long total, final String text) {
                report(loaded, total);
                if (text != null) {
                    status(text);
                }
            }
        }, stop);
        if (stop.get()) {
            return false;
        }
        if (target.isFile()) {
            report(target.length(), target.length());
            return true;
        }
        throw new java.io.IOException("yt-dlp finished but " + target.getName() + " is missing");
    }

    @Override
    protected void onStop() {
        stop.set(true);
    }
}

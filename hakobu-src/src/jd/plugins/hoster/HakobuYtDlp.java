/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package jd.plugins.hoster;

import java.util.Map;

import org.hakobu.ytdlp.YtDlp;
import org.hakobu.ytdlp.YtDlpDownloader;

import jd.PluginWrapper;
import jd.plugins.Account;
import jd.plugins.DownloadLink;
import jd.plugins.DownloadLink.AvailableStatus;
import jd.plugins.HostPlugin;
import jd.plugins.LinkStatus;
import jd.plugins.PluginException;
import jd.plugins.PluginForHost;

/**
 * Video sites through yt-dlp. Links look like ytdlp://https://... (the crawler creates them, and anyone can force a site through
 * yt-dlp by pasting that form).
 */
@HostPlugin(revision = "$Revision: 1 $", interfaceVersion = 3, names = { "yt-dlp" }, urls = { "ytdlp://https?://.+" })
public class HakobuYtDlp extends PluginForHost {
    public HakobuYtDlp(final PluginWrapper wrapper) {
        super(wrapper);
    }

    public static String wrap(final String url) {
        return "ytdlp://" + url;
    }

    static String sourceUrl(final DownloadLink link) {
        return link.getPluginPatternMatcher().replaceFirst("^ytdlp://", "");
    }

    @Override
    public String getAGBLink() {
        return "https://github.com/yt-dlp/yt-dlp";
    }

    @Override
    public String getLinkID(final DownloadLink link) {
        /* JD asks for the ID while the link is still being built, before the URL is set. */
        if (link.getPluginPatternMatcher() == null) {
            return super.getLinkID(link);
        }
        return "ytdlp://" + sourceUrl(link);
    }

    @Override
    public int getMaxSimultanFreeDownloadNum() {
        return 3;
    }

    @Override
    public boolean isResumeable(final DownloadLink link, final Account account) {
        return true;
    }

    public static String safeName(final String title) {
        return title.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
    }

    /** Fills name and size from yt-dlp's metadata. Used by the crawler too. */
    public static void apply(final DownloadLink link, final Map<String, Object> info) {
        final Object title = info.get("title");
        if (title != null) {
            link.setFinalFileName(safeName(title.toString()) + ".mp4");
        }
        long size = 0;
        final Object reqs = info.get("requested_formats");
        if (reqs instanceof java.util.List) {
            for (final Object o : (java.util.List<?>) reqs) {
                size += sizeOf((Map<?, ?>) o);
            }
        }
        if (size <= 0) {
            size = sizeOf(info);
        }
        if (size > 0) {
            link.setDownloadSize(size);
        }
        link.setAvailable(true);
    }

    private static long sizeOf(final Map<?, ?> m) {
        for (final String k : new String[] { "filesize", "filesize_approx" }) {
            final Object v = m.get(k);
            if (v instanceof Number && ((Number) v).longValue() > 0) {
                return ((Number) v).longValue();
            }
        }
        return 0;
    }

    @Override
    public AvailableStatus requestFileInformation(final DownloadLink link) throws Exception {
        try {
            apply(link, YtDlp.probe(sourceUrl(link)));
        } catch (final java.io.IOException e) {
            final String msg = String.valueOf(e.getMessage());
            if (msg.contains("Video unavailable") || msg.contains("removed") || msg.contains("404")) {
                throw new PluginException(LinkStatus.ERROR_FILE_NOT_FOUND, msg);
            }
            throw new PluginException(LinkStatus.ERROR_TEMPORARILY_UNAVAILABLE, msg, 60 * 1000l);
        }
        return AvailableStatus.TRUE;
    }

    @Override
    public void handleFree(final DownloadLink link) throws Exception {
        if (link.getFinalFileName() == null) {
            requestFileInformation(link);
        }
        dl = new YtDlpDownloader(this, link, sourceUrl(link));
        try {
            dl.startDownload();
        } catch (final java.io.IOException e) {
            throw new PluginException(LinkStatus.ERROR_TEMPORARILY_UNAVAILABLE, e.getMessage(), 60 * 1000l);
        }
    }

    @Override
    public boolean hasCaptcha(final DownloadLink link, final Account acc) {
        return false;
    }

    @Override
    public void reset() {
    }

    @Override
    public void resetDownloadlink(final DownloadLink link) {
    }
}

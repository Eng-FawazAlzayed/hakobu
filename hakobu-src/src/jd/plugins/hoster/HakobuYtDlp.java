/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package jd.plugins.hoster;

import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import org.hakobu.HakobuSettings;
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
 * yt-dlp by pasting that form). The quality picked in Hakobu's link grabber is stored on the link.
 */
@HostPlugin(revision = "$Revision: 2 $", interfaceVersion = 3, names = { "yt-dlp" }, urls = { "ytdlp://https?://.+" })
public class HakobuYtDlp extends PluginForHost {
    public static final String PROPERTY_QUALITY  = "hakobu_quality";
    public static final String PROPERTY_THUMB    = "hakobu_thumb";
    public static final String PROPERTY_DURATION = "hakobu_duration";
    public static final String PROPERTY_HEIGHTS  = "hakobu_heights";
    public static final String PROPERTY_TITLE    = "hakobu_title";

    public HakobuYtDlp(final PluginWrapper wrapper) {
        super(wrapper);
    }

    public static String wrap(final String url) {
        return "ytdlp://" + url;
    }

    public static String sourceUrl(final DownloadLink link) {
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

    public static String quality(final DownloadLink link) {
        final String q = link.getStringProperty(PROPERTY_QUALITY, null);
        return q != null ? q : HakobuSettings.get().getVideoQuality();
    }

    /** Sets the quality and renames the file to match (.m4a for audio only, .mp4 otherwise). */
    public static void setQuality(final DownloadLink link, final String quality) {
        link.setProperty(PROPERTY_QUALITY, quality);
        final String title = link.getStringProperty(PROPERTY_TITLE, null);
        if (title != null) {
            link.setFinalFileName(safeName(title) + (YtDlp.isAudio(quality) ? ".m4a" : ".mp4"));
        }
    }

    /** Thumbnail that always exists for a YouTube video ID. */
    public static String youtubeThumb(final String id) {
        return "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
    }

    /** Fills name, size, thumbnail, length and available heights from yt-dlp's metadata. Used by the crawler too. */
    public static void apply(final DownloadLink link, final Map<String, Object> info) {
        link.setProperty(HakobuTorrent.PROPERTY_KIND, "video");
        final Object title = info.get("title");
        if (title != null) {
            link.setProperty(PROPERTY_TITLE, title.toString());
        }
        final Object id = info.get("id");
        final Object extractor = info.get("extractor_key");
        if (id != null && extractor != null && extractor.toString().toLowerCase().startsWith("youtube")) {
            link.setProperty(PROPERTY_THUMB, youtubeThumb(id.toString()));
        } else if (info.get("thumbnail") != null) {
            link.setProperty(PROPERTY_THUMB, info.get("thumbnail").toString());
        }
        final Object duration = info.get("duration");
        if (duration instanceof Number) {
            link.setProperty(PROPERTY_DURATION, ((Number) duration).longValue());
        }
        final TreeSet<Integer> heights = new TreeSet<Integer>();
        final Object formats = info.get("formats");
        if (formats instanceof List) {
            for (final Object o : (List<?>) formats) {
                final Object h = ((Map<?, ?>) o).get("height");
                if (h instanceof Number && ((Number) h).intValue() >= 144) {
                    heights.add(((Number) h).intValue());
                }
            }
        }
        if (!heights.isEmpty()) {
            final StringBuilder sb = new StringBuilder();
            for (final Integer h : heights.descendingSet()) {
                if (sb.length() > 0) {
                    sb.append(',');
                }
                sb.append(h);
            }
            link.setProperty(PROPERTY_HEIGHTS, sb.toString());
        }
        setQuality(link, quality(link));
        long size = 0;
        final Object reqs = info.get("requested_formats");
        if (reqs instanceof List) {
            for (final Object o : (List<?>) reqs) {
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
            if (msg.contains("Video unavailable") || msg.contains("removed") || msg.contains("404") || msg.contains("Private video") || msg.contains("Unsupported URL")) {
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
        dl = new YtDlpDownloader(this, link, sourceUrl(link), quality(link));
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

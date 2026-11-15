/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package jd.plugins.decrypter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.hakobu.ytdlp.YtDlp;

import jd.PluginWrapper;
import jd.controlling.ProgressController;
import jd.plugins.CryptedLink;
import jd.plugins.DecrypterPlugin;
import jd.plugins.DownloadLink;
import jd.plugins.FilePackage;
import jd.plugins.LinkStatus;
import jd.plugins.PluginException;
import jd.plugins.PluginForDecrypt;
import jd.plugins.hoster.HakobuYtDlp;

/**
 * Link grabber side of yt-dlp: turns a YouTube video or playlist link into one link-grabber row per video, with name and size, without
 * opening any browser. (In this fork JD's own YouTube crawler is switched off, so yt-dlp handles YouTube.)
 */
@DecrypterPlugin(revision = "$Revision: 1 $", interfaceVersion = 3, names = { "youtube.com" }, urls = { "https?://(?:(?:www|m|music)\\.)?(?:youtube\\.com/(?:watch\\?[^\\s\"'<>]*v=[\\w-]{11}[^\\s\"'<>]*|shorts/[\\w-]{11}[^\\s\"'<>]*|live/[\\w-]{11}[^\\s\"'<>]*|playlist\\?[^\\s\"'<>]*list=[\\w-]+[^\\s\"'<>]*)|youtu\\.be/[\\w-]{11}[^\\s\"'<>]*)" })
public class HakobuYtDlpCrawler extends PluginForDecrypt {
    public HakobuYtDlpCrawler(final PluginWrapper wrapper) {
        super(wrapper);
    }

    @Override
    public ArrayList<DownloadLink> decryptIt(final CryptedLink param, final ProgressController progress) throws Exception {
        final String url = param.getCryptedUrl();
        final ArrayList<DownloadLink> ret = new ArrayList<DownloadLink>();
        final Map<String, Object> info;
        try {
            info = YtDlp.probe(url);
        } catch (final java.io.IOException e) {
            /* Show the link as an offline row with yt-dlp's reason instead of silently dropping it. */
            ret.add(createOfflinelink(url, null, e.getMessage()));
            return ret;
        }
        final Object entries = info.get("entries");
        if ("playlist".equals(info.get("_type")) && entries instanceof List) {
            final FilePackage fp = FilePackage.getInstance();
            fp.setName(String.valueOf(info.get("title")));
            for (final Object o : (List<?>) entries) {
                final Map<?, ?> e = (Map<?, ?>) o;
                final Object id = e.get("id");
                if (id == null) {
                    continue;
                }
                final DownloadLink dl = createDownloadlink(HakobuYtDlp.wrap("https://www.youtube.com/watch?v=" + id));
                dl.setProperty(jd.plugins.hoster.HakobuTorrent.PROPERTY_KIND, "video");
                dl.setProperty(HakobuYtDlp.PROPERTY_THUMB, HakobuYtDlp.youtubeThumb(id.toString()));
                final Object duration = e.get("duration");
                if (duration instanceof Number) {
                    dl.setProperty(HakobuYtDlp.PROPERTY_DURATION, ((Number) duration).longValue());
                }
                final Object title = e.get("title");
                if (title != null) {
                    dl.setProperty(HakobuYtDlp.PROPERTY_TITLE, title.toString());
                    HakobuYtDlp.setQuality(dl, HakobuYtDlp.quality(dl));
                }
                dl.setAvailable(true);
                fp.add(dl);
                ret.add(dl);
            }
        } else {
            final DownloadLink dl = createDownloadlink(HakobuYtDlp.wrap(url));
            HakobuYtDlp.apply(dl, info);
            ret.add(dl);
        }
        return ret;
    }
}

/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package jd.plugins.hoster;

import java.io.File;
import java.util.Locale;

import org.appwork.utils.Application;
import org.appwork.utils.IO;
import org.appwork.utils.Regex;
import org.hakobu.torrent.TorrentDownloader;
import org.hakobu.torrent.TorrentEngine;

import com.frostwire.jlibtorrent.TorrentInfo;

import jd.PluginWrapper;
import jd.plugins.DownloadLink;
import jd.plugins.DownloadLink.AvailableStatus;
import jd.plugins.HostPlugin;
import jd.plugins.LinkStatus;
import jd.plugins.PluginException;
import jd.plugins.PluginForHost;

/**
 * Magnet links through jlibtorrent. The link grabber check resolves the magnet to its metadata (name and size) the same way a host
 * plugin checks a file host link, and the download runs in the shared libtorrent session.
 */
@HostPlugin(revision = "$Revision: 1 $", interfaceVersion = 3, names = { "torrent" }, urls = { "magnet:\\?[^\\s\"'<>]*xt=urn:bt(?:ih|mh):[^\\s\"'<>]+" })
public class HakobuTorrent extends PluginForHost {
    private static final int METADATA_TIMEOUT_SEC = 90;

    public HakobuTorrent(final PluginWrapper wrapper) {
        super(wrapper);
    }

    @Override
    public String getAGBLink() {
        return "https://www.bittorrent.org/beps/bep_0009.html";
    }

    @Override
    public boolean isResumeable(final DownloadLink link, final jd.plugins.Account account) {
        return true;
    }

    @Override
    public int getMaxSimultanFreeDownloadNum() {
        return -1;
    }

    private static String infoHash(final String magnet) {
        final String h = new Regex(magnet, "xt=urn:btih:([A-Za-z0-9]{32,40})").getMatch(0);
        return h == null ? null : h.toLowerCase(Locale.ENGLISH);
    }

    @Override
    public String getLinkID(final DownloadLink link) {
        final String h = infoHash(link.getPluginPatternMatcher());
        return h != null ? "torrent://" + h : super.getLinkID(link);
    }

    private static File cacheFile(final String hash) {
        return Application.getResource("cfg/hakobu/torrents/" + hash + ".torrent");
    }

    /** Metadata from the local cache, or from the swarm (DHT/trackers) the first time. */
    private TorrentInfo loadInfo(final DownloadLink link) throws Exception {
        final String magnet = link.getPluginPatternMatcher();
        final String hash = infoHash(magnet);
        if (hash != null) {
            final File f = cacheFile(hash);
            if (f.isFile()) {
                return TorrentInfo.bdecode(IO.readFile(f));
            }
        }
        final File tmp = Application.getTempResource("hakobu-magnet");
        final TorrentInfo ti = TorrentEngine.fetchMetadata(magnet, METADATA_TIMEOUT_SEC, tmp);
        if (ti == null) {
            throw new PluginException(LinkStatus.ERROR_TEMPORARILY_UNAVAILABLE, "No peers sent the torrent metadata yet", 5 * 60 * 1000l);
        }
        if (hash != null) {
            final File f = cacheFile(hash);
            f.getParentFile().mkdirs();
            IO.writeToFile(f, ti.bencode());
        }
        return ti;
    }

    @Override
    public AvailableStatus requestFileInformation(final DownloadLink link) throws Exception {
        final String dn = new Regex(link.getPluginPatternMatcher(), "[?&]dn=([^&]+)").getMatch(0);
        if (dn != null && link.getFinalFileName() == null) {
            link.setName(java.net.URLDecoder.decode(dn, "UTF-8"));
        }
        final TorrentInfo ti = loadInfo(link);
        link.setFinalFileName(ti.name());
        link.setVerifiedFileSize(ti.totalSize());
        return AvailableStatus.TRUE;
    }

    @Override
    public void handleFree(final DownloadLink link) throws Exception {
        requestFileInformation(link);
        final TorrentInfo ti = loadInfo(link);
        dl = new TorrentDownloader(this, link, ti);
        dl.startDownload();
    }

    @Override
    public boolean hasCaptcha(final DownloadLink link, final jd.plugins.Account acc) {
        return false;
    }

    @Override
    public void reset() {
    }

    @Override
    public void resetDownloadlink(final DownloadLink link) {
    }
}

/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package jd.plugins.hoster;

import java.io.File;

import org.appwork.utils.Application;
import org.appwork.utils.Regex;
import org.hakobu.torrent.TorrentDownloader;
import org.hakobu.torrent.TorrentEngine;

import com.frostwire.jlibtorrent.TorrentInfo;

import jd.PluginWrapper;
import jd.plugins.Account;
import jd.plugins.DownloadLink;
import jd.plugins.DownloadLink.AvailableStatus;
import jd.plugins.HostPlugin;
import jd.plugins.LinkStatus;
import jd.plugins.PluginException;
import jd.plugins.PluginForHost;

/**
 * Magnet links through jlibtorrent (.torrent files and links become magnet links backed by Hakobu's metadata cache). The link grabber
 * check resolves the metadata (name, size, file list) the same way a host plugin checks a file host link; the download runs in the
 * shared libtorrent session.
 */
@HostPlugin(revision = "$Revision: 2 $", interfaceVersion = 3, names = { "torrent" }, urls = { "magnet:\\?[^\\s\"'<>]*xt=urn:bt(?:ih|mh):[^\\s\"'<>]+" })
public class HakobuTorrent extends PluginForHost {
    private static final int   METADATA_TIMEOUT_SEC = 90;
    public static final String PROPERTY_KIND        = "hakobu_kind";
    public static final String PROPERTY_FILECOUNT   = "hakobu_torrent_filecount";

    public HakobuTorrent(final PluginWrapper wrapper) {
        super(wrapper);
    }

    @Override
    public String getAGBLink() {
        return "https://www.bittorrent.org/beps/bep_0009.html";
    }

    @Override
    public boolean isResumeable(final DownloadLink link, final Account account) {
        return true;
    }

    @Override
    public int getMaxSimultanFreeDownloadNum() {
        return -1;
    }

    @Override
    public String getLinkID(final DownloadLink link) {
        final String h = TorrentEngine.infoHash(link.getPluginPatternMatcher());
        return h != null ? "torrent://" + h : super.getLinkID(link);
    }

    /** Metadata from the local cache, or from the swarm (DHT/trackers) the first time. */
    public static TorrentInfo loadInfo(final DownloadLink link) throws Exception {
        final File tmp = Application.getTempResource("hakobu-magnet");
        final TorrentInfo ti = TorrentEngine.fetchMetadata(link.getPluginPatternMatcher(), METADATA_TIMEOUT_SEC, tmp);
        if (ti == null) {
            throw new PluginException(LinkStatus.ERROR_TEMPORARILY_UNAVAILABLE, "No peers sent the torrent metadata yet", 5 * 60 * 1000l);
        }
        return ti;
    }

    @Override
    public AvailableStatus requestFileInformation(final DownloadLink link) throws Exception {
        link.setProperty(PROPERTY_KIND, "torrent");
        link.setProperty("hakobu_external_files", true);
        final String dn = new Regex(link.getPluginPatternMatcher(), "[?&]dn=([^&]+)").getMatch(0);
        if (dn != null && link.getFinalFileName() == null) {
            link.setName(java.net.URLDecoder.decode(dn, "UTF-8"));
        }
        final TorrentInfo ti = loadInfo(link);
        link.setFinalFileName(ti.name());
        link.setProperty(PROPERTY_FILECOUNT, ti.numFiles());
        link.setVerifiedFileSize(TorrentDownloader.selectedSize(ti, link));
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

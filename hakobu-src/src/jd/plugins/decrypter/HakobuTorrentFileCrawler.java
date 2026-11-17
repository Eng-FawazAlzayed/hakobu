/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package jd.plugins.decrypter;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.URI;
import java.util.ArrayList;

import org.appwork.utils.IO;
import org.hakobu.torrent.TorrentEngine;

import com.frostwire.jlibtorrent.TorrentInfo;

import jd.PluginWrapper;
import jd.controlling.ProgressController;
import jd.http.URLConnectionAdapter;
import jd.plugins.CryptedLink;
import jd.plugins.DecrypterPlugin;
import jd.plugins.DownloadLink;
import jd.plugins.LinkStatus;
import jd.plugins.PluginException;
import jd.plugins.PluginForDecrypt;

/**
 * .torrent links and local .torrent files: reads the torrent once, stores its metadata in Hakobu's cache and hands a magnet link to the
 * torrent plugin, so no DHT lookup is needed.
 */
@DecrypterPlugin(revision = "$Revision: 1 $", interfaceVersion = 3, names = { "torrentfile" }, urls = { "(?:https?://(?![^\\s\"'<>]*/announce)[^\\s\"'<>]+\\.torrent(?![\\w.\\-])(?:\\?[^\\s\"'<>]*)?|file:/[^\\s\"'<>]+\\.torrent(?![\\w.\\-]))" })
public class HakobuTorrentFileCrawler extends PluginForDecrypt {
    private static final int MAX_BYTES = 20 * 1024 * 1024;

    public HakobuTorrentFileCrawler(final PluginWrapper wrapper) {
        super(wrapper);
    }

    public static String magnetForFile(final File f) throws Exception {
        return TorrentEngine.store(TorrentInfo.bdecode(IO.readFile(f)));
    }

    @Override
    public ArrayList<DownloadLink> decryptIt(final CryptedLink param, final ProgressController progress) throws Exception {
        final String url = param.getCryptedUrl();
        final byte[] data;
        if (url.startsWith("file:")) {
            final File f = new File(new URI(url.replace(" ", "%20")));
            if (!f.isFile()) {
                throw new PluginException(LinkStatus.ERROR_FILE_NOT_FOUND);
            }
            data = IO.readFile(f);
        } else {
            br.setFollowRedirects(true);
            final URLConnectionAdapter con = br.openGetConnection(url);
            try {
                if (con.getResponseCode() == 404 || con.getResponseCode() == 410) {
                    throw new PluginException(LinkStatus.ERROR_FILE_NOT_FOUND);
                }
                if (con.getResponseCode() != 200) {
                    throw new PluginException(LinkStatus.ERROR_TEMPORARILY_UNAVAILABLE, "HTTP " + con.getResponseCode());
                }
                final InputStream in = con.getInputStream();
                final ByteArrayOutputStream bos = new ByteArrayOutputStream();
                final byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    bos.write(buf, 0, n);
                    if (bos.size() > MAX_BYTES) {
                        throw new PluginException(LinkStatus.ERROR_FILE_NOT_FOUND, "Too large to be a .torrent file");
                    }
                }
                data = bos.toByteArray();
            } finally {
                con.disconnect();
            }
        }
        final TorrentInfo ti;
        try {
            ti = TorrentInfo.bdecode(data);
        } catch (final Throwable e) {
            throw new PluginException(LinkStatus.ERROR_FILE_NOT_FOUND, "Not a valid .torrent file");
        }
        final ArrayList<DownloadLink> ret = new ArrayList<DownloadLink>();
        final DownloadLink dl = createDownloadlink(TorrentEngine.store(ti));
        dl.setFinalFileName(ti.name());
        dl.setDownloadSize(ti.totalSize());
        dl.setProperty(jd.plugins.hoster.HakobuTorrent.PROPERTY_KIND, "torrent");
        dl.setProperty("hakobu_external_files", true);
        dl.setProperty(jd.plugins.hoster.HakobuTorrent.PROPERTY_FILECOUNT, ti.numFiles());
        dl.setAvailable(true);
        ret.add(dl);
        return ret;
    }
}

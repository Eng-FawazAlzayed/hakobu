package org.hakobu.test;

import java.io.File;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import org.hakobu.torrent.TorrentEngine;
import org.hakobu.ytdlp.YtDlp;

import com.frostwire.jlibtorrent.SessionManager;
import com.frostwire.jlibtorrent.TorrentHandle;
import com.frostwire.jlibtorrent.TorrentInfo;

/** Smoke test of the two non-JD engines, outside the JD UI. Args: outDir */
public class EngineSmokeTest {
    public static void main(String[] args) throws Exception {
        org.appwork.utils.Application.setApplication(".hakobu_test");
        final File out = new File(args[0]);
        out.mkdirs();
        /* yt-dlp: probe + download a 19 s public video */
        final String yt = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
        long t = System.currentTimeMillis();
        final Map<String, Object> info = YtDlp.probe(yt);
        System.out.println("YTDLP probe " + (System.currentTimeMillis() - t) + " ms: " + info.get("title") + " / " + info.get("duration") + " s");
        final File target = new File(out, "zoo.mp4");
        t = System.currentTimeMillis();
        YtDlp.download(yt, target, (loaded, total, text) -> System.out.println("YTDLP progress " + loaded + "/" + total + (text != null ? " " + text : "")), new AtomicBoolean());
        System.out.println("YTDLP download " + (System.currentTimeMillis() - t) + " ms, file=" + target.isFile() + " size=" + target.length());
        /* jlibtorrent: Big Buck Bunny (CC-BY), metadata + 30 s of downloading */
        final String magnet = "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=wss%3A%2F%2Ftracker.webtorrent.dev";
        t = System.currentTimeMillis();
        final TorrentInfo ti = TorrentEngine.fetchMetadata(magnet, 90, new File(out, "tmp"));
        System.out.println("TORRENT metadata " + (System.currentTimeMillis() - t) + " ms: " + (ti == null ? "TIMEOUT" : ti.name() + " " + ti.totalSize() + " bytes, " + ti.numFiles() + " files"));
        if (ti != null) {
            final SessionManager s = TorrentEngine.get();
            s.download(ti, out);
            final TorrentHandle h = s.find(ti.infoHashV1());
            for (int i = 0; i < 30; i++) {
                Thread.sleep(1000);
                System.out.println("TORRENT " + h.status().state() + " " + h.status().totalWantedDone() + "/" + h.status().totalWanted() + " peers=" + h.status().numPeers());
            }
            s.remove(h);
        }
        TorrentEngine.shutdown();
        System.exit(0);
    }
}

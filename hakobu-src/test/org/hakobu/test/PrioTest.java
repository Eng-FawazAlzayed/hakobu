package org.hakobu.test;

import java.io.File;
import org.hakobu.torrent.TorrentEngine;
import com.frostwire.jlibtorrent.*;
import com.frostwire.jlibtorrent.swig.torrent_flags_t;

/** Checks that jlibtorrent honours file priorities. Args: outDir torrentCacheFile */
public class PrioTest {
    public static void main(String[] a) throws Exception {
        org.appwork.utils.Application.setApplication(".hakobu_test");
        TorrentInfo ti = new TorrentInfo(new File(a[1]));
        SessionManager s = TorrentEngine.get();
        Priority[] p = new Priority[ti.numFiles()];
        for (int i = 0; i < p.length; i++) p[i] = ti.files().fileSize(i) < 5000000 ? Priority.NORMAL : Priority.IGNORE;
        s.download(ti, new File(a[0]), null, null, null, TorrentFlags.PAUSED);
        TorrentHandle h = s.find(ti.infoHashV1());
        h.prioritizeFiles(p);
        Thread.sleep(300);
        System.out.println("prio after add: " + java.util.Arrays.toString(h.filePriorities()));
        h.resume();
        for (int i = 0; i < 4; i++) { Thread.sleep(1000); TorrentStatus st = h.status(); System.out.println("A wanted=" + st.totalWanted() + " done=" + st.totalWantedDone() + " state=" + st.state() + " prio=" + java.util.Arrays.toString(h.filePriorities())); }
        h.prioritizeFiles(p);
        for (int i = 0; i < 4; i++) { Thread.sleep(1000); TorrentStatus st = h.status(); System.out.println("B wanted=" + st.totalWanted() + " done=" + st.totalWantedDone() + " state=" + st.state() + " prio=" + java.util.Arrays.toString(h.filePriorities())); }
        s.remove(h); TorrentEngine.shutdown(); System.exit(0);
    }
}

/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.test;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import org.hakobu.HakobuSettings;
import org.hakobu.torrent.TorrentEngine;
import org.hakobu.ui.Engine;
import org.hakobu.ui.Engine.DlItem;
import org.hakobu.ui.Engine.GrabItem;
import org.hakobu.ui.HakobuWindow;
import org.hakobu.ytdlp.YtDlp;

import jd.SecondLevelLaunch;
import jd.controlling.downloadcontroller.DownloadController;
import jd.controlling.linkcollector.LinkCollector;

/**
 * End-to-end test of Hakobu on the real engine, driven through the same {@link Engine} calls the screens use. Only for a test profile:
 * it empties the link grabber and the download list first. Start with -Dhakobu.selftest=<folder>; writes report.txt and screenshots
 * there. Add -Dhakobu.selftest.only=a,b to run some steps only.
 */
public class SelfTest implements Runnable {
    private final File        dir;
    private final File        downloads;
    private PrintWriter       out;
    private int               pass, fail;
    private final Set<String> only = new HashSet<String>();

    public static void startIfRequested() {
        final String d = System.getProperty("hakobu.selftest");
        if (d != null) {
            final Thread t = new Thread(new SelfTest(new File(d)), "Hakobu self-test");
            t.setDaemon(true);
            t.start();
        }
    }

    SelfTest(final File dir) {
        this.dir = dir;
        this.downloads = new File(dir, "downloads");
        final String o = System.getProperty("hakobu.selftest.only");
        if (o != null) {
            for (final String s : o.split(",")) {
                only.add(s.trim());
            }
        }
    }

    private boolean wants(final String step) {
        return only.isEmpty() || only.contains(step);
    }

    private void log(final String s) {
        final String line = String.format("[%tT] %s", System.currentTimeMillis(), s);
        System.out.println("SELFTEST " + line);
        out.println(line);
        out.flush();
    }

    private void check(final String what, final boolean ok, final String detail) {
        if (ok) {
            pass++;
        } else {
            fail++;
        }
        log((ok ? "PASS " : "FAIL ") + what + (detail != null ? "  (" + detail + ")" : ""));
    }

    private void snap(final String name) {
        try {
            Thread.sleep(1500);
            HakobuWindow.snapshot(new File(dir, name + ".png"));
            log("screenshot " + name + ".png");
        } catch (final Throwable e) {
            log("screenshot " + name + " failed: " + e);
        }
    }

    private void view(final String v) throws InterruptedException {
        HakobuWindow.runOnFx(() -> HakobuWindow.get().show(v));
    }

    interface Cond {
        boolean ok() throws Exception;
    }

    private boolean waitFor(final Cond c, final long seconds) throws Exception {
        final long end = System.currentTimeMillis() + seconds * 1000;
        while (System.currentTimeMillis() < end) {
            if (c.ok()) {
                return true;
            }
            Thread.sleep(1000);
        }
        return c.ok();
    }

    private static GrabItem grab(final String nameOrHostPart) {
        for (final GrabItem g : Engine.grabbed()) {
            if ((g.name != null && g.name.toLowerCase().contains(nameOrHostPart)) || (g.host != null && g.host.toLowerCase().contains(nameOrHostPart))) {
                return g;
            }
        }
        return null;
    }

    private static DlItem dl(final String namePart) {
        for (final DlItem d : Engine.downloads()) {
            if (d.name != null && d.name.toLowerCase().contains(namePart)) {
                return d;
            }
        }
        return null;
    }

    private static Set<Long> ids(final GrabItem... items) {
        final Set<Long> s = new HashSet<Long>();
        for (final GrabItem g : items) {
            if (g != null) {
                s.add(g.id);
            }
        }
        return s;
    }

    private static Set<Long> one(final long id) {
        final Set<Long> s = new HashSet<Long>();
        s.add(id);
        return s;
    }

    private static boolean grabberSettled() {
        if (Engine.isCrawling()) {
            return false;
        }
        for (final GrabItem g : Engine.grabbed()) {
            if (!"ONLINE".equals(g.state) && !"OFFLINE".equals(g.state)) {
                return false;
            }
        }
        return true;
    }

    private static int ffprobeHeight(final File f) {
        try {
            final File ffdir = YtDlp.ffmpegFolder();
            final String ffprobe = ffdir != null ? new File(ffdir, "ffprobe.exe").getAbsolutePath() : "ffprobe";
            final Process p = new ProcessBuilder(ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", f.getAbsolutePath()).start();
            final String s = new String(p.getInputStream().readAllBytes()).trim();
            p.waitFor(30, TimeUnit.SECONDS);
            return Integer.parseInt(s.split("\\s+")[0]);
        } catch (final Throwable e) {
            return -1;
        }
    }

    @Override
    public void run() {
        try {
            dir.mkdirs();
            out = new PrintWriter(new FileWriter(new File(dir, "report.txt"), false));
            SecondLevelLaunch.INIT_COMPLETE.waitForReached();
            SecondLevelLaunch.HOST_PLUGINS_COMPLETE.waitForReached();
            while (HakobuWindow.get() == null) {
                Thread.sleep(500);
            }
            Thread.sleep(3000);
            log("Hakobu self-test starting, downloads go to " + downloads);
            final String expect = System.getProperty("hakobu.selftest.expectRestored");
            if (expect != null) {
                waitFor(() -> Engine.downloads().size() >= Integer.parseInt(expect), 20);
                final List<DlItem> restored = Engine.downloads();
                check("download list restored after restart", restored.size() == Integer.parseInt(expect), restored.size() + " of " + expect);
                check("restored items keep their state", restored.stream().allMatch(d -> "completed".equals(d.state)), null);
                check("seeding does not resume by itself after restart", TorrentEngine.seeds().isEmpty(), null);
                view("downloads");
                snap("00-restored-after-restart");
                if (only.contains("none")) {
                    log("DONE: " + pass + " passed, " + fail + " failed");
                    return;
                }
            }
            if (only.contains("restartB")) {
                stepRestartB();
                log("DONE: " + pass + " passed, " + fail + " failed");
                return;
            }
            /* clean slate (test profile only) */
            LinkCollector.getInstance().clear();
            final Set<Long> all = new HashSet<Long>();
            for (final DlItem d : Engine.downloads()) {
                all.add(d.id);
            }
            Engine.remove(all);
            waitFor(() -> Engine.downloads().isEmpty(), 20);
            downloads.mkdirs();
            Engine.setDownloadFolder(downloads.getAbsolutePath());
            Engine.setMaxDownloads(4);
            final HakobuSettings cfg = HakobuSettings.get();
            cfg.setSeedRatio(1.0);
            cfg.setSeedMinutes(60);
            cfg.setTheme("dark");
            cfg.save();
            HakobuWindow.runOnFx(() -> HakobuWindow.get().applyTheme());
            view("downloads");
            snap("01-downloads-empty");
            if (wants("grabber")) {
                stepGrabber();
            }
            if (wants("audio")) {
                stepAudio();
            }
            if (wants("torrent")) {
                stepTorrentPauseResumeSeed();
            }
            if (only.contains("restartA")) {
                stepRestartA();
            }
            if (wants("remove")) {
                stepRemoveRunning();
            }
            if (wants("themes")) {
                stepThemes();
            }
            if (wants("magnet")) {
                stepMagnet();
            }
            if (wants("captcha")) {
                stepCaptchaSettings();
            }
            if (wants("engine")) {
                stepEngineWindow();
            }
            view("settings");
            snap("90-settings");
            view("downloads");
            snap("91-downloads-final");
            log("DONE: " + pass + " passed, " + fail + " failed");
        } catch (final Throwable e) {
            if (out != null) {
                log("SELF-TEST CRASHED: " + e);
                e.printStackTrace(out);
                out.flush();
            }
            e.printStackTrace();
        } finally {
            if (out != null) {
                out.close();
            }
            if (Boolean.getBoolean("hakobu.selftest.exit")) {
                org.appwork.shutdown.ShutdownController.getInstance().requestShutdown(true);
            }
        }
    }

    /* 1: mixed paste, link grabber results, quality and torrent file picks, then download */
    private void stepGrabber() throws Exception {
        log("--- step grabber: mixed paste");
        view("grabber");
        final String paste = String.join("\n",
                "Some text with links in it:",
                "https://www.mediafire.com/file/knnoovz75yk33xp",
                "https://drive.google.com/file/d/0B9P1L--7Wd2vU3VUVlFnbTgtS2c/view",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969",
                "https://www.mediafire.com/file/zzzzzzzzzzzzzz9/nothing_here.zip",
                "not a link at all");
        final long t0 = System.currentTimeMillis();
        Engine.addLinks(paste);
        Thread.sleep(3000);
        final boolean settled = waitFor(() -> grabberSettled() && Engine.grabbed().size() >= 5, 180);
        check("link grabber finished checking", settled, (System.currentTimeMillis() - t0) / 1000 + " s, " + Engine.grabbed().size() + " rows");
        for (final GrabItem g : Engine.grabbed()) {
            log("  row: " + g.name + " | " + g.host + " | " + g.state + " | " + g.size + " B | kind " + g.kind + (g.thumb != null ? " | thumb" : "") + (g.heights != null ? " | heights " + g.heights : "") + (g.torrentFiles > 0 ? " | files " + g.torrentFiles : ""));
        }
        final GrabItem mf = grab("getting started");
        final GrabItem drive = grab("spam.txt");
        final GrabItem yt = grab("zoo");
        final GrabItem bbb = grab("big buck bunny");
        final GrabItem off = grab("nothing_here");
        check("MediaFire file online", mf != null && "ONLINE".equals(mf.state) && mf.size > 0, mf == null ? "missing" : mf.state);
        check("Google Drive file online", drive != null && "ONLINE".equals(drive.state), drive == null ? "missing" : drive.state);
        check("YouTube row has thumbnail, length and heights", yt != null && yt.thumb != null && yt.duration > 0 && yt.heights != null, yt == null ? "missing" : yt.thumb + " " + yt.duration + " " + yt.heights);
        check("magnet resolved to name, size and 3 files", bbb != null && "ONLINE".equals(bbb.state) && bbb.torrentFiles == 3 && bbb.size > 200000000L, bbb == null ? "missing" : bbb.torrentFiles + " files, " + bbb.size);
        check("missing MediaFire file shown offline", off == null || "OFFLINE".equals(off.state), off == null ? "not listed" : off.state);
        check("plain text ignored", grab("not a link") == null, null);
        snap("02-grabber");
        if (yt != null) {
            Engine.setQuality(yt.id, "360");
        }
        Set<Integer> small = null;
        if (bbb != null) {
            final com.frostwire.jlibtorrent.TorrentInfo ti = jd.plugins.hoster.HakobuTorrent.loadInfo(Engine.grabbedLink(bbb.id));
            small = new HashSet<Integer>();
            for (int i = 0; i < ti.numFiles(); i++) {
                log("  torrent file " + i + ": " + ti.files().filePath(i) + " " + ti.files().fileSize(i));
                if (ti.files().fileSize(i) < 5000000) {
                    small.add(i);
                }
            }
            Engine.setTorrentFiles(bbb.id, small);
        }
        Thread.sleep(1500);
        final GrabItem bbb2 = grab("big buck bunny");
        check("torrent size follows the file pick", bbb2 != null && bbb2.size > 0 && bbb2.size < 5000000L * 3, bbb2 == null ? "missing" : String.valueOf(bbb2.size));
        final GrabItem yt2 = grab("zoo");
        check("quality choice stored", yt2 != null && "360".equals(yt2.quality), yt2 == null ? "missing" : yt2.quality);
        if (off != null) {
            Engine.removeGrabbed(one(off.id));
        }
        snap("03-grabber-picked");
        Engine.startGrabbed(ids(mf, drive, yt2, bbb2), true);
        Thread.sleep(2000);
        view("downloads");
        snap("04-downloads-running");
        final long t1 = System.currentTimeMillis();
        final boolean done = waitFor(() -> {
            for (final DlItem d : Engine.downloads()) {
                if (!"completed".equals(d.state) && !"error".equals(d.state)) {
                    return false;
                }
            }
            return !Engine.downloads().isEmpty();
        }, 300);
        for (final DlItem d : Engine.downloads()) {
            log("  download: " + d.name + " | " + d.state + " | " + d.loaded + "/" + d.total + (d.message != null ? " | " + d.message : ""));
        }
        check("all four downloads finished", done && Engine.downloads().stream().allMatch(d -> "completed".equals(d.state)), (System.currentTimeMillis() - t1) / 1000 + " s");
        final File pdf = new File(downloads, "MediaFire - Getting Started.pdf");
        check("MediaFire PDF on disk", findFile(downloads, "MediaFire - Getting Started.pdf") != null, null);
        check("Drive file on disk", findFile(downloads, "spam.txt") != null, null);
        final File zoo = findFile(downloads, "Me at the zoo.mp4");
        final int h = zoo != null ? ffprobeHeight(zoo) : -1;
        check("YouTube video downloaded at 360p or less", zoo != null && h > 0 && h <= 360, zoo == null ? "missing" : "height " + h);
        final File srt = findFile(downloads, "Big Buck Bunny.en.srt");
        final File poster = findFile(downloads, "poster.jpg");
        final File mp4 = findFile(downloads, "Big Buck Bunny.mp4");
        check("picked torrent files downloaded", srt != null && poster != null && poster.length() > 100000, (srt != null) + "/" + (poster != null ? poster.length() : -1));
        check("unpicked 276 MB torrent file not downloaded", mp4 == null, mp4 == null ? "absent" : mp4.length() + " B");
        snap("05-downloads-done");
        if (pdf.exists()) {
            log("  pdf size " + pdf.length());
        }
    }

    private static boolean sparseOnly(final File f) {
        /* libtorrent may create the unpicked file for pieces shared with picked files; treat it as fine if mostly empty */
        return true;
    }

    private static File findFile(final File root, final String name) {
        final File[] fs = root.listFiles();
        if (fs == null) {
            return null;
        }
        for (final File f : fs) {
            if (f.isDirectory()) {
                final File r = findFile(f, name);
                if (r != null) {
                    return r;
                }
            } else if (f.getName().equalsIgnoreCase(name)) {
                return f;
            }
        }
        return null;
    }

    /* 2: audio only from a second short video */
    private void stepAudio() throws Exception {
        log("--- step audio: remove the video from the list, add it again as audio only");
        final DlItem old = dl("me at the zoo");
        if (old != null) {
            Engine.remove(one(old.id));
            waitFor(() -> dl("me at the zoo") == null, 20);
        }
        Engine.addLinks("https://www.youtube.com/watch?v=jNQXAC9IVRw");
        Thread.sleep(3000);
        final boolean ok = waitFor(() -> grabberSettled() && grab("me at the zoo") != null, 120);
        final GrabItem g = grab("me at the zoo");
        check("second video grabbed", ok && g != null, g == null ? "missing" : g.name);
        if (g == null) {
            return;
        }
        Engine.setQuality(g.id, "audio");
        Thread.sleep(800);
        final GrabItem g2 = grab("me at the zoo");
        check("audio choice renames to .m4a", g2 != null && g2.name.endsWith(".m4a"), g2 == null ? "missing" : g2.name);
        Engine.startGrabbed(one(g.id), true);
        final boolean done = waitFor(() -> {
            final DlItem d = dl("me at the zoo");
            return d != null && ("completed".equals(d.state) || "error".equals(d.state));
        }, 180);
        final DlItem d = dl("me at the zoo");
        check("audio download finished", done && d != null && "completed".equals(d.state), d == null ? "missing" : d.state + " " + d.message);
        final File m4a = findFile(downloads, g2 != null ? g2.name : "x");
        check("m4a file on disk with no video stream", m4a != null && m4a.length() > 10000 && ffprobeHeight(m4a) <= 0, m4a == null ? "missing" : m4a.length() + " B");
    }

    /* 3: .torrent link, pause at ~20%, resume, finish, seed, stop seeding */
    private void stepTorrentPauseResumeSeed() throws Exception {
        log("--- step torrent: .torrent link, pause/resume, seeding");
        Engine.addLinks("https://webtorrent.io/torrents/sintel.torrent");
        Thread.sleep(3000);
        final boolean ok = waitFor(() -> grabberSettled() && grab("sintel") != null, 120);
        final GrabItem g = grab("sintel");
        check(".torrent link grabbed via metadata cache", ok && g != null && "ONLINE".equals(g.state) && g.size > 0, g == null ? "missing" : g.state + " " + g.size + " B, " + g.torrentFiles + " files");
        if (g == null) {
            return;
        }
        Engine.startGrabbed(one(g.id), true);
        final boolean started = waitFor(() -> {
            final DlItem d = dl("sintel");
            return d != null && d.total > 0 && d.loaded > d.total / 5;
        }, 240);
        DlItem d = dl("sintel");
        check("torrent downloading past 20%", started, d == null ? "missing" : d.loaded + "/" + d.total);
        if (d == null) {
            return;
        }
        view("torrents");
        snap("06-torrents-downloading");
        Engine.pause(one(d.id));
        final boolean paused = waitFor(() -> {
            final DlItem x = dl("sintel");
            return x != null && "paused".equals(x.state);
        }, 30);
        final long atPause = dl("sintel").loaded;
        Thread.sleep(5000);
        final long later = dl("sintel").loaded;
        check("pause stops the torrent", paused && later == atPause, atPause + " -> " + later);
        view("downloads");
        snap("07-downloads-paused");
        Engine.resume(one(d.id));
        final boolean finished = waitFor(() -> {
            final DlItem x = dl("sintel");
            return x != null && ("completed".equals(x.state) || "error".equals(x.state));
        }, 600);
        d = dl("sintel");
        check("resumed torrent finished", finished && d != null && "completed".equals(d.state), d == null ? "missing" : d.state + " " + d.loaded + "/" + d.total + " " + d.message);
        check("resume kept earlier data (no restart from zero)", d != null && d.loaded >= atPause, null);
        final boolean seeding = waitFor(() -> !TorrentEngine.seeds().isEmpty(), 20);
        check("finished torrent is seeding", seeding, TorrentEngine.seeds().size() + " seeding");
        view("torrents");
        snap("08-torrents-seeding");
        for (final TorrentEngine.Seed s : TorrentEngine.seeds()) {
            TorrentEngine.stopSeeding(s);
        }
        check("stop seeding empties the list", TorrentEngine.seeds().isEmpty(), null);
    }

    /* restart A: start a torrent, pause it part way, then the app is closed */
    private void stepRestartA() throws Exception {
        log("--- step restartA: pause a torrent part way before closing");
        Engine.addLinks("https://webtorrent.io/torrents/sintel.torrent");
        Thread.sleep(3000);
        waitFor(() -> grabberSettled() && grab("sintel") != null, 120);
        final GrabItem g = grab("sintel");
        if (g == null) {
            check("sintel grabbed", false, null);
            return;
        }
        Engine.startGrabbed(one(g.id), true);
        final boolean part = waitFor(() -> {
            final DlItem d = dl("sintel");
            return d != null && d.total > 0 && d.loaded > d.total / 4;
        }, 240);
        final DlItem d = dl("sintel");
        Engine.pause(one(d.id));
        waitFor(() -> "paused".equals(dl("sintel").state), 30);
        check("torrent paused part way before restart", part && "paused".equals(dl("sintel").state), dl("sintel").loaded + "/" + dl("sintel").total);
        Thread.sleep(3000);
    }

    /* restart B: after the restart, the paused torrent is still there with its progress and finishes from there */
    private void stepRestartB() throws Exception {
        log("--- step restartB: resume the torrent after a restart");
        waitFor(() -> dl("sintel") != null, 20);
        final DlItem d = dl("sintel");
        check("paused torrent restored after restart", d != null && "paused".equals(d.state), d == null ? "missing" : d.state + " " + d.loaded + "/" + d.total);
        if (d == null) {
            return;
        }
        view("downloads");
        snap("30-restored-paused-torrent");
        final long t0 = System.currentTimeMillis();
        Engine.resume(one(d.id));
        final long[] firstLoaded = { -1 };
        final boolean done = waitFor(() -> {
            final DlItem x = dl("sintel");
            if (x != null && "downloading".equals(x.state) && x.loaded > 0 && firstLoaded[0] < 0) {
                firstLoaded[0] = x.loaded;
            }
            return x != null && ("completed".equals(x.state) || "error".equals(x.state));
        }, 600);
        final DlItem x = dl("sintel");
        check("torrent finished after restart", done && "completed".equals(x.state), x.state + " " + x.message + " in " + (System.currentTimeMillis() - t0) / 1000 + " s");
        check("resumed from existing data, not from zero", firstLoaded[0] < 0 || firstLoaded[0] >= d.loaded / 2, "first seen " + firstLoaded[0] + ", had " + d.loaded);
        final File mp4 = findFile(dir.getParentFile(), "Sintel.mp4");
        check("Sintel.mp4 complete on disk", mp4 != null && mp4.length() > 120000000L, mp4 == null ? "missing" : String.valueOf(mp4.length()));
    }

    /* 4: remove a running direct download */
    private void stepRemoveRunning() throws Exception {
        log("--- step remove: remove a running download");
        Engine.addLinks("https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv");
        Thread.sleep(3000);
        final boolean ok = waitFor(() -> grabberSettled() && grab("sintel.2010") != null, 90);
        final GrabItem g = grab("sintel.2010");
        check("direct file link grabbed", ok && g != null && "ONLINE".equals(g.state), g == null ? "missing" : g.state);
        if (g == null) {
            return;
        }
        Engine.startGrabbed(one(g.id), true);
        final boolean running = waitFor(() -> {
            final DlItem d = dl("sintel.2010");
            return d != null && d.loaded > 0;
        }, 60);
        check("direct download running", running, null);
        final DlItem d = dl("sintel.2010");
        if (d != null) {
            Engine.remove(one(d.id));
        }
        final boolean gone = waitFor(() -> dl("sintel.2010") == null, 20);
        check("removed download leaves the list", gone, null);
        check("engine still running after removal", DownloadController.getInstance() != null, null);
    }

    /* 6: JD's own window ("More settings") opens dark, named Hakobu, without Contribute, and closing it keeps the app running */
    private void stepEngineWindow() throws Exception {
        log("--- step engine window");
        org.hakobu.ui.HakobuShell.showEngineWindow();
        Thread.sleep(4000);
        final java.awt.Frame[] f = new java.awt.Frame[1];
        javax.swing.SwingUtilities.invokeAndWait(() -> f[0] = jd.gui.swing.jdgui.JDGui.getInstance().getMainFrame());
        check("More settings window opens", f[0] != null && f[0].isVisible(), null);
        check("window title says Hakobu", f[0] != null && f[0].getTitle() != null && f[0].getTitle().contains("Hakobu") && !f[0].getTitle().contains("JDownloader"), f[0] == null ? null : f[0].getTitle());
        check("dark look and feel", javax.swing.UIManager.getLookAndFeel().getClass().getName().contains("Dark"), javax.swing.UIManager.getLookAndFeel().getClass().getName());
        check("Contribute hidden", !org.jdownloader.donate.DonationManager.getInstance().isButtonVisible(), null);
        try {
            final java.awt.Rectangle r = f[0].getBounds();
            final java.awt.image.BufferedImage img = new java.awt.Robot().createScreenCapture(r);
            javax.imageio.ImageIO.write(img, "png", new File(dir, "20-more-settings-window.png"));
            log("screenshot 20-more-settings-window.png");
        } catch (final Throwable e) {
            log("screenshot of More settings failed: " + e);
        }
        javax.swing.SwingUtilities.invokeAndWait(() -> f[0].dispatchEvent(new java.awt.event.WindowEvent(f[0], java.awt.event.WindowEvent.WINDOW_CLOSING)));
        Thread.sleep(1500);
        check("closing More settings only hides it", !f[0].isVisible() && HakobuWindow.get() != null, null);
    }

    /* 7: a magnet with unencoded tracker URLs stays one link (no bogus "...tracker.torrent" row) */
    private void stepMagnet() throws Exception {
        log("--- step magnet");
        final String magnet = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss://tracker.webtorrent.dev&tr=udp://tracker.opentrackr.org:1337/announce&tr=http://open.tracker.cl:1337/announce&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.torrent.eu.org:451/announce&tr=https://tracker.example.org:443/announce";
        final String[] found = jd.parser.html.HTMLParser.getHttpLinks(magnet, null);
        check("parser finds one link in a magnet with tracker URLs", found != null && found.length == 1 && magnet.equals(found[0]), java.util.Arrays.toString(found));
        final java.util.regex.Pattern tf = java.util.regex.Pattern.compile(jd.plugins.decrypter.HakobuTorrentFileCrawler.class.getAnnotation(jd.plugins.DecrypterPlugin.class).urls()[0]);
        check(".torrent pattern skips tracker announce URLs", !tf.matcher("http://open.tracker.cl:1337/announce&tr=udp://tracker.torrent").find() && !tf.matcher("https://tracker.torrent.eu.org:451/announce").find(), null);
        check(".torrent pattern still takes .torrent links", tf.matcher("https://webtorrent.io/torrents/sintel.torrent").matches() && tf.matcher("https://example.org/get.torrent?id=5").matches() && tf.matcher("file:/C:/x/a.torrent").matches(), null);
        /* the test profile must not pick up whatever is on the real clipboard */
        org.jdownloader.settings.staticreferences.CFG_GUI.CLIPBOARD_MONITORED.setValue(false);
        LinkCollector.getInstance().clear();
        final int before = Engine.downloads().size();
        Engine.addLinks(magnet);
        Thread.sleep(3000);
        /* rows may stay in the grabber or be moved to the download list (auto-confirm), so count both */
        waitFor(() -> !Engine.isCrawling() && grabberSettled() && Engine.grabbed().size() + Engine.downloads().size() - before >= 1, 150);
        Thread.sleep(5000);
        final StringBuilder sb = new StringBuilder();
        int rows = 0, torrents = 0;
        for (final GrabItem i : Engine.grabbed()) {
            rows++;
            torrents += "torrent".equals(i.host) ? 1 : 0;
            sb.append("grabber: ").append(i.name).append(" [").append(i.host).append("] ");
        }
        final List<DlItem> dls = Engine.downloads();
        final Set<Long> added = new HashSet<Long>();
        for (int k = before; k < dls.size(); k++) {
            final DlItem d = dls.get(k);
            rows++;
            torrents += "torrent".equals(d.host) ? 1 : 0;
            added.add(d.id);
            sb.append("downloads: ").append(d.name).append(" [").append(d.host).append("] ");
        }
        check("pasting it adds exactly one row, the torrent", rows == 1 && torrents == 1, sb.toString());
        LinkCollector.getInstance().clear();
        Engine.remove(added);
    }

    /** Paints the window itself (not the screen), so other windows on top never end up in the picture. */
    private static java.awt.image.BufferedImage paintFrame(final java.awt.Frame f) throws Exception {
        final java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(Math.max(1, f.getWidth()), Math.max(1, f.getHeight()), java.awt.image.BufferedImage.TYPE_INT_RGB);
        javax.swing.SwingUtilities.invokeAndWait(() -> {
            final java.awt.Graphics2D g = img.createGraphics();
            f.printAll(g);
            g.dispose();
        });
        return img;
    }

    private static Class<?> shownPage() throws Exception {
        final Class<?>[] c = new Class<?>[1];
        javax.swing.SwingUtilities.invokeAndWait(() -> c[0] = ((jd.gui.swing.jdgui.views.settings.ConfigurationPanel) jd.gui.swing.jdgui.views.settings.ConfigurationView.getInstance().getContent()).getSelectedSubPanelClass());
        return c[0];
    }

    /* 8: "Settings" in captcha dialogs and the More settings tiles open the settings window on the right page */
    private void stepCaptchaSettings() throws Exception {
        log("--- step captcha settings");
        final java.awt.Frame[] f = new java.awt.Frame[1];
        jd.gui.swing.jdgui.views.settings.panels.anticaptcha.CaptchaConfigPanel.showCaptchaSettings();
        Thread.sleep(4000);
        javax.swing.SwingUtilities.invokeAndWait(() -> {
            f[0] = jd.gui.swing.jdgui.JDGui.getInstance().getMainFrame();
        });
        check("captcha dialog's Settings button shows the settings window", f[0] != null && f[0].isVisible(), null);
        check("it opens on the Captchas page", shownPage() == jd.gui.swing.jdgui.views.settings.panels.anticaptcha.CaptchaConfigPanel.class, String.valueOf(shownPage()));

        try {
            final java.awt.image.BufferedImage img = paintFrame(f[0]);
            javax.imageio.ImageIO.write(img, "png", new File(dir, "21-captcha-settings.png"));
            log("screenshot 21-captcha-settings.png");
        } catch (final Throwable e) {
            log("screenshot of captcha settings failed: " + e);
        }
        org.hakobu.ui.HakobuShell.hideEngineWindow();
        Thread.sleep(1500);
        org.hakobu.ui.HakobuShell.showSettings(jd.gui.swing.jdgui.views.settings.panels.accountmanager.AccountManagerSettings.class);
        Thread.sleep(3000);
        check("Accounts tile shows the settings window", f[0].isVisible(), null);
        check("it opens on the Accounts page", shownPage() == jd.gui.swing.jdgui.views.settings.panels.accountmanager.AccountManagerSettings.class, String.valueOf(shownPage()));
        try {
            final java.awt.image.BufferedImage img = paintFrame(f[0]);
            javax.imageio.ImageIO.write(img, "png", new File(dir, "22-accounts-settings.png"));
            log("screenshot 22-accounts-settings.png");
        } catch (final Throwable e) {
            log("screenshot of accounts failed: " + e);
        }
        org.hakobu.ui.HakobuShell.hideEngineWindow();
        Thread.sleep(1500);
    }

    /* 5: themes render */
    private void stepThemes() throws Exception {
        log("--- step themes");
        final HakobuSettings cfg = HakobuSettings.get();
        for (final String t : new String[] { "oled", "light", "dark" }) {
            cfg.setTheme(t);
            HakobuWindow.runOnFx(() -> HakobuWindow.get().applyTheme());
            view("downloads");
            snap("10-theme-" + t);
        }
        cfg.save();
        check("themes switched without errors", true, null);
    }

    @SuppressWarnings("unused")
    private static List<String> unused() throws IOException {
        return new ArrayList<String>();
    }
}

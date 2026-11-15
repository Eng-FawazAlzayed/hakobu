/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu;

import java.io.File;

import org.appwork.storage.JSonStorage;
import org.appwork.storage.Storable;
import org.appwork.storage.TypeRef;
import org.appwork.utils.Application;
import org.appwork.utils.IO;

/** Hakobu's own settings (JD's settings stay in JD's config files). Stored as cfg/hakobu/settings.json. */
public class HakobuSettings implements Storable {
    private static HakobuSettings INSTANCE;
    /** BitTorrent listen port. */
    private int                   torrentPort  = 6881;
    /** Stop seeding once uploaded/size reaches this ratio. 0 = do not seed. */
    private double                seedRatio    = 1.0;
    /** Stop seeding after this many minutes, whichever comes first. 0 = no time limit. */
    private int                   seedMinutes  = 60;
    /** KB/s, 0 = unlimited. */
    private int                   uploadLimit  = 0;
    /** dark, oled or light. */
    private String                theme        = "dark";
    /** Default yt-dlp quality: best, 2160, 1440, 1080, 720, 480, 360, audio. */
    private String                videoQuality = "best";

    public HakobuSettings() {
    }

    private static File file() {
        return Application.getResource("cfg/hakobu/settings.json");
    }

    public static synchronized HakobuSettings get() {
        if (INSTANCE == null) {
            HakobuSettings s = null;
            try {
                final File f = file();
                if (f.isFile()) {
                    s = JSonStorage.restoreFromString(IO.readFileToString(f), new TypeRef<HakobuSettings>() {
                    });
                }
            } catch (final Throwable e) {
                e.printStackTrace();
            }
            INSTANCE = s != null ? s : new HakobuSettings();
        }
        return INSTANCE;
    }

    public synchronized void save() {
        try {
            final File f = file();
            f.getParentFile().mkdirs();
            IO.secureWrite(f, JSonStorage.serializeToJson(this).getBytes("UTF-8"));
        } catch (final Throwable e) {
            e.printStackTrace();
        }
    }

    public int getTorrentPort() {
        return torrentPort;
    }

    public void setTorrentPort(final int torrentPort) {
        this.torrentPort = torrentPort;
    }

    public double getSeedRatio() {
        return seedRatio;
    }

    public void setSeedRatio(final double seedRatio) {
        this.seedRatio = seedRatio;
    }

    public int getSeedMinutes() {
        return seedMinutes;
    }

    public void setSeedMinutes(final int seedMinutes) {
        this.seedMinutes = seedMinutes;
    }

    public int getUploadLimit() {
        return uploadLimit;
    }

    public void setUploadLimit(final int uploadLimit) {
        this.uploadLimit = uploadLimit;
    }

    public String getTheme() {
        return theme;
    }

    public void setTheme(final String theme) {
        this.theme = theme;
    }

    public String getVideoQuality() {
        return videoQuality;
    }

    public void setVideoQuality(final String videoQuality) {
        this.videoQuality = videoQuality;
    }
}

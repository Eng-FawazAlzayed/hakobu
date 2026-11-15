/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.app;

import org.hakobu.ui.HakobuShell;
import org.hakobu.ui.HakobuWindow;

import jd.SecondLevelLaunch;

/**
 * Starts JD's engine (with its window hidden) and then the Hakobu window on top of it. Start with -Dhakobu.jdui=true to get plain
 * JDownloader screens instead.
 */
public class Launcher {
    public static void main(final String[] args) {
        final boolean hakobuUi = !Boolean.getBoolean("hakobu.jdui");
        HakobuShell.setActive(hakobuUi);
        if (hakobuUi) {
            SecondLevelLaunch.GUI_COMPLETE.executeWhenReached(new Runnable() {
                @Override
                public void run() {
                    HakobuWindow.launch();
                }
            });
        }
        org.jdownloader.startup.Main.main(args);
    }
}

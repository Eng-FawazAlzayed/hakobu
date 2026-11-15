/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.ui;

import javax.swing.SwingUtilities;

import jd.gui.swing.jdgui.JDGui;

/** Decides which window is the main one: the Hakobu window, with JD's own window only shown on request ("More settings"). */
public final class HakobuShell {
    private static volatile boolean active;
    private static volatile boolean engineWindowRequested;

    private HakobuShell() {
    }

    public static void setActive(final boolean b) {
        active = b;
    }

    public static boolean isActive() {
        return active;
    }

    public static boolean allowEngineWindow() {
        return !active || engineWindowRequested;
    }

    /** Opens JD's full window (all advanced settings, accounts, extensions). */
    public static void showEngineWindow() {
        engineWindowRequested = true;
        SwingUtilities.invokeLater(new Runnable() {
            @Override
            public void run() {
                final JDGui gui = JDGui.getInstance();
                if (gui != null) {
                    gui.getMainFrame().setVisible(true);
                    gui.getMainFrame().toFront();
                }
            }
        });
    }

    public static void hideEngineWindow() {
        engineWindowRequested = false;
        SwingUtilities.invokeLater(new Runnable() {
            @Override
            public void run() {
                final JDGui gui = JDGui.getInstance();
                if (gui != null) {
                    gui.getMainFrame().setVisible(false);
                }
            }
        });
    }
}

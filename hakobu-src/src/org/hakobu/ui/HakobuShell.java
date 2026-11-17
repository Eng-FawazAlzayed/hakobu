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

    /**
     * Opens JD's window on one settings page (e.g. CaptchaConfigPanel.class), or on the settings overview when the page is null. Showing
     * the window is done by JDGui.setContent (Hakobu overlay), so JD's own "open settings" actions work the same way.
     */
    public static void showSettings(final Class<?> panel) {
        SwingUtilities.invokeLater(new Runnable() {
            @Override
            public void run() {
                final JDGui gui = JDGui.getInstance();
                if (gui == null) {
                    return;
                }
                org.appwork.storage.config.JsonConfig.create(org.jdownloader.settings.GraphicalUserInterfaceSettings.class).setConfigViewVisible(true);
                final jd.gui.swing.jdgui.views.settings.ConfigurationView view = jd.gui.swing.jdgui.views.settings.ConfigurationView.getInstance();
                gui.setContent(view, true);
                showEngineWindow();
                if (panel != null) {
                    view.setSelectedSubPanel(panel);
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

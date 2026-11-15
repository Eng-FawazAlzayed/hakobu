/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.ui;

import javafx.scene.Group;
import javafx.scene.Node;
import javafx.scene.shape.SVGPath;

/** Line icons in the style of the Electron Hakobu (24x24 stroke paths, drawn by CSS class "glyph"). */
public final class Icons {
    private Icons() {
    }

    public static final String DOWNLOAD = "M12 4v11 M7 10l5 5 5-5 M5 20h14";
    public static final String LINK     = "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.2 1.2 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.2-1.2";
    public static final String MAGNET   = "M6 3v8a6 6 0 0 0 12 0V3 M6 3h4v8a2 2 0 0 0 4 0V3h4 M6 7h4 M14 7h4";
    public static final String VIDEO    = "M4 6h11v12H4z M15 10l5-3v10l-5-3";
    public static final String GLOBE    = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M3 12h18 M12 3c3 3.5 3 14.5 0 18 M12 3c-3 3.5-3 14.5 0 18";
    public static final String SETTINGS = "M4 7h10 M18 7h2 M4 17h4 M12 17h8 M14 5v4 M8 15v4";
    public static final String PLUS     = "M12 5v14 M5 12h14";
    public static final String PLAY     = "M8 5l11 7-11 7z";
    public static final String PAUSE    = "M8 5v14 M16 5v14";
    public static final String STOP     = "M6 6h12v12H6z";
    public static final String FOLDER   = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
    public static final String CLOSE    = "M6 6l12 12 M18 6L6 18";
    public static final String TRASH    = "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13";
    public static final String SEARCH   = "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M20 20l-4-4";
    public static final String FILE     = "M7 3h7l5 5v13H7z M14 3v5h5";
    public static final String CHECK    = "M5 12l5 5 9-10";
    public static final String LAYERS   = "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5";
    public static final String SEED     = "M12 20V10 M12 10c0-4 3-6 7-6 0 4-3 6-7 6z M12 13c0-3-2-5-6-5 0 3 2 5 6 5z";
    public static final String BROOM    = "M14 4l6 6 M4 20l7-7 M11 13l-3-3 6-6 6 6-6 6z";
    public static final String SLIDERS  = "M4 6h16 M4 12h16 M4 18h16 M8 4v4 M16 10v4 M10 16v4";

    public static Node of(final String path, final double size) {
        final SVGPath p = new SVGPath();
        p.setContent(path);
        p.getStyleClass().add("glyph");
        final double scale = size / 24.0;
        p.setScaleX(scale);
        p.setScaleY(scale);
        return new Group(p);
    }

    public static Node nav(final String path) {
        final Node n = of(path, 18);
        ((Group) n).getChildren().get(0).getStyleClass().setAll("nav-icon");
        return n;
    }
}

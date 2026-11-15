/*
 * Hakobu (Java) - a fork built on JDownloader 2. GPL-3.0-or-later.
 */
package org.hakobu.ui;

import java.awt.Desktop;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;

import javax.imageio.ImageIO;

import org.hakobu.HakobuSettings;
import org.hakobu.torrent.TorrentDownloader;
import org.hakobu.torrent.TorrentEngine;
import org.hakobu.ui.Engine.DlItem;
import org.hakobu.ui.Engine.GrabItem;

import com.frostwire.jlibtorrent.TorrentInfo;

import javafx.animation.FadeTransition;
import javafx.animation.KeyFrame;
import javafx.animation.PauseTransition;
import javafx.animation.Timeline;
import javafx.application.Platform;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Node;
import javafx.scene.Scene;
import javafx.scene.SnapshotParameters;
import javafx.scene.control.Button;
import javafx.scene.control.CheckBox;
import javafx.scene.control.ComboBox;
import javafx.scene.control.Label;
import javafx.scene.control.ScrollPane;
import javafx.scene.control.TextArea;
import javafx.scene.control.TextField;
import javafx.scene.control.Tooltip;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.image.PixelReader;
import javafx.scene.image.WritableImage;
import javafx.scene.input.Clipboard;
import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;
import javafx.scene.input.TransferMode;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.FlowPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.Region;
import javafx.scene.layout.StackPane;
import javafx.scene.layout.VBox;
import javafx.scene.shape.Rectangle;
import javafx.stage.DirectoryChooser;
import javafx.stage.FileChooser;
import javafx.stage.Modality;
import javafx.stage.Stage;
import javafx.util.Duration;

/** The Hakobu window: same layout and look as the Electron Hakobu, running on JD's engine through {@link Engine}. */
public class HakobuWindow {
    private static HakobuWindow INSTANCE;
    private Stage               stage;
    private Scene               scene;
    private final BorderPane    root    = new BorderPane();
    private final StackPane     layers  = new StackPane();
    private final VBox          toasts  = new VBox(8);
    private String              view    = "downloads";
    private String              filter  = "all";
    private final Map<String, HBox> navItems = new LinkedHashMap<String, HBox>();
    private final Map<String, Label> counts = new HashMap<String, Label>();
    private Label               speedDown, speedUp;
    private final DownloadsView downloads = new DownloadsView();
    private final GrabberView   grabber   = new GrabberView();
    private final TorrentsView  torrents  = new TorrentsView();
    private final SettingsView  settings  = new SettingsView();
    private final Map<Long, String> lastStates = new HashMap<Long, String>();
    private final Map<String, Image> thumbs = new HashMap<String, Image>();

    public static HakobuWindow get() {
        return INSTANCE;
    }

    /** Starts JavaFX (once) and opens the window. */
    public static void launch() {
        final Runnable open = new Runnable() {
            @Override
            public void run() {
                INSTANCE = new HakobuWindow();
                INSTANCE.open();
            }
        };
        try {
            Platform.startup(open);
        } catch (final IllegalStateException alreadyStarted) {
            Platform.runLater(open);
        }
        Platform.setImplicitExit(false);
    }

    private void open() {
        stage = new Stage();
        stage.setTitle("Hakobu");
        try {
            stage.getIcons().add(new Image(HakobuWindow.class.getResourceAsStream("logo.png")));
        } catch (final Throwable ignore) {
        }
        root.setLeft(buildSidebar());
        layers.getChildren().addAll(root, toasts);
        toasts.setAlignment(Pos.BOTTOM_RIGHT);
        toasts.setPickOnBounds(false);
        toasts.setPadding(new Insets(0, 24, 24, 0));
        scene = new Scene(layers, 1280, 820);
        scene.getStylesheets().add(HakobuWindow.class.getResource("hakobu.css").toExternalForm());
        applyTheme();
        scene.getAccelerators().put(new KeyCodeCombination(KeyCode.V, KeyCombination.SHORTCUT_DOWN), new Runnable() {
            @Override
            public void run() {
                if (!(scene.getFocusOwner() instanceof TextArea) && !(scene.getFocusOwner() instanceof TextField)) {
                    pasteFromClipboard();
                }
            }
        });
        /* Drop links, text or .torrent files anywhere on the window. */
        scene.setOnDragOver(e -> {
            if (e.getDragboard().hasFiles() || e.getDragboard().hasString() || e.getDragboard().hasUrl()) {
                e.acceptTransferModes(TransferMode.COPY);
            }
            e.consume();
        });
        scene.setOnDragDropped(e -> {
            if (e.getDragboard().hasFiles()) {
                addTorrentFiles(e.getDragboard().getFiles());
            } else if (e.getDragboard().hasUrl()) {
                addText(e.getDragboard().getUrl());
            } else if (e.getDragboard().hasString()) {
                addText(e.getDragboard().getString());
            }
            e.setDropCompleted(true);
            e.consume();
        });
        stage.setScene(scene);
        stage.setMinWidth(980);
        stage.setMinHeight(640);
        stage.setOnCloseRequest(e -> {
            e.consume();
            stage.hide();
            new Thread(() -> org.appwork.shutdown.ShutdownController.getInstance().requestShutdown(), "Hakobu exit").start();
        });
        show("downloads");
        final Timeline tick = new Timeline(new KeyFrame(Duration.millis(700), e -> refresh()));
        tick.setCycleCount(Timeline.INDEFINITE);
        tick.play();
        stage.show();
        root.requestFocus();
        org.hakobu.test.SelfTest.startIfRequested();
    }

    public void applyTheme() {
        final String t = HakobuSettings.get().getTheme();
        layers.getStyleClass().removeAll("theme-dark", "theme-oled", "theme-light");
        layers.getStyleClass().add("theme-" + ("light".equals(t) || "oled".equals(t) ? t : "dark"));
    }

    /* ---------------------------------------------------------------- sidebar */
    private Node buildSidebar() {
        final VBox side = new VBox();
        side.getStyleClass().add("sidebar");
        side.setPrefWidth(250);
        side.setMinWidth(250);
        final HBox brand = new HBox();
        brand.getStyleClass().add("brand");
        final ImageView logo = new ImageView(new Image(HakobuWindow.class.getResourceAsStream("logo.png"), 36, 36, true, true));
        final Label name = new Label("Hakobu");
        name.getStyleClass().add("brand-name");
        final Label kana = new Label("運ぶ");
        kana.getStyleClass().add("brand-kana");
        brand.getChildren().addAll(logo, name, kana);
        side.getChildren().add(brand);
        side.getChildren().add(nav("downloads", "Downloads", Icons.DOWNLOAD, null));
        side.getChildren().add(nav("grabber", "LinkGrabber", Icons.LINK, "grabber"));
        side.getChildren().add(nav("torrents", "Torrents", Icons.MAGNET, "seeding"));
        side.getChildren().add(nav("settings", "Settings", Icons.SETTINGS, null));
        side.getChildren().add(section("LIBRARY"));
        side.getChildren().add(filter("all", "All", "-hk-text3"));
        side.getChildren().add(filter("downloading", "Downloading", "-hk-accent"));
        side.getChildren().add(filter("completed", "Completed", "-hk-green"));
        side.getChildren().add(filter("paused", "Paused", "-hk-amber"));
        side.getChildren().add(filter("error", "Errors", "-hk-red"));
        side.getChildren().add(section("SOURCE"));
        side.getChildren().add(filter("direct", "Direct", "-hk-accent"));
        side.getChildren().add(filter("torrent", "Torrents", "-hk-teal"));
        side.getChildren().add(filter("video", "Video", "-hk-red"));
        final Region grow = new Region();
        VBox.setVgrow(grow, Priority.ALWAYS);
        side.getChildren().add(grow);
        final VBox speed = new VBox();
        speed.getStyleClass().add("speedcard");
        final HBox labels = new HBox();
        final Label d = new Label("Download");
        d.getStyleClass().add("dim");
        final Region r = new Region();
        HBox.setHgrow(r, Priority.ALWAYS);
        final Label u = new Label("Upload");
        u.getStyleClass().add("dim");
        labels.getChildren().addAll(d, r, u);
        final HBox values = new HBox();
        speedDown = new Label("0 B/s");
        speedDown.getStyleClass().add("speed-value");
        final Region r2 = new Region();
        HBox.setHgrow(r2, Priority.ALWAYS);
        speedUp = new Label("0 B/s");
        speedUp.getStyleClass().addAll("speed-value", "speed-up");
        values.getChildren().addAll(speedDown, r2, speedUp);
        speed.getChildren().addAll(labels, values);
        side.getChildren().add(speed);
        return side;
    }

    private Label section(final String text) {
        final Label l = new Label(text);
        l.getStyleClass().add("section-label");
        return l;
    }

    private HBox nav(final String id, final String text, final String icon, final String countKey) {
        final HBox item = new HBox();
        item.getStyleClass().add("nav-item");
        final Label l = new Label(text);
        final Region grow = new Region();
        HBox.setHgrow(grow, Priority.ALWAYS);
        item.getChildren().addAll(Icons.nav(icon), l, grow);
        if (countKey != null) {
            final Label c = new Label("");
            c.getStyleClass().add("count");
            counts.put(countKey, c);
            item.getChildren().add(c);
        }
        item.setOnMouseClicked(e -> show(id));
        navItems.put(id, item);
        return item;
    }

    private HBox filter(final String id, final String text, final String color) {
        final HBox item = new HBox();
        item.getStyleClass().add("nav-item");
        final Region dot = new Region();
        dot.getStyleClass().add("dot");
        dot.setStyle("-fx-background-color: " + color + ";");
        final Label l = new Label(text);
        final Region grow = new Region();
        HBox.setHgrow(grow, Priority.ALWAYS);
        final Label c = new Label("");
        c.getStyleClass().add("count");
        counts.put("f-" + id, c);
        item.getChildren().addAll(dot, l, grow, c);
        item.setOnMouseClicked(e -> {
            filter = id;
            show("downloads");
        });
        navItems.put("f-" + id, item);
        return item;
    }

    public void show(final String id) {
        view = id;
        for (final Map.Entry<String, HBox> e : navItems.entrySet()) {
            final boolean sel = e.getKey().equals(id) || ("downloads".equals(id) && e.getKey().equals("f-" + filter) && !"all".equals(filter));
            e.getValue().getStyleClass().remove("selected");
            if (sel) {
                e.getValue().getStyleClass().add("selected");
            }
        }
        if ("downloads".equals(id) && "all".equals(filter)) {
            navItems.get("f-all").getStyleClass().add("selected");
        }
        switch (id) {
        case "grabber":
            root.setCenter(grabber.node());
            break;
        case "torrents":
            root.setCenter(torrents.node());
            break;
        case "settings":
            root.setCenter(settings.node());
            break;
        default:
            root.setCenter(downloads.node());
            break;
        }
        refresh();
    }

    /* ---------------------------------------------------------------- common helpers */
    static Button iconButton(final String icon, final String tip, final Runnable action) {
        final Button b = new Button();
        b.setGraphic(Icons.of(icon, 18));
        b.getStyleClass().setAll("icon-btn");
        b.setTooltip(new Tooltip(tip));
        b.setOnAction(e -> action.run());
        return b;
    }

    static Button primary(final String text, final String icon, final Runnable action) {
        final Button b = new Button(text);
        if (icon != null) {
            b.setGraphic(Icons.of(icon, 16));
        }
        b.getStyleClass().setAll("btn-primary");
        b.setOnAction(e -> action.run());
        return b;
    }

    static Button button(final String text, final Runnable action) {
        final Button b = new Button(text);
        b.getStyleClass().setAll("btn");
        b.setOnAction(e -> action.run());
        return b;
    }

    static Label label(final String text, final String... classes) {
        final Label l = new Label(text);
        l.getStyleClass().addAll(classes);
        return l;
    }

    static Region grow() {
        final Region r = new Region();
        HBox.setHgrow(r, Priority.ALWAYS);
        return r;
    }

    static String size(final long b) {
        if (b <= 0) {
            return "";
        }
        final String[] u = { "B", "KB", "MB", "GB", "TB" };
        double v = b;
        int i = 0;
        while (v >= 1024 && i < u.length - 1) {
            v /= 1024;
            i++;
        }
        return (i == 0 ? String.valueOf((long) v) : String.format(v >= 100 ? "%.0f" : "%.1f", v)) + " " + u[i];
    }

    static String eta(final long s) {
        if (s <= 0) {
            return "";
        }
        if (s < 60) {
            return s + "s left";
        }
        if (s < 3600) {
            return (s / 60) + "m " + (s % 60) + "s left";
        }
        return (s / 3600) + "h " + ((s % 3600) / 60) + "m left";
    }

    static String clock(final long sec) {
        if (sec <= 0) {
            return "";
        }
        return sec >= 3600 ? String.format("%d:%02d:%02d", sec / 3600, (sec % 3600) / 60, sec % 60) : String.format("%d:%02d", sec / 60, sec % 60);
    }

    static Node badge(final String kind) {
        final StackPane b = new StackPane();
        b.getStyleClass().addAll("badge", "badge-" + ("torrent".equals(kind) || "video".equals(kind) ? kind : "direct"));
        b.getChildren().add(Icons.of("torrent".equals(kind) ? Icons.MAGNET : "video".equals(kind) ? Icons.VIDEO : Icons.GLOBE, 20));
        return b;
    }

    Image thumb(final String url) {
        Image img = thumbs.get(url);
        if (img == null) {
            img = new Image(url, 160, 90, true, true, true);
            thumbs.put(url, img);
        }
        return img;
    }

    void toast(final String title, final String text, final boolean ok) {
        final VBox t = new VBox();
        t.getStyleClass().add("toast");
        final Label a = label(title, "toast-title", ok ? "ok" : "bad");
        final Label b = label(text, "muted");
        b.setWrapText(true);
        t.getChildren().addAll(a, b);
        toasts.getChildren().add(t);
        final PauseTransition wait = new PauseTransition(Duration.seconds(5));
        wait.setOnFinished(e -> {
            final FadeTransition f = new FadeTransition(Duration.millis(300), t);
            f.setToValue(0);
            f.setOnFinished(x -> toasts.getChildren().remove(t));
            f.play();
        });
        wait.play();
    }

    void openFolder(final File f) {
        if (f == null) {
            return;
        }
        new Thread(() -> {
            try {
                if (f.exists() && !f.isDirectory()) {
                    new ProcessBuilder("explorer.exe", "/select,", f.getAbsolutePath()).start();
                } else {
                    final File dir = f.isDirectory() ? f : f.getParentFile();
                    if (dir != null) {
                        Desktop.getDesktop().open(dir);
                    }
                }
            } catch (final Throwable e) {
                e.printStackTrace();
            }
        }, "open folder").start();
    }

    void addText(final String text) {
        Engine.addLinks(text);
        show("grabber");
    }

    void pasteFromClipboard() {
        final String s = Clipboard.getSystemClipboard().getString();
        if (s != null) {
            addText(s);
        }
    }

    void addTorrentFiles(final List<File> files) {
        final StringBuilder links = new StringBuilder();
        for (final File f : files) {
            if (f.getName().toLowerCase().endsWith(".torrent")) {
                try {
                    links.append(jd.plugins.decrypter.HakobuTorrentFileCrawler.magnetForFile(f)).append('\n');
                } catch (final Throwable e) {
                    toast("Not a torrent", f.getName() + " could not be read as a .torrent file.", false);
                }
            }
        }
        if (links.length() > 0) {
            addText(links.toString());
        }
    }

    void chooseTorrent() {
        final FileChooser fc = new FileChooser();
        fc.setTitle("Open .torrent");
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("Torrent files", "*.torrent"));
        final List<File> files = fc.showOpenMultipleDialog(stage);
        if (files != null) {
            addTorrentFiles(files);
        }
    }

    /* ---------------------------------------------------------------- refresh */
    private void refresh() {
        try {
            final List<DlItem> items = Engine.downloads();
            long down = 0;
            final Map<String, Integer> c = new HashMap<String, Integer>();
            for (final DlItem d : items) {
                down += d.speed;
                inc(c, "all");
                inc(c, d.state);
                inc(c, d.kind);
                final String before = lastStates.put(d.id, d.state);
                if (before != null && !before.equals(d.state)) {
                    if ("completed".equals(d.state)) {
                        toast("Download complete", d.name, true);
                    } else if ("error".equals(d.state)) {
                        toast("Download failed", d.name + (d.message != null ? ": " + d.message : ""), false);
                    }
                }
            }
            final long up = Engine.torrentUploadRate();
            final List<TorrentEngine.Seed> seeds = TorrentEngine.seeds();
            speedDown.setText(size(down) .isEmpty() ? "0 B/s" : size(down) + "/s");
            speedUp.setText(size(up).isEmpty() ? "0 B/s" : size(up) + "/s");
            for (final String k : new String[] { "all", "downloading", "completed", "paused", "error", "direct", "torrent", "video" }) {
                final Integer n = "downloading".equals(k) ? Integer.valueOf((c.getOrDefault("downloading", 0) + c.getOrDefault("waiting", 0) + c.getOrDefault("queued", 0))) : c.get(k);
                counts.get("f-" + k).setText(n == null || n == 0 ? "" : String.valueOf(n));
            }
            final int g = Engine.grabbed().size();
            counts.get("grabber").setText(g == 0 ? "" : String.valueOf(g));
            counts.get("seeding").setText(seeds.isEmpty() ? "" : String.valueOf(seeds.size()));
            switch (view) {
            case "grabber":
                grabber.refresh();
                break;
            case "torrents":
                torrents.refresh(items, seeds);
                break;
            case "settings":
                break;
            default:
                downloads.refresh(items);
                break;
            }
        } catch (final Throwable e) {
            e.printStackTrace();
        }
    }

    private static void inc(final Map<String, Integer> m, final String k) {
        m.put(k, m.getOrDefault(k, 0) + 1);
    }

    static boolean matches(final DlItem d, final String filter, final String search) {
        if (search != null && !search.isEmpty() && !d.name.toLowerCase().contains(search.toLowerCase())) {
            return false;
        }
        switch (filter) {
        case "downloading":
            return "downloading".equals(d.state) || "waiting".equals(d.state) || "queued".equals(d.state);
        case "completed":
        case "paused":
        case "error":
            return filter.equals(d.state);
        case "direct":
        case "torrent":
        case "video":
            return filter.equals(d.kind);
        default:
            return true;
        }
    }

    /* ---------------------------------------------------------------- downloads view */
    final class DownloadsView {
        private VBox                  node;
        private final VBox            list   = new VBox(10);
        private final TextField       search = new TextField();
        private final Label           count  = label("", "muted");
        private final Map<Long, DlRow> rows  = new HashMap<Long, DlRow>();
        private final Set<Long>       selected = new HashSet<Long>();
        private VBox                  empty;

        Node node() {
            if (node == null) {
                node = new VBox();
                node.getStyleClass().add("content");
                final HBox header = new HBox(16);
                header.setAlignment(Pos.CENTER_LEFT);
                search.setPromptText("Search downloads");
                search.getStyleClass().setAll("search");
                HBox.setHgrow(search, Priority.ALWAYS);
                search.setMaxWidth(480);
                header.getChildren().addAll(label("Downloads", "title"), grow(), search, primary("Add links", Icons.PLUS, () -> show("grabber")));
                final HBox bar = new HBox();
                bar.getStyleClass().addAll("card", "toolbar");
                final Button torrentBtn = button(".torrent", HakobuWindow.this::chooseTorrent);
                torrentBtn.setGraphic(Icons.of(Icons.FILE, 16));
                bar.getChildren().addAll(count, grow(), torrentBtn, sep(),
                        iconButton(Icons.PLAY, "Start all", Engine::startAll),
                        iconButton(Icons.STOP, "Stop all", Engine::stopAll),
                        iconButton(Icons.PAUSE, "Pause selected", () -> Engine.pause(selectedOrAll())),
                        iconButton(Icons.FOLDER, "Open download folder", () -> openFolder(new File(Engine.downloadFolder()))),
                        iconButton(Icons.BROOM, "Clear completed", Engine::clearCompleted),
                        iconButton(Icons.TRASH, "Remove selected (files stay on disk)", () -> {
                            Engine.remove(new HashSet<Long>(selected));
                            selected.clear();
                        }));
                final ScrollPane sp = new ScrollPane(list);
                sp.setFitToWidth(true);
                VBox.setVgrow(sp, Priority.ALWAYS);
                empty = new VBox();
                empty.getStyleClass().add("empty");
                empty.getChildren().addAll(Icons.of(Icons.DOWNLOAD, 40), label("Nothing here yet", "empty-title"), label("Press Add links, paste with Ctrl+V, or drop links and .torrent files on the window.", "muted"));
                node.getChildren().addAll(header, bar, sp);
            }
            return node;
        }

        private Set<Long> selectedOrAll() {
            if (!selected.isEmpty()) {
                return new HashSet<Long>(selected);
            }
            return new HashSet<Long>(rows.keySet());
        }

        private Node sep() {
            final Region r = new Region();
            r.getStyleClass().add("vsep");
            HBox.setMargin(r, new Insets(0, 6, 0, 6));
            return r;
        }

        void refresh(final List<DlItem> items) {
            if (node == null) {
                return;
            }
            final List<Node> order = new ArrayList<Node>();
            final Set<Long> seen = new HashSet<Long>();
            int shown = 0;
            for (final DlItem d : items) {
                if (!matches(d, filter, search.getText())) {
                    continue;
                }
                shown++;
                DlRow r = rows.get(d.id);
                if (r == null) {
                    r = new DlRow(d.id);
                    rows.put(d.id, r);
                }
                r.update(d);
                seen.add(d.id);
                order.add(r.box);
            }
            rows.keySet().retainAll(seen);
            selected.retainAll(seen);
            if (order.isEmpty()) {
                order.add(empty);
            }
            if (!list.getChildren().equals(order)) {
                list.getChildren().setAll(order);
            }
            count.setText(shown + (shown == 1 ? " download" : " downloads"));
        }

        final class DlRow {
            final long   id;
            final HBox   box  = new HBox();
            final StackPane badgeBox = new StackPane();
            final Label  pkg  = label("", "row-pkg");
            final Label  name = label("", "row-name");
            final Region fill = new Region();
            final StackPane bar = new StackPane();
            final Label  meta = label("", "dim");
            final Label  pill = label("", "pill");
            final Label  pct  = label("", "pct");
            final Button toggle;
            String       kind;

            DlRow(final long id) {
                this.id = id;
                box.getStyleClass().add("row");
                final VBox mid = new VBox(6);
                HBox.setHgrow(mid, Priority.ALWAYS);
                final HBox title = new HBox(6, pkg, name);
                title.setAlignment(Pos.CENTER_LEFT);
                bar.getStyleClass().add("progress");
                bar.setAlignment(Pos.CENTER_LEFT);
                fill.getStyleClass().add("progress-fill");
                bar.getChildren().add(fill);
                mid.getChildren().addAll(title, bar, meta);
                toggle = iconButton(Icons.PAUSE, "Pause", () -> {
                });
                final Button folder = iconButton(Icons.FOLDER, "Show in folder", () -> openFolder(Engine.fileOf(id)));
                final Button remove = iconButton(Icons.CLOSE, "Remove from list (file stays)", () -> {
                    final Set<Long> s = new HashSet<Long>();
                    s.add(id);
                    Engine.remove(s);
                });
                remove.getStyleClass().add("danger");
                box.getChildren().addAll(badgeBox, mid, pill, pct, toggle, folder, remove);
                box.setOnMouseClicked(e -> {
                    if (e.isControlDown()) {
                        if (!selected.remove(id)) {
                            selected.add(id);
                        }
                    } else {
                        selected.clear();
                        selected.add(id);
                    }
                    for (final DlRow r : rows.values()) {
                        r.box.setStyle(selected.contains(r.id) ? "-fx-border-color: rgba(124,140,255,0.55);" : "");
                    }
                });
            }

            void update(final DlItem d) {
                if (!d.kind.equals(kind)) {
                    kind = d.kind;
                    badgeBox.getChildren().setAll(badge(d.kind));
                }
                name.setText(d.name);
                final boolean showPkg = d.packageName != null && !d.packageName.equals(d.name) && !d.packageName.isEmpty();
                pkg.setText(showPkg ? d.packageName + " ›" : "");
                pkg.setVisible(showPkg);
                pkg.setManaged(showPkg);
                final double p = d.total > 0 ? Math.min(1, d.loaded / (double) d.total) : ("completed".equals(d.state) ? 1 : 0);
                fill.maxWidthProperty().bind(bar.widthProperty().multiply(p));
                fill.getStyleClass().removeAll("done", "error", "paused");
                if ("completed".equals(d.state)) {
                    fill.getStyleClass().add("done");
                } else if ("error".equals(d.state)) {
                    fill.getStyleClass().add("error");
                } else if ("paused".equals(d.state)) {
                    fill.getStyleClass().add("paused");
                }
                final StringBuilder m = new StringBuilder();
                if ("downloading".equals(d.state)) {
                    m.append(size(d.loaded)).append(d.total > 0 ? " of " + size(d.total) : "");
                    if (d.speed > 0) {
                        m.append("   ").append(size(d.speed)).append("/s   ").append(eta(d.eta));
                    }
                    if (d.message != null && "torrent".equals(d.kind)) {
                        m.append("   ").append(d.message);
                    }
                } else if ("error".equals(d.state) || "waiting".equals(d.state)) {
                    m.append(d.message != null ? d.message : "");
                } else {
                    m.append(size(d.total > 0 ? d.total : d.loaded));
                    if (d.message != null) {
                        m.append("   ").append(d.message);
                    }
                }
                meta.setText(m.toString());
                meta.getStyleClass().setAll("error".equals(d.state) ? "err" : "dim");
                final String pillText;
                switch (d.state) {
                case "completed":
                    pillText = "Completed";
                    break;
                case "downloading":
                    pillText = "Downloading";
                    break;
                case "waiting":
                    pillText = "Waiting";
                    break;
                case "paused":
                    pillText = "Paused";
                    break;
                case "error":
                    pillText = "Error";
                    break;
                default:
                    pillText = "Queued";
                    break;
                }
                pill.setText("● " + pillText);
                pill.getStyleClass().setAll("pill", "pill-" + d.state);
                pct.setText("completed".equals(d.state) ? "" : String.format("%.1f%%", p * 100));
                final boolean active = "downloading".equals(d.state) || "waiting".equals(d.state) || "queued".equals(d.state);
                toggle.setVisible(!"completed".equals(d.state));
                toggle.setGraphic(Icons.of(active ? Icons.PAUSE : Icons.PLAY, 18));
                toggle.getTooltip().setText(active ? "Pause" : ("error".equals(d.state) ? "Retry" : "Resume"));
                toggle.setOnAction(e -> {
                    final Set<Long> s = new HashSet<Long>();
                    s.add(id);
                    if (active) {
                        Engine.pause(s);
                    } else {
                        Engine.resume(s);
                    }
                });
            }
        }
    }

    /* ---------------------------------------------------------------- link grabber view */
    final class GrabberView {
        private VBox                     node;
        private final TextArea           paste   = new TextArea();
        private final VBox               list    = new VBox(10);
        private final Map<Long, GrabCard> cards  = new HashMap<Long, GrabCard>();
        private final Set<Long>          unpicked = new HashSet<Long>();
        private final Button             go      = primary("Download", Icons.DOWNLOAD, this::startPicked);
        private final Label              status  = label("", "muted");
        private final CheckBox           all     = new CheckBox("Select all");
        private VBox                     empty;

        Node node() {
            if (node == null) {
                node = new VBox();
                node.getStyleClass().add("content");
                final HBox header = new HBox(16);
                header.setAlignment(Pos.CENTER_LEFT);
                header.getChildren().addAll(label("LinkGrabber", "title"), grow(), button("Open .torrent", HakobuWindow.this::chooseTorrent), button("Paste", HakobuWindow.this::pasteFromClipboard));
                paste.setPromptText("Paste links here: file hosts, YouTube videos or playlists, magnet links, .torrent links. Hakobu checks them before anything downloads.");
                paste.getStyleClass().add("paste-area");
                paste.setPrefRowCount(3);
                paste.setWrapText(true);
                final Button grab = primary("Grab links", Icons.LINK, () -> {
                    Engine.addLinks(paste.getText());
                    paste.clear();
                });
                final HBox pasteRow = new HBox(12, paste, grab);
                HBox.setHgrow(paste, Priority.ALWAYS);
                pasteRow.setAlignment(Pos.CENTER);
                final ScrollPane sp = new ScrollPane(list);
                sp.setFitToWidth(true);
                VBox.setVgrow(sp, Priority.ALWAYS);
                all.setSelected(true);
                all.setOnAction(e -> {
                    if (all.isSelected()) {
                        unpicked.clear();
                    } else {
                        unpicked.addAll(cards.keySet());
                    }
                    refresh();
                });
                final HBox footer = new HBox();
                footer.getStyleClass().add("footer-bar");
                final Button remove = button("Remove", () -> {
                    final Set<Long> ids = picked();
                    Engine.removeGrabbed(ids);
                });
                final Button clear = button("Clear all", () -> Engine.removeGrabbed(new HashSet<Long>(cards.keySet())));
                footer.getChildren().addAll(all, status, grow(), clear, remove, go);
                empty = new VBox();
                empty.getStyleClass().add("empty");
                empty.getChildren().addAll(Icons.of(Icons.LINK, 40), label("No links waiting", "empty-title"), label("Paste links above. Videos show a preview and a quality choice; torrents let you pick files.", "muted"));
                node.getChildren().addAll(header, pasteRow, sp, footer);
            }
            return node;
        }

        Set<Long> picked() {
            final Set<Long> ids = new HashSet<Long>(cards.keySet());
            ids.removeAll(unpicked);
            return ids;
        }

        void startPicked() {
            final Set<Long> ids = picked();
            if (!ids.isEmpty()) {
                Engine.startGrabbed(ids, true);
                filter = "all";
                show("downloads");
            }
        }

        void refresh() {
            if (node == null) {
                return;
            }
            final List<GrabItem> items = Engine.grabbed();
            final List<Node> order = new ArrayList<Node>();
            final Set<Long> seen = new HashSet<Long>();
            long total = 0;
            int online = 0;
            for (final GrabItem g : items) {
                GrabCard c = cards.get(g.id);
                if (c == null) {
                    c = new GrabCard(g.id);
                    cards.put(g.id, c);
                }
                c.update(g);
                seen.add(g.id);
                order.add(c.box);
                if (!unpicked.contains(g.id)) {
                    total += g.size;
                }
                if ("ONLINE".equals(g.state)) {
                    online++;
                }
            }
            cards.keySet().retainAll(seen);
            unpicked.retainAll(seen);
            if (order.isEmpty()) {
                order.add(empty);
            }
            if (!list.getChildren().equals(order)) {
                list.getChildren().setAll(order);
            }
            final int n = picked().size();
            go.setText(n == 0 ? "Download" : "Download " + n + (n == 1 ? " file" : " files"));
            go.setDisable(n == 0);
            status.setText((Engine.isCrawling() ? "Checking links…   " : "") + (items.isEmpty() ? "" : online + " of " + items.size() + " online" + (total > 0 ? ", " + size(total) + " picked" : "")));
        }

        final class GrabCard {
            final long      id;
            final HBox      box   = new HBox();
            final CheckBox  pick  = new CheckBox();
            final StackPane media = new StackPane();
            final Label     name  = label("", "row-name");
            final Label     meta  = label("", "dim");
            final Label     pill  = label("", "pill");
            final HBox      extra = new HBox(8);
            final ComboBox<String> quality = new ComboBox<String>();
            final Button    files = button("Pick files", () -> {
            });
            String          mediaKey;
            String          heightsKey;

            GrabCard(final long id) {
                this.id = id;
                box.getStyleClass().add("grab-card");
                final VBox mid = new VBox(6);
                HBox.setHgrow(mid, Priority.ALWAYS);
                name.setWrapText(false);
                mid.getChildren().addAll(name, meta, extra);
                extra.setAlignment(Pos.CENTER_LEFT);
                pick.setSelected(true);
                pick.setOnAction(e -> {
                    if (pick.isSelected()) {
                        unpicked.remove(id);
                    } else {
                        unpicked.add(id);
                    }
                    refresh();
                });
                quality.setOnAction(e -> {
                    final String v = quality.getValue();
                    if (v != null) {
                        Engine.setQuality(id, toQuality(v));
                    }
                });
                files.setOnAction(e -> pickTorrentFiles(id));
                final Button remove = iconButton(Icons.CLOSE, "Remove", () -> {
                    final Set<Long> s = new HashSet<Long>();
                    s.add(id);
                    Engine.removeGrabbed(s);
                });
                remove.getStyleClass().add("danger");
                box.getChildren().addAll(pick, media, mid, pill, remove);
            }

            void update(final GrabItem g) {
                pick.setSelected(!unpicked.contains(g.id));
                box.getStyleClass().remove("picked");
                if (pick.isSelected()) {
                    box.getStyleClass().add("picked");
                }
                final String key = g.thumb != null ? g.thumb : g.kind;
                if (!key.equals(mediaKey)) {
                    mediaKey = key;
                    if (g.thumb != null) {
                        final StackPane t = new StackPane();
                        t.getStyleClass().add("thumb-box");
                        final ImageView iv = new ImageView(thumb(g.thumb));
                        iv.setFitWidth(160);
                        iv.setFitHeight(90);
                        iv.setPreserveRatio(true);
                        final Rectangle clip = new Rectangle(160, 90);
                        clip.setArcWidth(20);
                        clip.setArcHeight(20);
                        iv.setClip(clip);
                        t.getChildren().add(iv);
                        if (g.duration > 0) {
                            final Label d = label(clock(g.duration), "duration");
                            StackPane.setAlignment(d, Pos.BOTTOM_RIGHT);
                            StackPane.setMargin(d, new Insets(0, 6, 6, 0));
                            t.getChildren().add(d);
                        }
                        media.getChildren().setAll(t);
                    } else {
                        media.getChildren().setAll(badge(g.kind));
                    }
                }
                name.setText(g.name);
                final StringBuilder m = new StringBuilder(g.host != null ? g.host : "");
                if (g.size > 0) {
                    m.append("   ").append(size(g.size));
                }
                if (g.packageName != null && !g.packageName.isEmpty() && !g.packageName.equals(g.name)) {
                    m.append("   in ").append(g.packageName);
                }
                if ("torrent".equals(g.kind) && g.torrentFiles > 0) {
                    final int sel = g.torrentSelection == null ? g.torrentFiles : g.torrentSelection.split(",").length;
                    m.append("   ").append(sel).append(" of ").append(g.torrentFiles).append(g.torrentFiles == 1 ? " file" : " files");
                }
                meta.setText(m.toString());
                switch (g.state) {
                case "ONLINE":
                    pill.setText("● Online");
                    pill.getStyleClass().setAll("pill", "pill-online");
                    break;
                case "OFFLINE":
                    pill.setText("● Offline");
                    pill.getStyleClass().setAll("pill", "pill-offline");
                    break;
                default:
                    pill.setText("● Checking");
                    pill.getStyleClass().setAll("pill", "pill-checking");
                    break;
                }
                final List<Node> ex = new ArrayList<Node>();
                if ("video".equals(g.kind)) {
                    final String hk = String.valueOf(g.heights);
                    if (!hk.equals(heightsKey)) {
                        heightsKey = hk;
                        final List<String> opts = new ArrayList<String>();
                        opts.add("Best quality");
                        if (g.heights != null) {
                            for (final String h : g.heights.split(",")) {
                                opts.add(h + "p");
                            }
                        } else {
                            for (final String h : new String[] { "1080", "720", "480", "360" }) {
                                opts.add(h + "p");
                            }
                        }
                        opts.add("Audio only (m4a)");
                        quality.getItems().setAll(opts);
                    }
                    final String want = fromQuality(g.quality);
                    if (!want.equals(quality.getValue())) {
                        quality.setValue(want);
                    }
                    ex.add(quality);
                }
                if ("torrent".equals(g.kind) && g.torrentFiles > 1) {
                    ex.add(files);
                }
                if (!extra.getChildren().equals(ex)) {
                    extra.getChildren().setAll(ex);
                }
            }
        }
    }

    static String toQuality(final String label) {
        if (label.startsWith("Best")) {
            return "best";
        }
        if (label.startsWith("Audio")) {
            return "audio";
        }
        return label.replace("p", "");
    }

    static String fromQuality(final String q) {
        if (q == null || "best".equals(q)) {
            return "Best quality";
        }
        if ("audio".equals(q)) {
            return "Audio only (m4a)";
        }
        return q + "p";
    }

    void pickTorrentFiles(final long id) {
        final jd.plugins.DownloadLink dl = Engine.grabbedLink(id);
        if (dl == null) {
            return;
        }
        final TorrentInfo ti;
        try {
            ti = jd.plugins.hoster.HakobuTorrent.loadInfo(dl);
        } catch (final Throwable e) {
            toast("No file list yet", "The torrent's metadata has not arrived yet. Try again in a moment.", false);
            return;
        }
        final Set<Integer> sel = TorrentDownloader.selectedFiles(dl, ti.numFiles());
        final Stage d = new Stage();
        d.initOwner(stage);
        d.initModality(Modality.WINDOW_MODAL);
        d.setTitle("Pick files - " + ti.name());
        final VBox box = new VBox(6);
        final List<CheckBox> checks = new ArrayList<CheckBox>();
        for (int i = 0; i < ti.numFiles(); i++) {
            final CheckBox c = new CheckBox(ti.files().filePath(i) + "   (" + size(ti.files().fileSize(i)) + ")");
            c.setSelected(sel.contains(i));
            checks.add(c);
            box.getChildren().add(c);
        }
        final ScrollPane sp = new ScrollPane(box);
        sp.setFitToWidth(true);
        sp.setPrefHeight(Math.min(420, 40 + ti.numFiles() * 30));
        final HBox buttons = new HBox(10, button("All", () -> checks.forEach(c -> c.setSelected(true))), button("None", () -> checks.forEach(c -> c.setSelected(false))), grow(), button("Cancel", d::close), primary("Use these files", Icons.CHECK, () -> {
            final Set<Integer> chosen = new HashSet<Integer>();
            for (int i = 0; i < checks.size(); i++) {
                if (checks.get(i).isSelected()) {
                    chosen.add(i);
                }
            }
            if (chosen.isEmpty()) {
                toast("Pick at least one file", "A torrent needs at least one file to download.", false);
                return;
            }
            Engine.setTorrentFiles(id, chosen.size() == checks.size() ? null : chosen);
            d.close();
        }));
        buttons.setAlignment(Pos.CENTER_LEFT);
        final VBox rootBox = new VBox(14, label(ti.name(), "set-title"), sp, buttons);
        rootBox.getStyleClass().add("dialog-root");
        final StackPane themed = new StackPane(rootBox);
        themed.getStyleClass().addAll(layers.getStyleClass());
        final Scene s = new Scene(themed, 640, Math.min(560, 160 + ti.numFiles() * 30));
        s.getStylesheets().addAll(scene.getStylesheets());
        d.setScene(s);
        d.show();
    }

    /* ---------------------------------------------------------------- torrents view */
    final class TorrentsView {
        private VBox       node;
        private final VBox active = new VBox(10);
        private final VBox seeding = new VBox(10);

        Node node() {
            if (node == null) {
                node = new VBox();
                node.getStyleClass().add("content");
                final HBox header = new HBox(16);
                header.setAlignment(Pos.CENTER_LEFT);
                header.getChildren().addAll(label("Torrents", "title"), grow(), button("Open .torrent", HakobuWindow.this::chooseTorrent), primary("Add magnet", Icons.MAGNET, () -> show("grabber")));
                final VBox inner = new VBox(14, label("Downloading", "set-title"), active, label("Seeding", "set-title"), seeding, torrentSettings());
                final ScrollPane sp = new ScrollPane(inner);
                sp.setFitToWidth(true);
                VBox.setVgrow(sp, Priority.ALWAYS);
                node.getChildren().addAll(header, sp);
            }
            return node;
        }

        private Node torrentSettings() {
            final HakobuSettings cfg = HakobuSettings.get();
            final VBox g = new VBox();
            g.getStyleClass().add("set-group");
            final TextField port = new TextField(String.valueOf(cfg.getTorrentPort()));
            final TextField ratio = new TextField(String.valueOf(cfg.getSeedRatio()));
            final TextField minutes = new TextField(String.valueOf(cfg.getSeedMinutes()));
            final TextField upload = new TextField(String.valueOf(cfg.getUploadLimit()));
            for (final TextField t : new TextField[] { port, ratio, minutes, upload }) {
                t.setPrefWidth(120);
            }
            final Button save = primary("Save", Icons.CHECK, () -> {
                try {
                    cfg.setTorrentPort(Integer.parseInt(port.getText().trim()));
                    cfg.setSeedRatio(Double.parseDouble(ratio.getText().trim()));
                    cfg.setSeedMinutes(Integer.parseInt(minutes.getText().trim()));
                    cfg.setUploadLimit(Integer.parseInt(upload.getText().trim()));
                    cfg.save();
                    TorrentEngine.applySettings();
                    toast("Saved", "Torrent settings saved.", true);
                } catch (final NumberFormatException e) {
                    toast("Not saved", "Use whole numbers (ratio can have a decimal point).", false);
                }
            });
            g.getChildren().addAll(label("Torrent settings", "set-title"), setRow("Listening port", port), setRow("Seed until ratio (0 = don't seed)", ratio), setRow("Seed at most (minutes, 0 = no limit)", minutes), setRow("Upload limit (KB/s, 0 = none)", upload), save);
            return g;
        }

        void refresh(final List<DlItem> items, final List<TorrentEngine.Seed> seeds) {
            if (node == null) {
                return;
            }
            final List<Node> a = new ArrayList<Node>();
            for (final DlItem d : items) {
                if ("torrent".equals(d.kind) && !"completed".equals(d.state)) {
                    final HBox r = new HBox();
                    r.getStyleClass().add("row");
                    final VBox mid = new VBox(4, label(d.name, "row-name"), label((d.total > 0 ? size(d.loaded) + " of " + size(d.total) + "   " : "") + (d.message != null ? d.message : d.state), "dim"));
                    HBox.setHgrow(mid, Priority.ALWAYS);
                    r.getChildren().addAll(badge("torrent"), mid, label(d.total > 0 ? String.format("%.1f%%", 100.0 * d.loaded / d.total) : "", "pct"));
                    a.add(r);
                }
            }
            if (a.isEmpty()) {
                a.add(label("No torrents downloading.", "muted"));
            }
            active.getChildren().setAll(a);
            final HakobuSettings cfg = HakobuSettings.get();
            final List<Node> s = new ArrayList<Node>();
            for (final TorrentEngine.Seed seed : seeds) {
                final HBox r = new HBox();
                r.getStyleClass().add("row");
                final long mins = (System.currentTimeMillis() - seed.started) / 60000;
                final VBox mid = new VBox(4, label(seed.name, "row-name"), label(String.format("ratio %.2f of %.2f   %s up   %d peers   %d min%s", seed.ratio(), cfg.getSeedRatio(), size(seed.uploadRate()).isEmpty() ? "0 B/s" : size(seed.uploadRate()) + "/s", seed.peers(), mins, cfg.getSeedMinutes() > 0 ? " of " + cfg.getSeedMinutes() : ""), "dim"));
                HBox.setHgrow(mid, Priority.ALWAYS);
                final Label pill = label("● Seeding", "pill", "pill-seeding");
                r.getChildren().addAll(badge("torrent"), mid, pill, iconButton(Icons.STOP, "Stop seeding", () -> TorrentEngine.stopSeeding(seed)));
                s.add(r);
            }
            if (s.isEmpty()) {
                s.add(label("Nothing seeding. Finished torrents seed here until the limits below are reached.", "muted"));
            }
            seeding.getChildren().setAll(s);
        }
    }

    static HBox setRow(final String text, final Node control) {
        final HBox r = new HBox();
        r.getStyleClass().add("set-row");
        final Label l = label(text, "set-label");
        r.getChildren().addAll(l, control);
        return r;
    }

    /* ---------------------------------------------------------------- settings view */
    final class SettingsView {
        private VBox node;

        Node node() {
            if (node == null) {
                node = new VBox();
                node.getStyleClass().add("content");
                final HakobuSettings cfg = HakobuSettings.get();
                final VBox general = new VBox();
                general.getStyleClass().add("set-group");
                final TextField folder = new TextField(Engine.downloadFolder());
                folder.setPrefWidth(420);
                final Button browse = button("Browse", () -> {
                    final DirectoryChooser dc = new DirectoryChooser();
                    final File cur = new File(folder.getText());
                    if (cur.isDirectory()) {
                        dc.setInitialDirectory(cur);
                    }
                    final File f = dc.showDialog(stage);
                    if (f != null) {
                        folder.setText(f.getAbsolutePath());
                        Engine.setDownloadFolder(f.getAbsolutePath());
                    }
                });
                folder.setOnAction(e -> Engine.setDownloadFolder(folder.getText()));
                final ComboBox<Integer> max = new ComboBox<Integer>();
                for (int i = 1; i <= 10; i++) {
                    max.getItems().add(i);
                }
                max.setValue(Engine.maxDownloads());
                max.setOnAction(e -> Engine.setMaxDownloads(max.getValue()));
                final ComboBox<String> quality = new ComboBox<String>();
                quality.getItems().addAll("Best quality", "2160p", "1440p", "1080p", "720p", "480p", "360p", "Audio only (m4a)");
                quality.setValue(fromQuality(cfg.getVideoQuality()));
                quality.setOnAction(e -> {
                    cfg.setVideoQuality(toQuality(quality.getValue()));
                    cfg.save();
                });
                final ComboBox<String> theme = new ComboBox<String>();
                theme.getItems().addAll("Dark", "OLED black", "Light");
                theme.setValue("oled".equals(cfg.getTheme()) ? "OLED black" : "light".equals(cfg.getTheme()) ? "Light" : "Dark");
                theme.setOnAction(e -> {
                    cfg.setTheme(theme.getValue().startsWith("OLED") ? "oled" : theme.getValue().toLowerCase());
                    cfg.save();
                    applyTheme();
                });
                final CheckBox clip = new CheckBox("Grab links I copy (clipboard watch)");
                clip.setSelected(org.jdownloader.settings.staticreferences.CFG_GUI.CLIPBOARD_MONITORED.isEnabled());
                clip.setOnAction(e -> org.jdownloader.settings.staticreferences.CFG_GUI.CLIPBOARD_MONITORED.setValue(clip.isSelected()));
                general.getChildren().addAll(label("General", "set-title"), setRow("Download folder", new HBox(8, folder, browse)), setRow("Downloads at the same time", max), setRow("Default video quality", quality), setRow("Theme", theme), clip);
                final FlowPane tiles = new FlowPane(12, 12);
                tiles.getChildren().addAll(
                        tile("Accounts", "Premium and debrid accounts (TorBox, Real-Debrid, file hosts)"),
                        tile("Captchas", "How captchas are shown: in the app or in your browser"),
                        tile("Connection", "Proxies, reconnect, bandwidth limits"),
                        tile("Packagizer", "Rules for folders, names and priorities"),
                        tile("Archive extraction", "Unpack .zip, .rar and .7z when done, passwords"),
                        tile("Scheduler and more", "Scheduler, folder watch, event scripter, all advanced options"));
                final VBox more = new VBox(10, label("More settings", "set-title"), label("Everything else JDownloader's engine can do opens in the full settings window.", "muted"), tiles);
                more.getStyleClass().add("set-group");
                final VBox inner = new VBox(16, general, more, aboutBox());
                final ScrollPane sp = new ScrollPane(inner);
                sp.setFitToWidth(true);
                VBox.setVgrow(sp, Priority.ALWAYS);
                node.getChildren().addAll(label("Settings", "title"), sp);
            }
            return node;
        }

        private Node tile(final String title, final String text) {
            final VBox t = new VBox();
            t.getStyleClass().add("tile");
            final Label d = label(text, "dim");
            d.setWrapText(true);
            t.getChildren().addAll(label(title, "tile-title"), d);
            t.setOnMouseClicked(e -> HakobuShell.showEngineWindow());
            return t;
        }

        private Node aboutBox() {
            final VBox a = new VBox(6);
            a.getStyleClass().add("set-group");
            final Label t = label("Hakobu (Java) is built on JDownloader 2 by AppWork GmbH and the JD community, jlibtorrent by FrostWire, and yt-dlp. GPL-3.0-or-later.", "muted");
            t.setWrapText(true);
            a.getChildren().addAll(label("About", "set-title"), t);
            return a;
        }
    }

    /* ---------------------------------------------------------------- test support */
    /** Writes a PNG of the window (used by the self-test). */
    public static void snapshot(final File out) throws Exception {
        final CountDownLatch done = new CountDownLatch(1);
        final Exception[] err = new Exception[1];
        Platform.runLater(() -> {
            try {
                final WritableImage img = INSTANCE.scene.getRoot().snapshot(new SnapshotParameters(), null);
                final int w = (int) img.getWidth(), h = (int) img.getHeight();
                final BufferedImage bi = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
                final PixelReader pr = img.getPixelReader();
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) {
                        bi.setRGB(x, y, pr.getArgb(x, y));
                    }
                }
                out.getParentFile().mkdirs();
                ImageIO.write(bi, "png", out);
            } catch (final Exception e) {
                err[0] = e;
            } finally {
                done.countDown();
            }
        });
        done.await();
        if (err[0] != null) {
            throw err[0];
        }
    }

    public static void runOnFx(final Runnable r) throws InterruptedException {
        final CountDownLatch done = new CountDownLatch(1);
        Platform.runLater(() -> {
            try {
                r.run();
            } finally {
                done.countDown();
            }
        });
        done.await();
    }
}

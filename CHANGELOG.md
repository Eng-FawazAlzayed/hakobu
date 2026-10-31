# Changelog

All notable changes to Hakobu are listed here. Versions follow [semantic versioning](https://semver.org).

## [0.4.0] - 2026-11-01

JDownloader-style handling of file hosts and their special cases.

### Added
- Built-in host support without debrid: MEGA files and folders (decrypted while downloading), Pixeldrain files and lists, Gofile folders, MediaFire files and folders, Google Drive files and folders (including the "can't scan for viruses" page), and 1fichier free downloads with their waits.
- Link crawler: folder links, DLC containers (open, drop or double-click a .dlc; the extension sends .dlc downloads to Hakobu), paste sites and web server "Index of" listings turn into their files in LinkGrabber, with sub-folders kept. Link protectors such as filecrypt are marked "protected" with a button to open them in the browser.
- Smart waits: HTTP 429/503 with Retry-After, MEGA's transfer quota, 1fichier's "wait 17 minutes", Google Drive's daily quota and a full disk put a download in "Waiting" with a countdown instead of failing. A host-wide wait holds the other downloads from that host too. Press play to try right away.
- Automatic retries for connection problems after 1, 5 and 15 minutes (setting).
- Mirrors: the same file (name and size) on several hosts downloads once; if one host fails, the next one takes over.
- File checks: CRC32, MD5, SHA-1 and SHA-256 from .sfv/.md5/.sha files in a package and from hashes hosts report (Pixeldrain, MediaFire, Gofile). A damaged file downloads again once, then shows as damaged.
- Links already in your downloads are marked in LinkGrabber and unticked. New setting for files already in the folder: keep both, skip if same size, or overwrite.
- Limits per host (downloads at a time, connections), with built-in limits for free MEGA and 1fichier.
- When a connection finishes early it splits the slowest remaining part, so the last percent doesn't crawl on one connection.
- Proxies: HTTP and SOCKS4/5, per host, either always or only to skip IP waits (the download moves to the next proxy instead of waiting).
- Host accounts in Settings: Rapidgator, Nitroflare, Keep2Share, 1fichier, Pixeldrain and Gofile, used before debrid, with a Test button. Stored encrypted.
- Not enough disk space is checked before a download starts.

## [0.3.5] - 2026-11-01

### Added
- Browser hand-off for file hosts with wait timers or captchas (like JDownloader): such downloads show Needs browser with a globe button that opens the page in your browser. You do the wait or captcha and click the site's download button; the Hakobu extension (0.2.0) catches that download and it continues in the same entry, folder and package. An optional setting opens these pages automatically. Hakobu never solves captchas itself.

## [0.3.4] - 2026-11-01

### Added
- Detail pages can list a title's files (game, updates, DLC) with a tick box and a file-host picker each, plus "Host for all"; the last host picked is remembered per source, and the picks go to LinkGrabber.

## [0.3.3] - 2026-11-01

### Fixed
- A download that failed on one connection no longer keeps reconnecting on the others in the background.
- Extracting a large RAR no longer freezes the window; it runs in its own process.
- Stopping or removing a torrent that had errored no longer hangs, and quitting never waits more than 10 seconds.
- A damaged downloads.json or settings.json is kept as a .corrupt copy (and you get a notice) instead of being silently replaced with an empty one. Settings are now saved atomically.
- Saving the download list retries when Windows briefly locks the file, never overlaps, and no longer gives up silently.

## [0.3.2] - 2026-11-01

### Added
- Plugin sources can hand file-host links to LinkGrabber instead of a torrent (one package per pick).

## [0.3.1] - 2026-10-31

### Added
- .hakobu-plugin files: double-click one (or drop it on the window) to install that plugin after a confirm prompt.
- Plugin manager: a share button saves any installed plugin as a .hakobu-plugin file.

## [0.3.0] - 2026-10-31

### Added
- Detail pages for plugin sources: click a card for a big cover, facts, screenshots, a description and a Download button.
- Search inside a plugin source: type in the filter box on its first page and press Enter.
- Portrait covers for sources whose art is posters or box art.

## [0.2.0] - 2026-10-31

### Added
- Plugin sources: a plugin can add its own entry under Source in the sidebar, with a grid of categories (for example consoles), a file list to tick from, and a Start button.
- Plugin manager in Settings: install a plugin file (or drop it onto the window), switch plugins on and off, remove them (they go to the Recycle Bin), with each plugin's description and version.
- Shop view for plugin sources that provide pictures: cover cards with region badges, a region filter, and a toggle back to the list.

## [0.1.1] - 2026-10-31

### Added
- Search plugins: put a `.js` file in `%APPDATA%\Hakobu\plugins` to add your own search source next to Jackett/Prowlarr. Plugins stay on your PC and are never bundled.
- Magnet links with `so=` (BEP 53 "select only") open with just those files ticked.
- A single file picked out of a big torrent is named after that file.

### Fixed
- File picker: a selected file that shares a piece with unselected neighbours (common in collections of small files) never downloaded.
- A crash when a second peer sent a torrent's file list after the add-torrent dialog had already closed it.

## [0.1.0] - 2026-10-31

First release.

- Direct downloads: up to 8 connections per file, resume across restarts, retries, speed limits.
- Torrents: magnets, .torrent files and info hashes, DHT/PEX/trackers, file picker, sequential mode, fast-resume, peers and trackers tabs.
- Debrid: TorBox and Real-Debrid for torrents and file-host links, cache status, live list of supported hosts, automatic fallback to a normal download if debrid fails.
- LinkGrabber: clipboard watching, packages, link checking, per-link route and save folder.
- Extras from qBittorrent: RSS with auto-download rules, Jackett/Prowlarr search, categories and tags, turtle limits and schedule.
- Extras from JDownloader: archive extraction with passwords, Click'n'Load, browser extension, scheduler, "when done" power actions.
- YouTube and about 1,800 other sites via yt-dlp (MP4 or MP3); yt-dlp, Deno and ffmpeg are downloaded and kept up to date automatically.
- OLED, Dark, Light and Frutiger Aero themes.

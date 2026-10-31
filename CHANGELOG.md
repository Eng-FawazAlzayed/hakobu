# Changelog

All notable changes to Hakobu are listed here. Versions follow [semantic versioning](https://semver.org).

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

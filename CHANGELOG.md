# Hakobu (Java) changelog

## 0.1.1 (2026-11-17)
- Magnet links with unencoded tracker URLs (`&tr=http://...`) are no longer split into extra links. Before, this cut the magnet short and queued a bogus "Host problem / ...tracker.torrent" row next to the torrent.
- `.torrent` link detection ignores tracker announce URLs and names that only contain ".torrent" (e.g. `tracker.torrent.eu.org`).
- The "Settings" button of captcha dialogs (and every other JDownloader "open settings" action) now opens the settings window instead of doing nothing behind the Hakobu window.
- Settings > More settings tiles open their own page (Accounts, Captchas, Connection, Packagizer, advanced options).
- Version shown in Settings > About.

## 0.1.0 (2026-11-15)
- First prototype: JDownloader 2 engine, Hakobu window (JavaFX), jlibtorrent torrents, yt-dlp video.

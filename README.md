# Hakobu

A Windows download manager that combines a **JDownloader-style** direct downloader with a **qBittorrent-style** torrent client, with **TorBox** and **Real-Debrid** built in.

## Install

Download one of the builds from the [Releases](../../releases) page:

- `Hakobu-Setup-<version>.exe`: installer. Registers `.torrent` files and `magnet:` links.
- `Hakobu-<version>-portable.exe`: a single file you can run from anywhere.

The installer finishes by downloading the newest yt-dlp, Deno and ffmpeg (about 150 MB, checksum-verified). The portable version offers the same setup on first start. These tools are downloaded rather than bundled, so you always get the newest versions and ffmpeg's GPL licence doesn't apply to the installer. If you're offline during install, the app offers the setup again on start.

Neither needs anything else installed. Electron bundles its own Chromium and Node.js runtime, and every library is inside.

## Browser extension (Chrome / Edge)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder. In the app, use **Settings → Browser extension → Open extension folder**.
3. Open the extension's settings and paste the token from that same Settings card.

It adds "Download with Hakobu" to the right-click menu, catches magnet clicks, can take over browser downloads (cookies and referrer go along so logged-in downloads still work), and sends every link on a page. Everything lands in LinkGrabber for approval. The API only listens on `127.0.0.1` and requires the token.

## Versioning

Hakobu uses [semantic versioning](https://semver.org). Each release is tagged `vX.Y.Z` and listed in [CHANGELOG.md](CHANGELOG.md).

## Develop

```bash
npm install
npm start          # run from source
npm test           # engine smoke tests (no Electron needed)
npm run dist       # build dist/*.exe
```

## Features

| | |
|---|---|
| **Direct downloads** | Up to 8 connections per file, pause/resume across restarts, retries, server filenames, global speed limit, queue limit |
| **Torrents (P2P)** | Magnets, `.torrent` files/URLs, bare info hashes. DHT, PEX, trackers, seed-ratio limit, up/down limits. Peer ID `-HB0010-` (honest client ID), fast-resume |
| **File picker** | Opening any torrent or magnet shows its file tree with sizes. Tick the files you want, pick the route and save folder. Works for P2P and debrid |
| **Debrid** | TorBox or Real-Debrid download the torrent in the cloud, then Hakobu fetches the files as fast direct downloads. Your IP never joins the swarm. Hoster links (Mega, Rapidgator, 1fichier…) can be unrestricted too. TorBox-cached torrents show ⚡ CACHED |
| **LinkGrabber** | Paste anywhere (Ctrl+V), drop files, or watch the clipboard. Links wait here for approval. Each link has its own route and save folder |
| **qBittorrent extras** | RSS feeds with auto-download rules (AND/OR/wildcards/regex, must-not, per-rule category/route/folder, live preview). Torrent search through Jackett/Prowlarr (Torznab). Categories (each with its own folder) and tags. Alternative "turtle" speed limits plus a weekly schedule. Per-item seed ratio/time, sequential download, change the file selection after starting, extra trackers. Peers tab (address, client, progress, speeds) and Trackers tab. Per-download speed limits for direct downloads |
| **JDownloader extras** | LinkGrabber groups links into packages automatically (`.part1.rar`, `.7z.001`, `CD1`…), with rename, a folder per package, and a Start button per package. Every link is checked first (online/offline, real name and size; hoster links via Real-Debrid's free check). Archives (ZIP, 7z, RAR incl. multi-volume/RAR5, split `.001`) are extracted automatically when a package finishes, using a password list and Click'n'Load passwords. Optional subfolder and archive cleanup. Download list grouped by package. Browser extension + Click'n'Load v2. Download scheduler (start/pause/turtle at set times) and a one-shot "when done: quit / sleep / shut down" with a 60-second cancel |
| **Host special cases** | Built-in MEGA (files + folders, decrypted on the fly), Pixeldrain, MediaFire, Google Drive and 1fichier (Gofile with a premium token). Folder links, DLC containers, pastes and "Index of" pages open into their files. Waits the host asks for (Retry-After, quotas, "wait 17 minutes") with a countdown, automatic retries, mirror failover, CRC/MD5/SHA checks from .sfv/.md5 files, per-host limits, HTTP/SOCKS proxies with rotation, premium accounts for Rapidgator, Nitroflare, Keep2Share and 1fichier |
| **YouTube & media** | YouTube, X/Twitter, Instagram, TikTok, Vimeo, SoundCloud and about 1,800 more sites via yt-dlp. MP4 (4K down to 480p) or MP3 (128 to 320 kbps) with cover art and tags. Playlists go into their own folder. Thumbnail and title previews in LinkGrabber, friendly errors, optional browser cookies for bot checks and age-restricted or login-only videos |
| **Media tools** | yt-dlp, Deno (YouTube's JS challenges) and ffmpeg are fetched from their official sources (GitHub, gyan.dev), always the newest version. Each is SHA-256 verified and test-run before use, and checked for updates daily |
| **Look** | Dark, OLED, Light and Frutiger Aero themes (or follow Windows), animated UI, toasts, live speed graph |

API keys are stored encrypted with Windows DPAPI and are only sent to the provider's own API.

## Layout

```
src/main.js                 Electron main: window, IPC, settings, magnet handler, clipboard
src/engine/manager.js       Queue/scheduler, persistence, debrid hand-off
src/engine/http.js          Segmented resumable HTTP downloader + rate limiter
src/engine/torrent.js       WebTorrent wrapper: file selection, metadata fetch
src/debrid/torbox.js        TorBox API
src/debrid/realdebrid.js    Real-Debrid API
src/linkparse.js            Link extraction / classification
src/renderer/               UI (renderer.js, torrent-dialog.js, styles.css, icons.js)
test/smoke.mjs              Engine tests
```

Dev helper: `HAKOBU_PROFILE=<dir> HAKOBU_SHOT=<dir> npx electron .` renders demo data in every theme and saves screenshots.

## Known limits

- Per-torrent speed caps aren't possible: WebTorrent only supports global P2P limits. Use the global or turtle limits.
- Search needs your own Jackett or Prowlarr. No indexers are built in.
- No router reconnect (JDownloader's way to dodge hoster wait times): debrid removes those wait times anyway.
- No captcha solving. Hosts and link protectors that want one go to your browser ("Needs browser"), and the extension brings the download or links back.
- Built-in host modules cover MEGA, Pixeldrain, MediaFire, Google Drive, 1fichier and BuzzHeavier without an account, plus Gofile, Rapidgator, Nitroflare and Keep2Share with your premium account. Other hosts go through debrid.
- Click'n'Load can't start while JDownloader itself is running (both use port 9666). Settings shows this.
- uTP is off (`utp-native` needs a native build). TCP and WebRTC peers work.

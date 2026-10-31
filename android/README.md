# Hakobu for Android

A native Kotlin version of Hakobu. It shares the desktop app's behaviour (the same link parsing,
routing rules and TorBox / Real-Debrid flows), ported from `src/` and covered by the same test cases.

## What works

- **Media (home screen)**: paste or share a YouTube, TikTok, Instagram, X, SoundCloud… link (about
  1,800 sites via yt-dlp). Hakobu shows the title, thumbnail and length, then saves MP4 (4K down to
  480p) or MP3 (128 to 320 kbps) with cover art and tags. Playlists go into their own folder. yt-dlp,
  Python and ffmpeg are built into the app, and yt-dlp updates itself once a day.
- **LinkGrabber**: paste links or any text with links in it, share a link to Hakobu from another app,
  tap a `magnet:` link, or open a `.torrent` file. Each link shows its route (Auto, Direct, TorBox,
  Real-Debrid), and **Check** shows the real file name, size and whether it's online.
- **Direct downloads**: up to 16 connections per file, pause and resume (also across app restarts),
  automatic retries, server file names, a global speed limit, and a limit on simultaneous downloads.
- **TorBox and Real-Debrid**: torrents and hoster links (Mega, Rapidgator, 1fichier…) are downloaded in
  the cloud, then fetched as direct downloads. Multi-file torrents go into their own folder. Hoster links
  are routed to whichever service supports that host, using both services' live host lists.
- **Background downloads**: a foreground service with a progress notification keeps downloads running
  with the screen off, and you get a notification when a file finishes.
- **Storage**: files go straight into `Download/Hakobu` through MediaStore, so no storage permission
  is needed and they show up in the Files app.
- API keys are encrypted with a key stored in the Android Keystore.

Not yet: P2P torrents (libtorrent4j), archive extraction, RSS feeds,
the torrent file picker and categories.

## Install

Every push builds an APK in GitHub Actions (**Actions → Android → hakobu-android-apk**). Download the
artifact, unzip it and open `app-release.apk` on the phone (allow installs from your browser or file
manager when asked). Android 10 or newer on an ARM phone (arm64 or armv7) is needed.

The release APK is currently signed with the debug key. Set up a proper signing key before publishing it anywhere.

## Develop

Open the `android` folder in Android Studio, or use the command line:

```bash
cd android
./gradlew :core:test            # engine tests (plain JVM, no Android SDK needed)
./gradlew :app:assembleDebug    # build the app (needs the Android SDK)
```

`HAKOBU_CORE_ONLY=1 ./gradlew :core:test` builds and tests just the engine on machines without the
Android SDK or Google's Maven repository.

## Layout

```
core/      Pure Kotlin engine, no Android dependencies
  LinkParser.kt          Link extraction / classification (src/linkparse.js)
  HttpEngine.kt          Segmented resumable HTTP downloader (src/engine/http.js)
  DownloadManager.kt     Queue, scheduling, persistence, debrid hand-off (src/engine/manager.js)
  HosterRegistry.kt      TorBox / Real-Debrid supported hosts (src/engine/hosters.js)
  LinkChecker.kt         Online check for the LinkGrabber (src/engine/linkcheck.js)
  Media.kt               Media engine interface, format options, friendly errors (src/engine/media.js)
  debrid/                TorBox and Real-Debrid clients (src/debrid)
  FileStore.kt           Where files are written (plain folder on the JVM)
app/       Android app (Jetpack Compose)
  Hakobu.kt              Wires the engine, settings and the download service together
  MediaStoreFileStore.kt Writes into Download/Hakobu via MediaStore
  YtDlpEngine.kt         yt-dlp + ffmpeg on the phone (youtubedl-android)
  DownloadService.kt     Foreground service + progress notification
  ui/                    Media, Links, Downloads and Settings screens
```

## Known limits

- Android 15 limits this kind of background service to 6 hours a day. When the limit is hit, Hakobu
  pauses everything; resume from the app.
- A download that stays paused for more than a week may have its partial file removed by Android.

# Hakobu (Java)

A personal-use fork of JDownloader 2 with torrents (jlibtorrent) and video sites (yt-dlp) added as JD plugins.
GPL-3.0-or-later. Built on JDownloader 2 (JD-Team / AppWork GmbH) and jlibtorrent (FrostWire); yt-dlp runs as a separate program.

- `jd2-upstream/` - shallow clone of github.com/mycodedoesnotcompile2/jdownloader_mirror (not committed)
- `hakobu-src/src/` - Hakobu code; files with the same path as upstream files replace them (TbCmV2, HTMLParser)
- `libs/jlibtorrent/` - jlibtorrent 2.0.15.3 + windows jar (not committed; SHA-256 checked against the release's SHA256SUMS.txt)
- `./build.sh upstream` builds JD2 + overlay; `./build.sh` rebuilds only the overlay
- `./run-dev.sh` starts it with the test profile in `run-home/`

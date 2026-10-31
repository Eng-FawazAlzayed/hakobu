; Runs at the end of installation: the app opens a small window that downloads the newest
; yt-dlp, Deno and ffmpeg from their official sources (checksum-verified), then exits.
; If it fails (offline), the app retries on its first start, so installation never fails because of it.
!macro customInstall
  DetailPrint "Downloading the newest yt-dlp, Deno and ffmpeg..."
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --setup-tools' $0
  DetailPrint "Media tools setup finished (code $0)"
!macroend

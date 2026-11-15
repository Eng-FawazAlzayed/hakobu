#!/bin/sh
# Builds Hakobu-Java: JD2 upstream (Java 8 bytecode) + Hakobu overlay (Java 17, overrides upstream classes of the same name).
# Usage: ./build.sh [upstream]   - "upstream" recompiles JD2 too (slow, ~5 min); default only recompiles the overlay.
set -e
cd "$(dirname "$0")"
J="/c/Program Files/Eclipse Adoptium/jdk-17.0.21.9-hotspot/bin"
OUT=build/jd2-classes
CP="$(cat build/tmp/cp.txt)$(ls libs/jlibtorrent/*.jar | tr '\n' ';')"
if [ "$1" = "upstream" ]; then
  rm -rf $OUT; mkdir -p $OUT
  "$J/javac" -J-Xmx6g -encoding UTF-8 -nowarn -proc:none -source 8 -target 8 -Xmaxerrs 100000 -cp "$CP" -d $OUT @build/tmp/src-work.txt
fi
find hakobu-src/src -name '*.java' > build/tmp/overlay.txt
"$J/javac" -encoding UTF-8 -nowarn -proc:none --release 17 -cp "$OUT;$CP" -d $OUT @build/tmp/overlay.txt
echo "$CP" > build/tmp/runcp.txt
echo "overlay built: $(wc -l < build/tmp/overlay.txt) files"

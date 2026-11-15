#!/bin/sh
# Dev launch of the self-built JD2 core (Hakobu Java prototype)
cd "$(dirname "$0")"
J="/c/Program Files/Eclipse Adoptium/jdk-17.0.21.9-hotspot/bin"
CP="build/jd2-classes;$(cat build/tmp/runcp.txt)"
exec "$J/java" -Xmx2g -DROOT="$(cygpath -w "$PWD/run-home")" --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.desktop/sun.awt=ALL-UNNAMED --add-opens java.desktop/javax.swing=ALL-UNNAMED -cp "$CP" org.jdownloader.startup.Main "$@"

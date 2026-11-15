#!/bin/sh
# Dev launch of Hakobu (Java): JD2 engine + Hakobu window, test profile in run-home.
# Extra JVM flags can go in HAKOBU_JVM (e.g. -Dhakobu.selftest=report.txt).
cd "$(dirname "$0")"
J="/c/Program Files/Eclipse Adoptium/jdk-17.0.21.9-hotspot/bin"
CP="build/jd2-classes;$(cat build/tmp/runcp.txt)"
exec "$J/java" -Xmx2g -DROOT="$(cygpath -w "${HAKOBU_ROOT:-$PWD/run-home}")" $HAKOBU_JVM -cp "$CP" org.hakobu.app.Launcher "$@"

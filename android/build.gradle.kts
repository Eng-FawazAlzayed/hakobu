// Plugins come from the buildscript classpath so the pure-Kotlin engine (:core) can be built
// without the Android Gradle plugin (set HAKOBU_CORE_ONLY=1).
buildscript {
    val kotlinVersion = "2.2.20"
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    dependencies {
        if (System.getenv("HAKOBU_CORE_ONLY") == null) {
            classpath("com.android.tools.build:gradle:8.13.0")
        }
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
        classpath("org.jetbrains.kotlin:kotlin-serialization:$kotlinVersion")
        classpath("org.jetbrains.kotlin:compose-compiler-gradle-plugin:$kotlinVersion")
    }
}

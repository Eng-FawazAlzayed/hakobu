pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "hakobu-android"

// HAKOBU_CORE_ONLY=1 builds and tests just the engine, on machines without the Android SDK.
include(":core")
if (System.getenv("HAKOBU_CORE_ONLY") == null) include(":app")

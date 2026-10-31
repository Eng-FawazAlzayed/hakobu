plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.hakobu.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.hakobu.android"
        minSdk = 29 // Android 10: MediaStore Downloads, so files land in Download/Hakobu without storage permissions
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
        // yt-dlp ships Python and ffmpeg per CPU type; phones from the last decade are arm64 or armv7.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // No release keystore yet: sign with the debug key so the APK installs. Replace before publishing.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        // yt-dlp, Python and ffmpeg run as executables from the native library folder, so it must be extracted.
        jniLibs.useLegacyPackaging = true
        resources.excludes += setOf("META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/previous-compilation-data.bin")
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2025.08.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
    implementation("io.coil-kt.coil3:coil-compose:3.3.0")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.3.0")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation("androidx.lifecycle:lifecycle-process:2.9.2")
}

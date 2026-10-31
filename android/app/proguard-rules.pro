# kotlinx.serialization: keep generated serializers for the engine's saved state.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class app.hakobu.core.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class app.hakobu.core.**$$serializer { *; }
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# youtubedl-android maps yt-dlp's JSON with Jackson reflection.
-keep class com.yausername.** { *; }
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.databind.**
-dontwarn java.beans.**
-keepattributes Signature, EnclosingMethod

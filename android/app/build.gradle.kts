plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The script lives in web/ so the APK and the bookmarklet always ship the same code.
val coreDir = layout.buildDirectory.dir("generated/core")
val copyCore by tasks.registering(Copy::class) {
    from(rootProject.file("../web/jurnali.js"))
    into(coreDir)
}
tasks.named("preBuild") { dependsOn(copyCore) }

android {
    namespace = "ge.jurnali"
    compileSdk = 35

    defaultConfig {
        applicationId = "ge.jurnali"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "0.1.0"
    }

    sourceSets["main"].assets.srcDir(coreDir.get().asFile)

    signingConfigs {
        create("release") {
            val keystore = System.getenv("KEYSTORE_FILE")
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Fall back to the debug key for local builds. CI always has the real one,
            // which matters: Android refuses updates signed with a different key.
            signingConfig = if (System.getenv("KEYSTORE_FILE") != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}

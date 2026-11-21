plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI signing: when SIGNING_STORE_FILE is set (GitHub Actions secrets), every build is signed
// with the same key so a new APK installs over the old one. Otherwise the local debug key is used.
val signingStoreFile: String? = System.getenv("SIGNING_STORE_FILE")?.takeIf { it.isNotBlank() }

android {
    namespace = "com.pikminbridge.mock"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pikminbridge.mock"
        minSdk = 26
        // 35 keeps Android 17's ACCESS_LOCAL_NETWORK opt-in (target 37+) out of the picture.
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 2)
        versionName = "0.2.0"
    }

    signingConfigs {
        if (signingStoreFile != null) {
            create("ci") {
                storeFile = file(signingStoreFile)
                storePassword = System.getenv("SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("SIGNING_KEY_ALIAS")
                keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("ci") ?: signingConfigs.getByName("debug")
        }
        debug {
            signingConfigs.findByName("ci")?.let { signingConfig = it }
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Also feeds Google Play Services' fused provider in mock mode.
    implementation("com.google.android.gms:play-services-location:21.3.0")
    // WebSocket link to the PC bridge over `adb reverse`.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

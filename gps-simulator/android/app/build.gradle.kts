plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.pikminbridge.mock"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pikminbridge.mock"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
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
    // Optional: also feeds Google Play Services' fused provider in mock mode.
    implementation("com.google.android.gms:play-services-location:21.3.0")
}

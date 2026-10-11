plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Public Firebase client identifiers only. Service-account keys stay on the server.
val firebase = listOf("APP_ID", "API_KEY", "PROJECT_ID", "SENDER_ID").associateWith {
    providers.environmentVariable("SIPPER_FIREBASE_$it").orElse("").get()
}
require(firebase.values.all { it.isEmpty() } || firebase.values.all { it.isNotEmpty() }) {
    "Set all four SIPPER_FIREBASE_* client identifiers, or leave all blank."
}
for ((name, value) in firebase) {
    require(value.isEmpty() || value.matches(Regex(when (name) {
        "APP_ID" -> "1:[0-9]+:android:[a-fA-F0-9]+"
        "API_KEY" -> "[a-zA-Z0-9_-]{20,200}"
        "PROJECT_ID" -> "[a-z][a-z0-9-]{4,61}[a-z0-9]"
        else -> "[0-9]{1,32}"
    }))) { "Invalid public Firebase client setting: $name" }
}

val releaseSigning = listOf("STORE_FILE", "STORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD").associateWith {
    providers.environmentVariable("SIPPER_ANDROID_SIGNING_$it").orElse("").get()
}
require(releaseSigning.values.all { it.isEmpty() } || releaseSigning.values.all { it.isNotEmpty() }) {
    "Set all four SIPPER_ANDROID_SIGNING_* values, or leave all blank for unsigned builds."
}

android {
    namespace = "com.hybes.sipper"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.hybes.sipper.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        firebase.forEach { (name, value) -> buildConfigField("String", "FIREBASE_$name", "\"$value\"") }
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    signingConfigs {
        if (releaseSigning.values.all { it.isNotEmpty() }) create("release") {
            storeFile = file(releaseSigning.getValue("STORE_FILE"))
            storePassword = releaseSigning.getValue("STORE_PASSWORD")
            keyAlias = releaseSigning.getValue("KEY_ALIAS")
            keyPassword = releaseSigning.getValue("KEY_PASSWORD")
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".development"; versionNameSuffix = "-dev"
            val managedUrl = providers.environmentVariable("SIPPER_MANAGED_URL").orElse("https://sipper.dev").get()
            require(managedUrl.matches(Regex("https?://[a-zA-Z0-9.\\[\\]:-]+/?"))) { "SIPPER_MANAGED_URL must be an origin without credentials, paths or parameters." }
            buildConfigField("String", "MANAGED_URL", "\"$managedUrl\"")
            manifestPlaceholders["appAuthRedirectScheme"] = "com.hybes.sipper.development"
            buildConfigField("String", "MANAGED_CALLBACK", "\"com.hybes.sipper.development:/oauth/callback\"")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
            buildConfigField("String", "MANAGED_URL", "\"https://sipper.dev\"")
            manifestPlaceholders["appAuthRedirectScheme"] = "com.hybes.sipper"
            buildConfigField("String", "MANAGED_CALLBACK", "\"com.hybes.sipper:/oauth/callback\"")
        }
    }
    sourceSets["main"].apply {
        java.srcDir("../vendor/pjsip/java")
        jniLibs.srcDir("../vendor/pjsip/jniLibs")
        assets.srcDir("../vendor/pjsip/assets")
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    packaging { jniLibs.useLegacyPackaging = false }
}
kotlin { jvmToolchain(17) }

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.08.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.3")
    implementation("androidx.core:core-telecom:1.0.0")
    implementation("net.openid:appauth:0.11.1")
    implementation("io.livekit:livekit-android:2.29.0")
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    implementation("androidx.work:work-runtime-ktx:2.11.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}

plugins {
  id("com.android.application")
}

android {
  namespace = "io.github.thatmre.spaceteamlan"
  compileSdk = 35

  defaultConfig {
    applicationId = "io.github.thatmre.spaceteamlan"
    // Adaptive launcher icons only, so no binary PNGs need to live in git.
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  // CI ships the debug variant: it is signed with the standard debug keystore,
  // which is what makes the artifact installable without a release key.
  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  testOptions {
    unitTests.isReturnDefaultValues = true
  }
}

dependencies {
  // The only dependency in the project, and it is test-only: HostAddress is
  // framework-free precisely so it can be tested on a plain JVM.
  testImplementation("junit:junit:4.13.2")
}

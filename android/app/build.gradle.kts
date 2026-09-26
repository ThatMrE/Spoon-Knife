plugins {
  id("com.android.application")
}

// The APK bundles the web client and the game rules so a phone can host a game
// with no laptop present. They are copied from the repository root rather than
// duplicated here: core/ is the single implementation of the rules, shared by
// the Node server and the phone.
val repoRoot: File = rootProject.projectDir.parentFile
val webAssets = layout.buildDirectory.dir("generated/web-assets")

val bundleWebClient = tasks.register<Sync>("bundleWebClient") {
  description = "Stages the web client, shared protocol and game rules as APK assets."
  // Sync rather than Copy so a file deleted upstream also leaves the APK.
  into(webAssets.map { it.dir("web") })
  from(File(repoRoot, "public"))
  from(File(repoRoot, "shared")) { into("shared") }
  from(File(repoRoot, "core")) { into("core") }

  doLast {
    // A silent partial copy would ship an APK that 404s on its own client, so
    // check the handful of files the host cannot start without.
    val root = webAssets.get().dir("web").asFile
    val required = listOf(
      "index.html", "js/app.js", "js/party.js", "js/side.js", "js/find.js", "css/style.css",
      "host/host.html", "host/bridge.js",
      "shared/protocol.js", "shared/looks.js", "core/rooms.js", "core/game.js",
      "core/sealed.js", "core/games/index.js", "core/games/taboo.js",
    )
    val missing = required.filterNot { File(root, it).isFile }
    if (missing.isNotEmpty()) {
      throw GradleException("web assets incomplete, missing: $missing (looked in $root)")
    }
  }
}

// preBuild is the documented hook that runs before asset merging.
tasks.named("preBuild") { dependsOn(bundleWebClient) }

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

  sourceSets["main"].assets.srcDir(webAssets)

  testOptions {
    unitTests.isReturnDefaultValues = true
  }
}

dependencies {
  // The only dependency in the project, and it is test-only: HostAddress is
  // framework-free precisely so it can be tested on a plain JVM.
  testImplementation("junit:junit:4.13.2")
}

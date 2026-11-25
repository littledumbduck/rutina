plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "es.rutina"
    compileSdk = 35

    defaultConfig {
        applicationId = "es.rutina"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    // Clave de firma fija (incluida en el repositorio) para que las versiones
    // nuevas se instalen encima de las anteriores sin desinstalar.
    signingConfigs {
        create("rutina") {
            storeFile = file("rutina.keystore")
            storePassword = "rutina"
            keyAlias = "rutina"
            keyPassword = "rutina"
        }
    }

    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("rutina") }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("rutina")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint { checkReleaseBuilds = false; abortOnError = false }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("web"))
}

// La interfaz es la misma que la de la versión web (apps-script/Index.html).
// Se copia a la APK cambiando google.script.run por el puente con Android.
val copiarWeb by tasks.registering(Copy::class) {
    from(rootProject.file("../apps-script/Index.html"))
    into(layout.buildDirectory.dir("web"))
    rename { "index.html" }
    filter { linea -> linea.replace("<base target=\"_top\">", "<script src=\"puente.js\"></script>") }
}
tasks.named("preBuild") { dependsOn(copiarWeb) }

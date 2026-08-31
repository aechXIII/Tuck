fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["backend_request"])),
    )
    .expect("failed to build Tauri permissions");
}

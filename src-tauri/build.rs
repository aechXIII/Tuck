fn main() {
    // the native player core is plain C shared with the platform backends; its tests are a
    // separate library that only the Rust test suite links
    println!("cargo:rerun-if-changed=native/player");
    cc::Build::new()
        .std("c11")
        .warnings(true)
        .files([
            "native/player/playback_state.c",
            "native/player/engine.c",
            "native/player/mix.c",
        ])
        .compile("tuck_player");
    cc::Build::new()
        .std("c11")
        .warnings(true)
        .file("native/player/tests/player_tests.c")
        .compile("tuck_player_tests");

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "backend_request",
            "platform_capabilities",
            "pick_video_files",
            "pick_audio_files",
            "pick_folder",
            "pick_ffmpeg_file",
            "pick_ffprobe_file",
            "pick_import_file",
            "pick_save_file",
            "copy_text",
            "open_output_folder",
            "open_local_document",
            "open_logs_folder",
            "open_config_folder",
            "close_window",
            "acknowledge_close_request",
            "confirm_close",
            "restart_app",
            "check_for_updates",
            "download_update",
            "install_update",
            "get_download_progress",
            "get_startup_files",
            "minimize_window",
            "toggle_maximize_window",
            "set_caption_maximize_area",
            "show_window_menu",
            "preview_surface_open",
            "preview_surface_viewport",
            "player_open",
            "player_command",
            "player_status",
        ]),
    ))
    .expect("failed to build Tauri permissions");
}

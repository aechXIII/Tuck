fn main() {
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
            "open_logs_folder",
            "open_config_folder",
            "close_window",
            "check_for_updates",
            "download_update",
            "install_update",
            "get_download_progress",
            "get_startup_files",
        ]),
    ))
    .expect("failed to build Tauri permissions");
}

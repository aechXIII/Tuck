//! Tuck's desktop-shell library.

pub mod backend;
pub mod commands;
pub mod platform;

use backend::{BackendLaunchConfig, BackendState};
use commands::backend::backend_request;
use commands::native::{
    close_window, copy_text, open_config_folder, open_logs_folder, open_output_folder,
    pick_audio_files, pick_ffmpeg_file, pick_ffprobe_file, pick_folder, pick_import_file,
    pick_save_file, pick_video_files, platform_capabilities,
};
use commands::startup::{extract_startup_args, get_startup_files, StartupState};
use commands::updates::{
    check_for_updates, download_update, get_download_progress, install_update,
};

pub fn run() {
    let repository_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a repository parent")
        .to_path_buf();
    let startup_files = extract_startup_args();
    let startup_state = StartupState::new(startup_files);
    let state = match BackendLaunchConfig::development_for_runtime(repository_root) {
        Ok(config) => tauri::async_runtime::block_on(BackendState::launch(config))
            .unwrap_or_else(BackendState::unavailable),
        Err(error) => BackendState::unavailable(error),
    };
    let shutdown_state = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(startup_state)
        .invoke_handler(tauri::generate_handler![
            backend_request,
            platform_capabilities,
            pick_video_files,
            pick_audio_files,
            pick_folder,
            pick_ffmpeg_file,
            pick_ffprobe_file,
            pick_import_file,
            pick_save_file,
            copy_text,
            open_output_folder,
            open_logs_folder,
            open_config_folder,
            close_window,
            check_for_updates,
            download_update,
            install_update,
            get_download_progress,
            get_startup_files
        ])
        .on_window_event(move |_window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = shutdown_state.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = state.shutdown().await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri desktop shell failed to run");
}

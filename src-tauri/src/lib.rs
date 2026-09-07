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
use commands::startup::{
    extract_startup_args, get_startup_files, handle_second_instance, StartupState,
};
use commands::updates::{
    check_for_updates, download_update, get_download_progress, install_update, UpdaterState,
};
use tauri::Manager;

fn allows_app_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(5173))
}

fn resolve_backend_config(
    app: &tauri::AppHandle,
) -> Result<BackendLaunchConfig, backend::PublicBackendError> {
    if tauri::is_dev() {
        let repository_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a repository parent")
            .to_path_buf();
        return BackendLaunchConfig::development_for_runtime(repository_root);
    }

    let resource_dir = app.path().resource_dir().map_err(|_| {
        backend::PublicBackendError::new(
            "BACKEND_START_FAILED",
            "The application resource directory could not be resolved.",
        )
    })?;
    let (sidecar, ffmpeg, ffprobe) = packaged_resource_paths(&resource_dir);
    BackendLaunchConfig::packaged(sidecar, resource_dir, Some(ffmpeg), Some(ffprobe))
}

fn packaged_resource_paths(
    resource_dir: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    #[cfg(windows)]
    {
        (
            resource_dir.join("tuck-sidecar.exe"),
            resource_dir.join("ffmpeg").join("ffmpeg.exe"),
            resource_dir.join("ffmpeg").join("ffprobe.exe"),
        )
    }
    #[cfg(not(windows))]
    {
        (
            resource_dir.join("tuck-sidecar"),
            resource_dir.join("ffmpeg").join("ffmpeg"),
            resource_dir.join("ffmpeg").join("ffprobe"),
        )
    }
}

pub fn run() {
    // must happen before the WebView starts so child WebKit processes inherit it
    platform::prepare_runtime_environment();

    let startup_files = extract_startup_args();
    let startup_state = StartupState::new(startup_files);

    let builder = tauri::Builder::default()
        // This plugin must be registered first so a second process forwards
        // arguments to the already-running shell before other plugins start.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Err(error) = handle_second_instance(app, args) {
                eprintln!("could not handle second Tuck instance: {error}");
            }
        }))
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-policy")
                .on_navigation(|_, url| allows_app_navigation(url))
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(startup_state)
        .manage(UpdaterState::default())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(platform::configure_webview)?;
            }
            let state = match resolve_backend_config(&app.handle().clone()) {
                Ok(config) => tauri::async_runtime::block_on(BackendState::launch(config))
                    .unwrap_or_else(BackendState::unavailable),
                Err(error) => BackendState::unavailable(error),
            };
            app.manage(state);
            Ok(())
        });

    let builder = builder.invoke_handler(tauri::generate_handler![
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
    ]);

    builder
        .on_window_event(move |window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<BackendState>() {
                    let state = state.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = state.shutdown().await;
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri desktop shell failed to run");
}

#[cfg(test)]
mod tests {
    use super::{allows_app_navigation, packaged_resource_paths};

    #[test]
    fn navigation_policy_allows_only_tuck_origins() {
        assert!(allows_app_navigation(
            &"tauri://localhost/".parse().unwrap()
        ));
        assert!(allows_app_navigation(
            &"http://tauri.localhost/index.html".parse().unwrap()
        ));
        assert!(!allows_app_navigation(
            &"https://example.com/download".parse().unwrap()
        ));
        assert!(!allows_app_navigation(
            &"file:///C:/secret.txt".parse().unwrap()
        ));
    }

    #[test]
    fn packaged_resource_names_match_the_target_platform() {
        let resource_dir = std::path::Path::new("resources");
        let (sidecar, ffmpeg, ffprobe) = packaged_resource_paths(resource_dir);
        #[cfg(windows)]
        {
            assert_eq!(
                sidecar,
                std::path::PathBuf::from("resources/tuck-sidecar.exe")
            );
            assert_eq!(
                ffmpeg,
                std::path::PathBuf::from("resources/ffmpeg/ffmpeg.exe")
            );
            assert_eq!(
                ffprobe,
                std::path::PathBuf::from("resources/ffmpeg/ffprobe.exe")
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(sidecar, std::path::PathBuf::from("resources/tuck-sidecar"));
            assert_eq!(ffmpeg, std::path::PathBuf::from("resources/ffmpeg/ffmpeg"));
            assert_eq!(
                ffprobe,
                std::path::PathBuf::from("resources/ffmpeg/ffprobe")
            );
        }
    }
}

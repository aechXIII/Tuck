//! Tuck's desktop-shell library.

pub mod backend;
pub mod commands;
pub mod platform;
pub mod player;

use backend::{BackendLaunchConfig, BackendState};
use commands::backend::backend_request;
use commands::desktop::{notify_when_unfocused, set_interface_size, set_taskbar_progress};
use commands::lifecycle::{
    acknowledge_close_request, confirm_close, handle_close_request, restart_app, CloseState,
};
use commands::native::{
    close_window, copy_file_to_clipboard, copy_text, open_config_folder, open_local_document,
    open_logs_folder, open_output_folder, pick_audio_files, pick_ffmpeg_file, pick_ffprobe_file,
    pick_folder, pick_import_file, pick_lut_file, pick_save_file, pick_video_files,
    platform_capabilities,
};
use commands::player::{preview_surface_open, preview_surface_viewport};
use commands::startup::{
    extract_startup_args, get_startup_files, handle_second_instance, StartupState,
};
use commands::updates::{
    check_for_updates, download_update, get_download_progress, install_update, UpdaterState,
};
use commands::window::{
    minimize_window, set_caption_maximize_area, show_window_menu, toggle_maximize_window,
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

#[cfg(windows)]
fn notify_window_resized(window: &tauri::Window) {
    use tauri::Emitter;
    platform::windows_caption::reposition(window);
    let state = platform::window_chrome::WindowChromeState {
        maximized: platform::windows_caption::is_maximized(window),
    };
    let _ = window.emit(platform::window_chrome::MAXIMIZED_EVENT, state);
}

#[cfg(not(windows))]
fn notify_window_resized(_window: &tauri::Window) {}

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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(startup_state)
        .manage(UpdaterState::default())
        .manage(CloseState::default())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(platform::configure_webview)?;
                // the page draws the title bar; Linux keeps its desktop's frame
                window.set_decorations(false)?;
                platform::windows_caption::remember_app(app.handle());
            }
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                platform::watch_gpu_renderer(&window, move || {
                    let app = handle.clone();
                    tauri::async_runtime::spawn(
                        commands::lifecycle::restart_after_gpu_renderer_crash(app),
                    );
                })?;
            }
            // the backend starts in the background so the page can draw its own
            // starting screen; requests made meanwhile wait for it to be ready
            let (state, starter) = BackendState::starting();
            app.manage(state);
            let config = resolve_backend_config(&app.handle().clone());
            tauri::async_runtime::spawn(async move {
                let result = match config {
                    Ok(config) => backend::BackendProcess::launch(config).await,
                    Err(error) => Err(error),
                };
                starter.finish(result);
            });
            Ok(())
        });

    let builder = builder.invoke_handler(tauri::generate_handler![
        backend_request,
        platform_capabilities,
        pick_video_files,
        pick_lut_file,
        pick_audio_files,
        pick_folder,
        pick_ffmpeg_file,
        pick_ffprobe_file,
        pick_import_file,
        pick_save_file,
        copy_text,
        copy_file_to_clipboard,
        open_output_folder,
        open_local_document,
        open_logs_folder,
        open_config_folder,
        close_window,
        acknowledge_close_request,
        confirm_close,
        restart_app,
        check_for_updates,
        download_update,
        install_update,
        get_download_progress,
        get_startup_files,
        minimize_window,
        toggle_maximize_window,
        set_caption_maximize_area,
        show_window_menu,
        set_interface_size,
        notify_when_unfocused,
        set_taskbar_progress,
        preview_surface_open,
        preview_surface_viewport
    ]);

    builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Resized(_) = event {
                notify_window_resized(window);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // keep the shell alive until running exports are confirmed and its
                // backend has released the installed files
                api.prevent_close();
                handle_close_request(window);
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

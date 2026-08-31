//! Tuck's desktop-shell library.

pub mod backend;
pub mod commands;
pub mod platform;

use backend::{BackendLaunchConfig, BackendState};
use commands::backend::backend_request;

pub fn run() {
    let repository_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a repository parent")
        .to_path_buf();
    let state = match BackendLaunchConfig::development_for_runtime(repository_root) {
        Ok(config) => tauri::async_runtime::block_on(BackendState::launch(config))
            .unwrap_or_else(BackendState::unavailable),
        Err(error) => BackendState::unavailable(error),
    };
    let shutdown_state = state.clone();

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![backend_request])
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

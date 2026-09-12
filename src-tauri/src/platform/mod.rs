pub mod capabilities;
pub mod opener;
pub mod startup;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use tokio::process::Child;
#[cfg(not(target_os = "linux"))]
use tokio::process::Command;

#[cfg(target_os = "linux")]
pub use linux::{
    configure_child_process, prepare_runtime_environment, terminate_process_tree, ProcessTreeGuard,
};
#[cfg(target_os = "windows")]
pub use windows::{configure_webview, terminate_process_tree, ProcessTreeGuard};

#[cfg(not(target_os = "linux"))]
pub fn configure_child_process(_command: &mut Command) {}

/// Linux applies WebView and GIO environment fixes here; other platforms need none.
#[cfg(not(target_os = "linux"))]
pub fn prepare_runtime_environment() {}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub struct ProcessTreeGuard;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
impl ProcessTreeGuard {
    pub fn attach(_child: &Child) -> std::io::Result<Self> {
        Ok(Self)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub async fn terminate_process_tree(child: &mut Child) -> std::io::Result<()> {
    child.kill().await
}

pub use capabilities::{
    capabilities_for_target, current_capabilities, is_packaged, PlatformCapabilities,
};
pub use opener::{
    open_app_folder_with_validation, open_with_validation, validate_path_for_open, Opener,
    SystemOpener,
};
pub use startup::{deliver_second_instance_args, normalize_startup_args, startup_files_ready};

pub mod capabilities;
pub mod opener;
pub mod startup;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use tokio::process::Child;

#[cfg(target_os = "linux")]
pub use linux::terminate_process_tree;
#[cfg(target_os = "windows")]
pub use windows::terminate_process_tree;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub async fn terminate_process_tree(child: &mut Child) -> std::io::Result<()> {
    child.kill().await
}

pub use capabilities::{
    capabilities_for_target, current_capabilities, is_packaged, PlatformCapabilities,
};
pub use opener::{
    open_app_folder_with_validation, open_with_validation, validate_output_path_and_get_folder,
    validate_path_for_open, Opener, SystemOpener,
};
pub use startup::{deliver_second_instance_args, normalize_startup_args, startup_files_ready};

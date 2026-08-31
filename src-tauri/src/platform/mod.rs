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

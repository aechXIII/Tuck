use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::io::{FromRawHandle, OwnedHandle};

use tokio::process::{Child, Command};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_core::Interface;

pub struct ProcessTreeGuard {
    _job: OwnedHandle,
}

impl ProcessTreeGuard {
    pub fn attach(child: &Child) -> std::io::Result<Self> {
        let process = child.raw_handle().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "child process handle is unavailable",
            )
        })?;
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(to_io_error)?;
            let owned = OwnedHandle::from_raw_handle(job.0);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(to_io_error)?;
            AssignProcessToJobObject(job, HANDLE(process)).map_err(to_io_error)?;
            Ok(Self { _job: owned })
        }
    }
}

fn to_io_error(error: windows_core::Error) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

pub fn configure_webview(webview: tauri::webview::PlatformWebview) {
    let result = (|| -> windows_core::Result<()> {
        unsafe {
            let core = webview.controller().CoreWebView2()?;
            let settings = core.Settings()?;
            settings.SetAreDefaultContextMenusEnabled(false)?;
            settings.SetAreDevToolsEnabled(false)?;
            settings.SetIsStatusBarEnabled(false)?;
            settings.SetIsZoomControlEnabled(false)?;
            let settings3 = settings.cast::<ICoreWebView2Settings3>()?;
            settings3.SetAreBrowserAcceleratorKeysEnabled(false)
        }
    })();
    if let Err(error) = result {
        eprintln!("Could not apply the desktop browser policy: {error}");
    }
}

pub async fn terminate_process_tree(child: &mut Child) -> std::io::Result<()> {
    let Some(process_id) = child.id() else {
        return Ok(());
    };
    let status = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .status()
        .await?;
    if status.success() {
        child.wait().await.map(|_| ())
    } else {
        child.kill().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn closing_the_job_terminates_the_attached_process() {
        let mut child = Command::new("ping")
            .args(["-t", "127.0.0.1"])
            .spawn()
            .expect("test process should start");
        let guard = ProcessTreeGuard::attach(&child).expect("test process should join the job");

        drop(guard);

        tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .expect("job close should terminate the process")
            .expect("terminated process should be waitable");
    }
}

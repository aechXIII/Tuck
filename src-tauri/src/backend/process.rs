use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, watch, Mutex, Notify};

use crate::commands::backend::BackendCommand;
use crate::platform::ProcessTreeGuard;

use super::pending::PendingRequests;
use super::protocol::{parse_stdout_frame, PublicBackendError, MAX_FRAME_BYTES};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const LIGHT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_STDERR_BYTES: usize = 65_536;

pub struct BackendLaunchConfig {
    program: PathBuf,
    args: Vec<OsString>,
    working_directory: PathBuf,
    data_root: Option<PathBuf>,
    extra_env: Vec<(OsString, OsString)>,
}

impl BackendLaunchConfig {
    pub fn development(
        repository_root: PathBuf,
        data_root: PathBuf,
    ) -> Result<Self, PublicBackendError> {
        let program = development_python_path(&repository_root);
        if !program.is_file() {
            return Err(PublicBackendError::new(
                "BACKEND_START_FAILED",
                "The repository Python virtual environment is unavailable.",
            ));
        }
        Ok(Self {
            program,
            args: vec![
                "-m".into(),
                "tuck.sidecar".into(),
                "--protocol".into(),
                "1".into(),
            ],
            working_directory: repository_root,
            data_root: Some(data_root),
            extra_env: Vec::new(),
        })
    }

    pub fn development_for_runtime(repository_root: PathBuf) -> Result<Self, PublicBackendError> {
        let mut config = Self::development(repository_root, PathBuf::new())?;
        config.data_root = None;
        Ok(config)
    }

    pub fn packaged(
        sidecar: PathBuf,
        resource_dir: PathBuf,
        ffmpeg: Option<PathBuf>,
        ffprobe: Option<PathBuf>,
    ) -> Result<Self, PublicBackendError> {
        if !sidecar.is_file() {
            return Err(PublicBackendError::new(
                "BACKEND_START_FAILED",
                "The packaged Tuck backend is missing from the application resources.",
            ));
        }
        let mut extra_env = Vec::new();
        if let Some(path) = ffmpeg.filter(|path| path.is_file()) {
            extra_env.push(("TUCK_BUNDLED_FFMPEG".into(), path.into_os_string()));
        }
        if let Some(path) = ffprobe.filter(|path| path.is_file()) {
            extra_env.push(("TUCK_BUNDLED_FFPROBE".into(), path.into_os_string()));
        }
        Ok(Self {
            program: sidecar,
            args: vec!["--protocol".into(), "1".into()],
            working_directory: resource_dir,
            // no data root override: keep the historical %LOCALAPPDATA%\Tuck\Tuck location
            data_root: None,
            extra_env,
        })
    }

    pub fn command<I, S>(
        program: PathBuf,
        args: I,
        working_directory: PathBuf,
        data_root: PathBuf,
    ) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self {
            program,
            args: args.into_iter().map(Into::into).collect(),
            working_directory,
            data_root: Some(data_root),
            extra_env: Vec::new(),
        }
    }
}

/// The shell's handle to the backend. It can exist before the backend has
/// started, so the window can draw while the backend launches; requests made in
/// that window wait for the launch to finish instead of failing.
#[derive(Clone)]
pub struct BackendState {
    slot: Arc<watch::Sender<Option<Arc<BackendProcess>>>>,
}

/// Finishes a [`BackendState`] created by [`BackendState::starting`]. Dropping
/// it unfinished marks the backend unavailable so waiting requests never hang.
pub struct BackendStarter {
    slot: Arc<watch::Sender<Option<Arc<BackendProcess>>>>,
    finished: bool,
}

impl BackendStarter {
    pub fn finish(mut self, result: Result<Arc<BackendProcess>, PublicBackendError>) {
        self.finished = true;
        let process = result.unwrap_or_else(|error| Arc::new(BackendProcess::unavailable(error)));
        self.slot.send_replace(Some(process));
    }
}

impl Drop for BackendStarter {
    fn drop(&mut self) {
        if !self.finished {
            self.slot
                .send_replace(Some(Arc::new(BackendProcess::unavailable(
                    PublicBackendError::new(
                        "BACKEND_START_FAILED",
                        "The Python backend stopped while it was starting.",
                    ),
                ))));
        }
    }
}

impl BackendState {
    pub fn starting() -> (Self, BackendStarter) {
        let (sender, _) = watch::channel(None);
        let slot = Arc::new(sender);
        (
            Self { slot: slot.clone() },
            BackendStarter {
                slot,
                finished: false,
            },
        )
    }

    pub async fn launch(config: BackendLaunchConfig) -> Result<Self, PublicBackendError> {
        Ok(Self::ready(BackendProcess::launch(config).await?))
    }

    pub fn unavailable(error: PublicBackendError) -> Self {
        Self::ready(Arc::new(BackendProcess::unavailable(error)))
    }

    fn ready(process: Arc<BackendProcess>) -> Self {
        let (state, starter) = Self::starting();
        starter.finish(Ok(process));
        state
    }

    async fn process(&self) -> Arc<BackendProcess> {
        let mut receiver = self.slot.subscribe();
        let started = match receiver.wait_for(Option::is_some).await {
            Ok(process) => process.clone(),
            // the state owns the sender, so the channel cannot close while it is borrowed
            Err(_) => None,
        };
        started.unwrap_or_else(|| {
            Arc::new(BackendProcess::unavailable(PublicBackendError::new(
                "BACKEND_START_FAILED",
                "The Python backend could not start.",
            )))
        })
    }

    pub async fn request(&self, command: BackendCommand) -> Result<Value, PublicBackendError> {
        self.process().await.request(command).await
    }

    /// True only while a started backend is serving requests. A backend that is
    /// still starting has no work to lose, so this does not wait for it.
    pub async fn is_running(&self) -> bool {
        let process = self.slot.borrow().clone();
        match process {
            Some(process) => process.is_running().await,
            None => false,
        }
    }

    pub async fn shutdown(&self) -> Result<(), PublicBackendError> {
        self.process().await.shutdown().await
    }
}

/// What the shell sends to the sidecar: a webview-allowlisted command, or the
/// shutdown request that only the native lifecycle may send.
enum Outgoing<'a> {
    Command(&'a BackendCommand),
    Shutdown,
}

impl Outgoing<'_> {
    fn frame(&self, request_id: &str) -> Result<Value, PublicBackendError> {
        match self {
            Self::Command(command) => command.to_sidecar_request(request_id),
            Self::Shutdown => {
                super::protocol::request_frame(request_id, "shutdown", Value::Object(Map::new()))
            }
        }
    }
}

pub struct BackendProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: PendingRequests,
    phase: Mutex<Phase>,
    request_sequence: AtomicU64,
    shutdown_started: AtomicBool,
    stderr: Mutex<String>,
    stderr_closed: AtomicBool,
    stderr_done: Notify,
    // drop this after the child so Linux can kill and reap its whole process group
    process_tree: Mutex<Option<ProcessTreeGuard>>,
}

#[derive(Clone)]
enum Phase {
    Running,
    Stopping,
    Stopped,
    Fatal(PublicBackendError),
}

impl BackendProcess {
    pub async fn launch(config: BackendLaunchConfig) -> Result<Arc<Self>, PublicBackendError> {
        let mut command = Command::new(&config.program);
        command
            .args(&config.args)
            .current_dir(&config.working_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        crate::platform::configure_child_process(&mut command);
        // the frozen sidecar is a console executable; without this flag Windows
        // shows an empty console window behind the packaged GUI
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        if let Some(data_root) = &config.data_root {
            command.env("TUCK_SIDECAR_DATA_ROOT", data_root);
        } else {
            // This lets the shell and sidecar agree on the platformdirs default
            // instead of inheriting a test-only storage-root override.
            command.env_remove("TUCK_SIDECAR_DATA_ROOT");
        }
        for (key, value) in &config.extra_env {
            command.env(key, value);
        }
        command.env("TUCK_DESKTOP_PLATFORM", desktop_platform());

        let mut child = command.spawn().map_err(|_| {
            PublicBackendError::new(
                "BACKEND_START_FAILED",
                "The Python backend process could not start.",
            )
        })?;
        let process_tree = match ProcessTreeGuard::attach(&child) {
            Ok(process_tree) => process_tree,
            Err(_) => {
                let _ = crate::platform::terminate_process_tree(&mut child).await;
                return Err(PublicBackendError::new(
                    "BACKEND_START_FAILED",
                    "The Python backend process could not be supervised.",
                ));
            }
        };
        let stdin = child.stdin.take().ok_or_else(|| {
            PublicBackendError::new(
                "BACKEND_START_FAILED",
                "The backend stdin pipe is unavailable.",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            PublicBackendError::new(
                "BACKEND_START_FAILED",
                "The backend stdout pipe is unavailable.",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            PublicBackendError::new(
                "BACKEND_START_FAILED",
                "The backend stderr pipe is unavailable.",
            )
        })?;
        let process = Arc::new(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            pending: PendingRequests::new(),
            phase: Mutex::new(Phase::Running),
            request_sequence: AtomicU64::new(1),
            shutdown_started: AtomicBool::new(false),
            stderr: Mutex::new(String::new()),
            stderr_closed: AtomicBool::new(false),
            stderr_done: Notify::new(),
            process_tree: Mutex::new(Some(process_tree)),
        });

        let (ready_sender, ready_receiver) = oneshot::channel();
        tokio::spawn(process.clone().read_stdout(stdout, ready_sender));
        tokio::spawn(process.clone().read_stderr(stderr));

        match tokio::time::timeout(STARTUP_TIMEOUT, ready_receiver).await {
            Ok(Ok(Ok(()))) => Ok(process),
            Ok(Ok(Err(error))) => {
                let _ = process.shutdown().await;
                Err(error)
            }
            Ok(Err(_)) => {
                let error = process
                    .backend_error(
                        "BACKEND_EXITED",
                        "The Python backend exited before reporting readiness.",
                    )
                    .await;
                let _ = process.shutdown().await;
                Err(error)
            }
            Err(_) => {
                let error = PublicBackendError::new(
                    "BACKEND_TIMEOUT",
                    "The Python backend did not become ready in time.",
                );
                process.mark_fatal(error.clone()).await;
                let _ = process.shutdown().await;
                Err(error)
            }
        }
    }

    pub fn unavailable(error: PublicBackendError) -> Self {
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            pending: PendingRequests::new(),
            phase: Mutex::new(Phase::Fatal(error)),
            request_sequence: AtomicU64::new(1),
            shutdown_started: AtomicBool::new(false),
            stderr: Mutex::new(String::new()),
            stderr_closed: AtomicBool::new(true),
            stderr_done: Notify::new(),
            process_tree: Mutex::new(None),
        }
    }

    pub async fn request(&self, command: BackendCommand) -> Result<Value, PublicBackendError> {
        let timeout = command.timeout();
        self.request_with_timeout(command, timeout).await
    }

    pub async fn request_with_timeout(
        &self,
        command: BackendCommand,
        timeout: Duration,
    ) -> Result<Value, PublicBackendError> {
        self.send_request(Outgoing::Command(&command), timeout, false)
            .await
    }

    pub async fn pending_count(&self) -> usize {
        self.pending.count().await
    }

    pub async fn is_running(&self) -> bool {
        matches!(*self.phase.lock().await, Phase::Running)
    }

    pub async fn shutdown(&self) -> Result<(), PublicBackendError> {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        let should_request_shutdown = {
            let mut phase = self.phase.lock().await;
            match &*phase {
                Phase::Running => {
                    *phase = Phase::Stopping;
                    true
                }
                Phase::Fatal(_) => {
                    *phase = Phase::Stopping;
                    false
                }
                Phase::Stopping | Phase::Stopped => false,
            }
        };
        let graceful_result = if should_request_shutdown {
            self.send_request(Outgoing::Shutdown, LIGHT_REQUEST_TIMEOUT, true)
                .await
                .map(|_| ())
        } else {
            Ok(())
        };

        self.stdin.lock().await.take();
        self.reap_child().await?;
        self.pending
            .fail_all(
                self.backend_error("BACKEND_EXITED", "The Python backend has stopped.")
                    .await,
            )
            .await;
        *self.phase.lock().await = Phase::Stopped;
        graceful_result
    }

    async fn send_request(
        &self,
        outgoing: Outgoing<'_>,
        timeout: Duration,
        allow_stopping: bool,
    ) -> Result<Value, PublicBackendError> {
        if let Some(error) = self.current_failure(allow_stopping).await {
            return Err(error);
        }
        let request_id = format!(
            "rust-{}",
            self.request_sequence.fetch_add(1, Ordering::Relaxed)
        );
        let frame = outgoing.frame(&request_id)?;
        let encoded = serde_json::to_vec(&frame).map_err(|_| {
            PublicBackendError::new(
                "INVALID_BACKEND_REQUEST",
                "The desktop shell could not encode the backend request.",
            )
        })?;
        if encoded.len() > MAX_FRAME_BYTES {
            return Err(PublicBackendError::new(
                "INVALID_BACKEND_REQUEST",
                "The backend request exceeds the protocol size limit.",
            ));
        }
        let receiver = self.pending.register(request_id.clone()).await;
        if let Err(error) = self.write_frame(&encoded).await {
            self.pending.remove(&request_id).await;
            return Err(error);
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self
                .backend_error(
                    "BACKEND_EXITED",
                    "The Python backend closed the request channel.",
                )
                .await),
            Err(_) => {
                self.pending.remove(&request_id).await;
                Err(PublicBackendError::new(
                    "BACKEND_TIMEOUT",
                    "The Python backend did not respond in time.",
                )
                .with_details(Map::from_iter([(
                    "timeout_ms".into(),
                    Value::from(timeout.as_millis() as u64),
                )])))
            }
        }
    }

    async fn write_frame(&self, encoded: &[u8]) -> Result<(), PublicBackendError> {
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| {
            PublicBackendError::new("BACKEND_EXITED", "The Python backend stdin pipe is closed.")
        })?;
        stdin.write_all(encoded).await.map_err(|_| {
            PublicBackendError::new("BACKEND_EXITED", "The Python backend stdin pipe failed.")
        })?;
        stdin.write_all(b"\n").await.map_err(|_| {
            PublicBackendError::new("BACKEND_EXITED", "The Python backend stdin pipe failed.")
        })?;
        stdin.flush().await.map_err(|_| {
            PublicBackendError::new("BACKEND_EXITED", "The Python backend stdin pipe failed.")
        })
    }

    async fn current_failure(&self, allow_stopping: bool) -> Option<PublicBackendError> {
        let phase = self.phase.lock().await.clone();
        match phase {
            Phase::Running => None,
            Phase::Stopping if allow_stopping => None,
            Phase::Fatal(error) => Some(error),
            Phase::Stopping | Phase::Stopped => Some(
                self.backend_error("BACKEND_EXITED", "The Python backend is not running.")
                    .await,
            ),
        }
    }

    async fn read_stdout(
        self: Arc<Self>,
        stdout: ChildStdout,
        ready_sender: oneshot::Sender<Result<(), PublicBackendError>>,
    ) {
        let mut ready_sender = Some(ready_sender);
        let mut ready_received = false;
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 8192];
        let mut stdout = stdout;

        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) => {
                    self.wait_for_stderr().await;
                    let error = self
                        .backend_error(
                            "BACKEND_EXITED",
                            "The Python backend closed its protocol output.",
                        )
                        .await;
                    if let Some(sender) = ready_sender.take() {
                        let _ = sender.send(Err(error.clone()));
                    }
                    self.mark_fatal(error).await;
                    return;
                }
                Ok(read) => {
                    buffer.extend_from_slice(&chunk[..read]);
                    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                        if newline > MAX_FRAME_BYTES {
                            self.protocol_failure(
                                &mut ready_sender,
                                "The Python backend exceeded the protocol size limit.",
                            )
                            .await;
                            return;
                        }
                        let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
                        line.pop();
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        let line = match std::str::from_utf8(&line) {
                            Ok(line) => line,
                            Err(_) => {
                                self.protocol_failure(
                                    &mut ready_sender,
                                    "The Python backend emitted non-UTF-8 protocol output.",
                                )
                                .await;
                                return;
                            }
                        };
                        match parse_stdout_frame(line) {
                            Ok(super::protocol::BackendFrame::Ready { backend_version }) => {
                                if ready_received || !versions_are_compatible(&backend_version) {
                                    self.protocol_failure(
                                        &mut ready_sender,
                                        "The Python backend reported an incompatible protocol version.",
                                    )
                                    .await;
                                    return;
                                }
                                ready_received = true;
                                if let Some(sender) = ready_sender.take() {
                                    let _ = sender.send(Ok(()));
                                }
                            }
                            Ok(super::protocol::BackendFrame::Fatal(error)) => {
                                if let Some(sender) = ready_sender.take() {
                                    let _ = sender.send(Err(error.clone()));
                                }
                                self.mark_fatal(error).await;
                                return;
                            }
                            Ok(super::protocol::BackendFrame::Response { request_id, result }) => {
                                if !ready_received {
                                    self.protocol_failure(
                                        &mut ready_sender,
                                        "The Python backend responded before reporting readiness.",
                                    )
                                    .await;
                                    return;
                                }
                                let _ = self.pending.resolve(&request_id, result).await;
                            }
                            Err(error) => {
                                if let Some(sender) = ready_sender.take() {
                                    let _ = sender.send(Err(error.clone()));
                                }
                                self.mark_fatal(error).await;
                                return;
                            }
                        }
                    }
                    if buffer.len() > MAX_FRAME_BYTES {
                        self.protocol_failure(
                            &mut ready_sender,
                            "The Python backend exceeded the protocol size limit.",
                        )
                        .await;
                        return;
                    }
                }
                Err(_) => {
                    self.wait_for_stderr().await;
                    let error = self
                        .backend_error(
                            "BACKEND_EXITED",
                            "The Python backend protocol output failed.",
                        )
                        .await;
                    if let Some(sender) = ready_sender.take() {
                        let _ = sender.send(Err(error.clone()));
                    }
                    self.mark_fatal(error).await;
                    return;
                }
            }
        }
    }

    async fn read_stderr(self: Arc<Self>, mut stderr: ChildStderr) {
        let mut chunk = [0_u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let text = String::from_utf8_lossy(&chunk[..read]);
                    let mut captured = self.stderr.lock().await;
                    keep_stderr_tail(&mut captured, &text, MAX_STDERR_BYTES);
                }
            }
        }
        self.stderr_closed.store(true, Ordering::Release);
        self.stderr_done.notify_waiters();
    }

    async fn protocol_failure(
        &self,
        ready_sender: &mut Option<oneshot::Sender<Result<(), PublicBackendError>>>,
        message: &str,
    ) {
        let error = PublicBackendError::new("MALFORMED_BACKEND_OUTPUT", message);
        if let Some(sender) = ready_sender.take() {
            let _ = sender.send(Err(error.clone()));
        }
        self.mark_fatal(error).await;
    }

    async fn mark_fatal(&self, error: PublicBackendError) {
        let changed = {
            let mut phase = self.phase.lock().await;
            if matches!(*phase, Phase::Running) {
                *phase = Phase::Fatal(error.clone());
                true
            } else {
                false
            }
        };
        if changed {
            self.pending.fail_all(error).await;
        }
    }

    async fn backend_error(&self, code: &str, message: &str) -> PublicBackendError {
        let stderr = self.stderr.lock().await.clone();
        let details = if stderr.is_empty() {
            Map::new()
        } else {
            Map::from_iter([("stderr".into(), Value::String(stderr))])
        };
        PublicBackendError::new(code, message).with_details(details)
    }

    async fn wait_for_stderr(&self) {
        loop {
            let notified = self.stderr_done.notified();
            if self.stderr_closed.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    async fn reap_child(&self) -> Result<(), PublicBackendError> {
        let mut child_slot = self.child.lock().await;
        if child_slot.is_none() {
            return Ok(());
        }
        let wait_result = {
            let child = child_slot
                .as_mut()
                .expect("backend child is present after the guard");
            tokio::time::timeout(PROCESS_EXIT_TIMEOUT, child.wait()).await
        };
        match wait_result {
            Ok(Ok(_)) => {
                child_slot.take();
                self.disarm_process_tree().await;
                Ok(())
            }
            Ok(Err(_)) => Err(PublicBackendError::new(
                "BACKEND_EXITED",
                "The Python backend process could not be reaped.",
            )),
            Err(_) => {
                let child = child_slot
                    .as_mut()
                    .expect("backend child is present after the guard");
                crate::platform::terminate_process_tree(child)
                    .await
                    .map_err(|_| {
                        PublicBackendError::new(
                            "BACKEND_EXITED",
                            "The Python backend process could not be stopped.",
                        )
                    })?;
                child_slot.take();
                self.disarm_process_tree().await;
                Ok(())
            }
        }
    }

    #[cfg(target_os = "linux")]
    async fn disarm_process_tree(&self) {
        if let Some(process_tree) = self.process_tree.lock().await.as_mut() {
            process_tree.disarm();
        }
    }

    #[cfg(not(target_os = "linux"))]
    async fn disarm_process_tree(&self) {
        // windows keeps the job handle alive until BackendProcess itself drops
        let _ = &self.process_tree;
    }
}

// a crash traceback is written last, so the newest output is the useful part
fn keep_stderr_tail(captured: &mut String, text: &str, max_bytes: usize) {
    captured.push_str(text);
    if captured.len() > max_bytes {
        let cut = captured.ceil_char_boundary(captured.len() - max_bytes);
        captured.drain(..cut);
    }
}

fn development_python_path(repository_root: &std::path::Path) -> PathBuf {
    let venv = repository_root.join(".venv");
    #[cfg(windows)]
    {
        venv.join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        venv.join("bin").join("python")
    }
}

fn desktop_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        "linux"
    }
}

fn versions_are_compatible(backend_version: &str) -> bool {
    let current = env!("CARGO_PKG_VERSION");
    let parse = |version: &str| -> Option<(u64, u64)> {
        let mut fields = version.split('.');
        Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
    };
    match (parse(current), parse(backend_version)) {
        (Some((current_major, current_minor)), Some((backend_major, backend_minor))) => {
            current_major == backend_major && (current_major != 0 || current_minor == backend_minor)
        }
        _ => false,
    }
}

impl BackendCommand {
    fn timeout(&self) -> Duration {
        match self {
            Self::Health
            | Self::AnalyzeCut { .. }
            | Self::GetCutAnalysis { .. }
            | Self::CancelCutWork { .. }
            | Self::GetJoin { .. }
            | Self::CancelJoin { .. }
            | Self::ListLuts
            | Self::ClearLutHistory
            | Self::GetQueueState
            | Self::CancelItem { .. }
            | Self::RemoveItem { .. }
            | Self::CancelAllItems
            | Self::ClearCompleted
            | Self::ClearFinished
            | Self::RetryAllItems
            | Self::ResumeExports
            | Self::MoveItem { .. }
            | Self::StopAfterCurrent
            | Self::GetDiagnostics { .. }
            | Self::GetStoragePaths
            | Self::GetSettings
            | Self::SaveSettings { .. }
            | Self::RefreshEncoders
            | Self::ExportSettingsToFile { .. }
            | Self::ImportSettingsFromFile { .. }
            | Self::ResetSettings
            | Self::GetProfilesJson
            | Self::CreateProfile { .. }
            | Self::UpdateProfile { .. }
            | Self::DeleteProfile { .. }
            | Self::DuplicateProfile { .. }
            | Self::ImportProfilesFromFile { .. }
            | Self::ExportProfileToFile { .. }
            | Self::InstallGenericSendto { .. }
            | Self::RemoveGenericSendto { .. }
            | Self::RepairGenericSendto { .. }
            | Self::InstallProfileSendto { .. }
            | Self::RemoveProfileSendto { .. }
            | Self::RepairProfileSendto { .. }
            | Self::ListSendtoShortcuts => LIGHT_REQUEST_TIMEOUT,
            Self::LoadLut { .. }
            | Self::ProbeFile { .. }
            | Self::ProbeAudioFile { .. }
            | Self::GetWaveform { .. }
            | Self::GetThumbnail { .. }
            | Self::GetTimelineFrames { .. }
            | Self::ExportFrame { .. }
            | Self::GetMediaUrl { .. }
            | Self::ReleaseMediaToken { .. }
            | Self::CreatePlan { .. }
            | Self::JoinVideos { .. }
            | Self::CompilePreviewMix { .. }
            | Self::EnqueueWithOptions { .. }
            | Self::RetryItem { .. }
            | Self::EnqueueBatch { .. } => MEDIA_REQUEST_TIMEOUT,
        }
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;

    #[test]
    fn stderr_keeps_the_newest_output_within_the_limit() {
        let mut captured = String::new();
        keep_stderr_tail(&mut captured, "early noise\n", 16);
        keep_stderr_tail(&mut captured, "Traceback: boom\n", 16);
        assert_eq!(captured, "Traceback: boom\n");

        // a multi-byte character at the cut point is dropped whole, never split
        let mut captured = String::new();
        keep_stderr_tail(&mut captured, "aé", 2);
        assert_eq!(captured, "é");
        keep_stderr_tail(&mut captured, "xyz", 2);
        assert_eq!(captured, "yz");
    }

    #[tokio::test]
    async fn requests_wait_for_a_backend_that_is_still_starting() {
        let (state, starter) = BackendState::starting();
        assert!(!state.is_running().await);
        let waiting = tokio::spawn({
            let state = state.clone();
            async move { state.request(BackendCommand::Health).await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());

        starter.finish(Err(PublicBackendError::new(
            "BACKEND_START_FAILED",
            "could not start",
        )));
        let error = waiting
            .await
            .unwrap()
            .expect_err("an unavailable backend fails the waiting request");
        assert_eq!(error.code, "BACKEND_START_FAILED");
        assert!(!state.is_running().await);
    }

    #[tokio::test]
    async fn an_abandoned_start_does_not_leave_requests_hanging() {
        let (state, starter) = BackendState::starting();
        drop(starter);
        let error = state
            .request(BackendCommand::Health)
            .await
            .expect_err("an abandoned start reports the backend unavailable");
        assert_eq!(error.code, "BACKEND_START_FAILED");
    }

    #[test]
    fn shutdown_is_a_native_request_the_webview_cannot_name() {
        let frame = Outgoing::Shutdown.frame("stop-1").unwrap();
        assert_eq!(frame["method"], "shutdown");
        assert_eq!(frame["params"], serde_json::json!({}));
        assert!(serde_json::from_value::<BackendCommand>(
            serde_json::json!({"command": "shutdown"})
        )
        .is_err());
    }
}

#[cfg(test)]
mod launch_config_tests {
    use super::*;
    use std::fs;

    #[test]
    fn whole_queue_actions_answer_quickly() {
        // each export checks its video when it starts, so these never wait on a scan
        for command in [
            BackendCommand::RetryAllItems,
            BackendCommand::ResumeExports,
            BackendCommand::ClearFinished,
        ] {
            assert_eq!(command.timeout(), LIGHT_REQUEST_TIMEOUT);
        }
    }

    #[test]
    fn retry_allows_time_for_cut_reanalysis() {
        assert_eq!(
            BackendCommand::RetryItem {
                item_id: "cut".into()
            }
            .timeout(),
            MEDIA_REQUEST_TIMEOUT
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tuck-launchcfg-{name}-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn env_value(config: &BackendLaunchConfig, key: &str) -> Option<OsString> {
        config
            .extra_env
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }

    #[test]
    fn packaged_requires_the_sidecar_executable() {
        let dir = temp_dir("missing");
        let result =
            BackendLaunchConfig::packaged(dir.join("tuck-sidecar.exe"), dir.clone(), None, None);
        let Err(error) = result else {
            panic!("missing sidecar must fail");
        };
        assert_eq!(error.code, "BACKEND_START_FAILED");
    }

    #[test]
    fn development_python_path_matches_the_target_platform() {
        let path = development_python_path(std::path::Path::new("repository"));
        #[cfg(windows)]
        assert_eq!(path, PathBuf::from("repository/.venv/Scripts/python.exe"));
        #[cfg(not(windows))]
        assert_eq!(path, PathBuf::from("repository/.venv/bin/python"));
    }

    #[test]
    fn desktop_platform_is_authoritative_for_the_target() {
        #[cfg(target_os = "windows")]
        assert_eq!(desktop_platform(), "windows");
        #[cfg(target_os = "linux")]
        assert_eq!(desktop_platform(), "linux");
    }

    #[test]
    fn packaged_passes_only_existing_media_tools_and_no_data_root() {
        let dir = temp_dir("tools");
        let sidecar = dir.join("tuck-sidecar.exe");
        let ffmpeg = dir.join("ffmpeg.exe");
        fs::write(&sidecar, b"MZ").unwrap();
        fs::write(&ffmpeg, b"MZ").unwrap();
        let missing_ffprobe = dir.join("ffprobe.exe");

        let config = BackendLaunchConfig::packaged(
            sidecar.clone(),
            dir.clone(),
            Some(ffmpeg.clone()),
            Some(missing_ffprobe),
        )
        .expect("valid packaged config");

        assert_eq!(config.program, sidecar);
        assert_eq!(
            config.args,
            vec![OsString::from("--protocol"), OsString::from("1")]
        );
        assert!(
            config.data_root.is_none(),
            "packaged build keeps the historical data dir"
        );
        assert_eq!(
            env_value(&config, "TUCK_BUNDLED_FFMPEG"),
            Some(ffmpeg.into_os_string())
        );
        assert!(
            env_value(&config, "TUCK_BUNDLED_FFPROBE").is_none(),
            "a missing ffprobe is not advertised to the sidecar"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}

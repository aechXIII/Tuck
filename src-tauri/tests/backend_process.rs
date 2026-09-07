use serde_json::json;
use tuck_desktop::backend::{BackendLaunchConfig, BackendProcess, PendingRequests};
use tuck_desktop::commands::backend::BackendCommand;

#[test]
fn finite_commands_serialize_to_allowlisted_sidecar_requests() {
    assert_eq!(
        serde_json::to_value(BackendCommand::CancelItem {
            item_id: "item-4".into(),
        })
        .expect("Tauri command should serialize"),
        json!({
            "command": "cancel_item",
            "payload": {"item_id": "item-4"},
        }),
    );
    assert_eq!(
        BackendCommand::ProbeFile {
            path: "C:\\media\\clip.mp4".into(),
        }
        .to_sidecar_request("probe-7")
        .expect("probe command should serialize"),
        json!({
            "kind": "request",
            "protocol": 1,
            "id": "probe-7",
            "method": "probe_file",
            "params": {"path": "C:\\media\\clip.mp4"},
        }),
    );
    assert_eq!(
        BackendCommand::GetQueueState
            .to_sidecar_request("queue-8")
            .expect("queue command should serialize"),
        json!({
            "kind": "request",
            "protocol": 1,
            "id": "queue-8",
            "method": "get_queue_state",
            "params": {},
        }),
    );
    assert_eq!(
        BackendCommand::GetStoragePaths
            .to_sidecar_request("storage-9")
            .expect("storage command should serialize"),
        json!({
            "kind": "request",
            "protocol": 1,
            "id": "storage-9",
            "method": "get_storage_paths",
            "params": {},
        }),
    );
}

#[tokio::test]
async fn pending_requests_route_out_of_order_responses_once() {
    let pending = PendingRequests::new();
    let slow = pending.register("slow-1").await;
    let later = pending.register("later-2").await;

    assert!(
        pending
            .resolve("later-2", Ok(json!({"status": "later"})))
            .await
    );
    assert!(
        pending
            .resolve("slow-1", Ok(json!({"status": "slow"})))
            .await
    );
    assert!(
        !pending
            .resolve("slow-1", Ok(json!({"status": "duplicate"})))
            .await
    );

    assert_eq!(
        later
            .await
            .expect("later sender should resolve")
            .expect("later result"),
        json!({"status": "later"})
    );
    assert_eq!(
        slow.await
            .expect("slow sender should resolve")
            .expect("slow result"),
        json!({"status": "slow"})
    );
}

#[tokio::test]
async fn process_reports_malformed_output_and_does_not_leave_a_pending_request() {
    let process = BackendProcess::launch(fake_sidecar(
        "import json, sys\nprint(json.dumps({'kind':'event','protocol':1,'event':'backend_ready','payload':{'backend_version':'0.4.0','pid':1,'capabilities':{'protocol':1}}}), flush=True)\nprint('{not json}', flush=True)\nfor _ in sys.stdin: pass",
    ))
    .await
    .expect("sidecar should report readiness before malformed output");

    let error = process
        .request(BackendCommand::Health)
        .await
        .expect_err("malformed stdout must fail requests");

    assert_eq!(error.code, "MALFORMED_BACKEND_OUTPUT");
    assert_eq!(process.pending_count().await, 0);
    process
        .shutdown()
        .await
        .expect("shutdown should reap the child");
}

#[tokio::test]
async fn process_returns_stderr_diagnostics_after_early_exit() {
    let process = BackendProcess::launch(fake_sidecar(
        "import json, sys\nprint(json.dumps({'kind':'event','protocol':1,'event':'backend_ready','payload':{'backend_version':'0.4.0','pid':1,'capabilities':{'protocol':1}}}), flush=True)\nprint('sidecar startup diagnostic', file=sys.stderr, flush=True)",
    ))
    .await
    .expect("sidecar should report readiness before it exits");

    let error = process
        .request(BackendCommand::Health)
        .await
        .expect_err("an exited sidecar must not leave requests hanging");

    assert_eq!(error.code, "BACKEND_EXITED");
    assert!(error
        .details
        .get("stderr")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|stderr| stderr.contains("sidecar startup diagnostic")));
    process
        .shutdown()
        .await
        .expect("shutdown should tolerate an exited child");
}

#[tokio::test]
async fn request_timeout_removes_the_pending_entry() {
    let process = BackendProcess::launch(fake_sidecar(
        "import json, sys\nprint(json.dumps({'kind':'event','protocol':1,'event':'backend_ready','payload':{'backend_version':'0.4.0','pid':1,'capabilities':{'protocol':1}}}), flush=True)\nfor _ in sys.stdin: pass",
    ))
    .await
    .expect("sidecar should start");

    let error = process
        .request_with_timeout(BackendCommand::Health, std::time::Duration::from_millis(10))
        .await
        .expect_err("a silent sidecar must time out");

    assert_eq!(error.code, "BACKEND_TIMEOUT");
    assert_eq!(process.pending_count().await, 0);
    let shutdown_error = process
        .shutdown()
        .await
        .expect_err("a silent sidecar cannot acknowledge shutdown");
    assert_eq!(shutdown_error.code, "BACKEND_TIMEOUT");
    assert!(!process.is_running().await);
}

#[tokio::test]
async fn real_sidecar_completes_health_and_graceful_shutdown() {
    let process = BackendProcess::launch(development_sidecar())
        .await
        .expect("real sidecar starts");

    assert_eq!(
        process
            .request(BackendCommand::Health)
            .await
            .expect("health response"),
        json!({"status": "ok"}),
    );

    process.shutdown().await.expect("graceful shutdown");
    assert!(!process.is_running().await);
}

#[tokio::test]
async fn sidecar_receives_the_authoritative_desktop_platform() {
    let process = BackendProcess::launch(fake_sidecar(
        "import json, os, sys\nprint(json.dumps({'kind':'event','protocol':1,'event':'backend_ready','payload':{'backend_version':'0.4.0'}}), flush=True)\nfor line in sys.stdin:\n request = json.loads(line)\n print(json.dumps({'kind':'response','protocol':1,'id':request['id'],'ok':True,'result':{'platform': os.environ['TUCK_DESKTOP_PLATFORM']}}), flush=True)",
    ))
    .await
    .expect("sidecar should start");

    let expected = if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    assert_eq!(
        process
            .request(BackendCommand::Health)
            .await
            .expect("health response"),
        json!({ "platform": expected }),
    );
    process.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn real_sidecar_reports_its_authoritative_storage_paths() {
    let data_root = temporary_data_root("storage-paths");
    let process = BackendProcess::launch(
        BackendLaunchConfig::development(repository_root(), data_root.clone())
            .expect("repository virtual environment should be available"),
    )
    .await
    .expect("real sidecar starts");

    assert_eq!(
        process
            .request(BackendCommand::GetStoragePaths)
            .await
            .expect("storage path response"),
        json!({
            "config_dir": data_root.join("config").to_string_lossy(),
            "data_dir": data_root.join("data").to_string_lossy(),
            "cache_dir": data_root.join("cache").to_string_lossy(),
            "log_dir": data_root.join("data").join("logs").to_string_lossy(),
        }),
    );

    process.shutdown().await.expect("graceful shutdown");
    let _ = std::fs::remove_dir_all(data_root);
}

#[tokio::test]
async fn real_sidecar_runs_the_probe_plan_enqueue_queue_and_cancel_slice() {
    let media_path = temporary_data_root("vertical-media").join("short.mp4");
    std::fs::create_dir_all(
        media_path
            .parent()
            .expect("temporary media path has a parent"),
    )
    .expect("temporary media directory");
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=1:size=64x64:rate=30",
            "-frames:v",
            "1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&media_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("ffmpeg should create the short test video");
    assert!(status.success(), "ffmpeg fixture creation should succeed");

    let process = BackendProcess::launch(
        BackendLaunchConfig::development(
            repository_root(),
            temporary_data_root("vertical-sidecar"),
        )
        .expect("repository virtual environment should be available"),
    )
    .await
    .expect("real sidecar starts");
    let source = media_path.to_string_lossy().into_owned();

    let probe = process
        .request(BackendCommand::ProbeFile {
            path: source.clone(),
        })
        .await
        .expect("probe response");
    assert_eq!(
        probe
            .get("data")
            .and_then(serde_json::Value::as_object)
            .and_then(|data| data.get("width")),
        Some(&json!(64)),
    );

    let request = json!({ "source": source });
    let plan = process
        .request(BackendCommand::CreatePlan {
            request: request.clone(),
        })
        .await
        .expect("plan response");
    assert!(
        plan.get("data")
            .and_then(serde_json::Value::as_object)
            .is_some(),
        "create-plan response should include its preview data",
    );

    let enqueued = process
        .request(BackendCommand::EnqueueWithOptions { request })
        .await
        .expect("enqueue response");
    let item_id = enqueued
        .get("item_id")
        .and_then(serde_json::Value::as_str)
        .expect("queue item id")
        .to_owned();

    let queue = process
        .request(BackendCommand::GetQueueState)
        .await
        .expect("queue state response");
    assert!(queue
        .get("items")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| items
            .iter()
            .any(|item| item.get("id") == Some(&json!(item_id)))));

    let cancelled = process
        .request(BackendCommand::CancelItem { item_id })
        .await
        .expect("cancel response");
    assert_eq!(cancelled, json!({}));
    process.shutdown().await.expect("graceful shutdown");
}

fn development_sidecar() -> BackendLaunchConfig {
    BackendLaunchConfig::development(repository_root(), temporary_data_root("real-sidecar"))
        .expect("repository virtual environment should be available")
}

fn fake_sidecar(script: &str) -> BackendLaunchConfig {
    BackendLaunchConfig::command(
        development_python(),
        ["-u", "-c", script],
        repository_root(),
        temporary_data_root("fake-sidecar"),
    )
}

fn development_python() -> std::path::PathBuf {
    let venv = repository_root().join(".venv");
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

fn repository_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a repository parent")
        .to_path_buf()
}

fn temporary_data_root(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("tuck-desktop-{name}-{}", std::process::id()))
}

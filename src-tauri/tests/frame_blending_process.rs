use serde_json::json;
use std::path::PathBuf;
use tuck_desktop::backend::{BackendLaunchConfig, BackendProcess};
use tuck_desktop::commands::backend::BackendCommand;

#[tokio::test]
async fn frame_blending_survives_native_sidecar_planning_and_validation() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let python = std::env::var_os("TUCK_TEST_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.join(if cfg!(windows) {
                ".venv/Scripts/python.exe"
            } else {
                ".venv/bin/python"
            })
        });
    let data = std::env::temp_dir().join(format!("tuck-frame-blending-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let source = data.join("source.mkv");
    let fixture = std::process::Command::new(&python)
        .args(["-c", "import subprocess,sys; from tuck.media_tools import find_ffmpeg; subprocess.run([find_ffmpeg(),'-v','error','-y','-f','lavfi','-i','testsrc2=size=32x32:rate=60:duration=1','-c:v','ffv1',sys.argv[1]],check=True)"])
        .arg(&source).current_dir(&root).status().expect("start fixture generator");
    assert!(fixture.success());
    let process = BackendProcess::launch(BackendLaunchConfig::command(
        python,
        ["-m", "tuck.sidecar", "--protocol", "1"],
        root,
        data.clone(),
    ))
    .await
    .expect("sidecar starts");
    let settings = json!({"enabled":true,"amount":1.5,"curve":"vegas","power":2.0});
    let request = json!({"source":source.to_string_lossy(),"video_encoder":"libx264",
        "fps_mode":"custom","custom_fps":29.97,"frame_blending":settings});
    let result = process
        .request(BackendCommand::CreatePlan {
            request: request.clone(),
        })
        .await
        .expect("plan response");
    assert_eq!(result["data"]["frame_blending"]["enabled"], true);
    assert_eq!(result["data"]["frame_blending"]["amount"], 1.5);
    assert_eq!(result["data"]["target_fps"], 29.97);
    let mut invalid = request.clone();
    invalid["frame_blending"]["custom_weights"] = json!([0, 0]);
    let error = process
        .request(BackendCommand::CreatePlan { request: invalid })
        .await
        .expect_err("zero-total weights must fail in Python");
    assert!(error.message.contains("positive weight"));
    let queued = process
        .request(BackendCommand::EnqueueWithOptions { request })
        .await
        .expect("enqueue response");
    let id = queued["item_id"].as_str().expect("queue item id");
    let completed = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let state = process
                .request(BackendCommand::GetQueueState)
                .await
                .unwrap();
            let item = state["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == id)
                .expect("queued item retained");
            match item["state"].as_str().unwrap() {
                "completed" => break,
                "failed" => panic!("frame blending queue failed: {item}"),
                _ => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
            }
        }
    })
    .await;
    process.shutdown().await.expect("orderly shutdown");
    completed.expect("queue completes within its test deadline");
    assert!(std::fs::read_dir(&data).unwrap().any(|entry| {
        entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "mp4")
    }));
    std::fs::remove_dir_all(data).unwrap();
}

use serde_json::json;
use std::path::PathBuf;
use tuck_desktop::backend::{BackendLaunchConfig, BackendProcess};
use tuck_desktop::commands::backend::BackendCommand;

#[tokio::test]
async fn lut_import_survives_native_sidecar_planning_and_queue_execution() {
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
    let data = std::env::temp_dir().join(format!("tuck-lut-{}", std::process::id()));
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
    let cube = data.join("invert.cube");
    std::fs::write(
        &cube,
        "LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n",
    )
    .unwrap();
    let imported = process
        .request(BackendCommand::LoadLut {
            path: cube.to_string_lossy().into_owned(),
        })
        .await
        .expect("import LUT through sidecar");
    assert_eq!(imported["size"], 2);
    let library = process
        .request(BackendCommand::ListLuts)
        .await
        .expect("list saved LUTs");
    assert_eq!(library["luts"][0]["path"], imported["path"]);
    assert!(imported["table_url"]
        .as_str()
        .unwrap()
        .starts_with("http://127.0.0.1:"));
    let settings = json!({"enabled":true,"strength":0.5,"path":imported["path"],"name":"Invert"});
    let request = json!({"source":source.to_string_lossy(),"video_encoder":"libx264",
        "fps_mode":"custom","custom_fps":30,"lut":settings,
        "frame_blending":{"enabled":true}});
    let result = process
        .request(BackendCommand::CreatePlan {
            request: request.clone(),
        })
        .await
        .expect("LUT plan response");
    assert_eq!(result["data"]["lut"]["enabled"], true);
    assert_eq!(result["data"]["lut"]["strength"], 0.5);
    let cleared = process
        .request(BackendCommand::ClearLutHistory)
        .await
        .expect("clear LUT history through sidecar");
    assert_eq!(cleared["cleared"], true);
    let empty = process.request(BackendCommand::ListLuts).await.unwrap();
    assert_eq!(empty["luts"], json!([]));
    assert!(std::path::Path::new(imported["path"].as_str().unwrap()).is_file());
    std::fs::remove_file(cube).unwrap();
    let mut invalid = request.clone();
    invalid["lut"]["strength"] = json!(2);
    let error = process
        .request(BackendCommand::CreatePlan { request: invalid })
        .await
        .expect_err("invalid LUT strength fails in Python");
    assert!(error.message.contains("strength"));
    assert_eq!(error.details["field"], "lut");
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

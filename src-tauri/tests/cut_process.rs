use serde_json::json;
use std::path::PathBuf;
use tuck_desktop::backend::{BackendLaunchConfig, BackendProcess};
use tuck_desktop::commands::backend::BackendCommand;

#[test]
fn cut_commands_are_allowlisted_and_keep_work_ids() {
    let command: BackendCommand = serde_json::from_value(json!({
        "command": "analyze_cut", "payload": {"path": "source.mp4", "work_id": "scan-1"}
    }))
    .expect("cut command exists");
    let request = command.to_sidecar_request("request-1").unwrap();
    assert_eq!(request["method"], "analyze_cut");
    assert_eq!(request["params"]["work_id"], "scan-1");
    assert!(serde_json::from_value::<BackendCommand>(json!({
        "command": "analyze_cut", "payload": {"path": "source.mp4", "work_id": 3}
    }))
    .is_err());
}

#[tokio::test]
async fn cut_analysis_and_planning_cross_the_real_sidecar() {
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
    let data = std::env::temp_dir().join(format!("tuck-cut-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let source = data.join("cut ' źródło.mp4");
    let fixture = std::process::Command::new(&python).args(["-c", "import subprocess,sys; from tuck.media_tools import find_ffmpeg; subprocess.run([find_ffmpeg(),'-v','error','-y','-f','lavfi','-i','testsrc2=size=160x96:rate=30:duration=4','-c:v','libx264','-g','60','-bf','3','-x264-params','open-gop=0:b-adapt=0',sys.argv[1]],check=True)"]).arg(&source).current_dir(&root).status().unwrap();
    assert!(fixture.success());
    let process = BackendProcess::launch(BackendLaunchConfig::command(
        python,
        ["-m", "tuck.sidecar", "--protocol", "1"],
        root,
        data.clone(),
    ))
    .await
    .unwrap();
    let start: BackendCommand = serde_json::from_value(
        json!({"command":"analyze_cut","payload":{"path":source,"work_id":"one"}}),
    )
    .unwrap();
    let response = process.request(start).await.unwrap();
    assert_eq!(response["status"], "pending");
    process
        .request(BackendCommand::Health)
        .await
        .expect("control requests remain available");
    let ready = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let status = process
                .request(
                    serde_json::from_value(
                        json!({"command":"get_cut_analysis","payload":{"path":source}}),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
            if status["status"] == "ready" || status["status"] == "failed" {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let tick = "9007199254741009";
    let plan = process.request(BackendCommand::CreatePlan {request:json!({"operation":"cut","source":source,"_request_id":17,"segments":[{"start":{"ticks":"0","time_base_num":1,"time_base_den":90000},"end":{"ticks":tick,"time_base_num":1,"time_base_den":90000}}]})}).await;
    let invalid = process
        .request(BackendCommand::CreatePlan {
            request: json!({"operation":"cut","source":source,"segments":[],"_request_id":18}),
        })
        .await;
    let cancellation = process
        .request(
            serde_json::from_value(
                json!({"command":"cancel_cut_work","payload":{"work_id":"missing"}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    process.shutdown().await.unwrap();
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["analysis"]["issues"], json!([]));
    let plan = plan.unwrap();
    assert_eq!(plan["data"]["operation"], "cut");
    assert_eq!(
        plan["data"]["segments"][0]["requested"]["end"]["ticks"],
        tick
    );
    assert_eq!(plan["_request_id"], 17);
    assert_eq!(plan["data"]["issues"][0]["code"], "invalid_range");
    let error = invalid.unwrap_err();
    assert_eq!(error.code, "INVALID_CUT_REQUEST");
    assert_eq!(error.details["_request_id"], 18);
    assert_eq!(error.details["field"], "cut");
    assert_eq!(cancellation["cancelled"], false);
    std::fs::remove_dir_all(data).unwrap();
}

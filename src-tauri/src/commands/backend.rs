use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::backend::{BackendState, PublicBackendError};

/// The generic Send To shortcuts Tuck can manage. Serde rejects any other
/// value before a request reaches the sidecar.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SendToKind {
    Open,
    Compress,
    Upscale,
    Cut,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "command", content = "payload", rename_all = "snake_case")]
pub enum BackendCommand {
    Health,
    ListLuts,
    ClearLutHistory,
    LoadLut {
        path: String,
    },
    ProbeFile {
        path: String,
    },
    ProbeAudioFile {
        path: String,
    },
    GetWaveform {
        path: String,
    },
    GetThumbnail {
        path: String,
    },
    GetMediaUrl {
        path: String,
    },
    ReleaseMediaToken {
        token: String,
    },
    AnalyzeCut {
        path: String,
        work_id: String,
    },
    GetCutAnalysis {
        path: String,
        // a long keyframe list arrives in pages; the sidecar validates the pair
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframes_revision: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframes_from: Option<u64>,
    },
    CancelCutWork {
        work_id: String,
    },
    CreatePlan {
        request: Value,
    },
    EnqueueWithOptions {
        request: Value,
    },
    EnqueueBatch {
        requests: Value,
    },
    GetQueueState,
    CancelItem {
        item_id: String,
    },
    RemoveItem {
        item_id: String,
    },
    CancelAllItems,
    ClearCompleted,
    MoveItem {
        item_id: String,
        new_index: i64,
    },
    RetryItem {
        item_id: String,
    },
    StopAfterCurrent,
    GetDiagnostics {
        context: Option<Value>,
    },
    GetStoragePaths,
    GetSettings,
    SaveSettings {
        settings: Value,
    },
    RefreshEncoders,
    ExportSettingsToFile {
        path: String,
    },
    ImportSettingsFromFile {
        path: String,
    },
    ResetSettings,
    GetProfilesJson,
    CreateProfile {
        profile: Value,
    },
    UpdateProfile {
        profile_id: String,
        profile: Value,
    },
    DeleteProfile {
        profile_id: String,
    },
    DuplicateProfile {
        profile_id: String,
    },
    ImportProfilesFromFile {
        path: String,
    },
    ExportProfileToFile {
        path: String,
        profile_id: String,
    },
    // the shortcut target is always resolved natively, never named by the webview
    InstallGenericSendto {
        kind: SendToKind,
    },
    RemoveGenericSendto {
        kind: SendToKind,
    },
    RepairGenericSendto {
        kind: SendToKind,
    },
    InstallProfileSendto {
        profile_id: String,
        action: Option<String>,
    },
    RemoveProfileSendto {
        profile_id: String,
    },
    RepairProfileSendto {
        profile_id: String,
        action: Option<String>,
    },
    ListSendtoShortcuts,
}

impl BackendCommand {
    fn is_send_to_command(&self) -> bool {
        matches!(
            self,
            Self::InstallGenericSendto { .. }
                | Self::RemoveGenericSendto { .. }
                | Self::RepairGenericSendto { .. }
                | Self::InstallProfileSendto { .. }
                | Self::RemoveProfileSendto { .. }
                | Self::RepairProfileSendto { .. }
                | Self::ListSendtoShortcuts
        )
    }

    pub fn to_sidecar_request(&self, request_id: &str) -> Result<Value, PublicBackendError> {
        let (method, params) = match self {
            Self::ListLuts => ("list_luts", json!({})),
            Self::ClearLutHistory => ("clear_lut_history", json!({})),
            Self::LoadLut { path } => ("load_lut", json!({ "path": path })),
            Self::Health => ("health", json!({})),
            Self::ProbeFile { path } => ("probe_file", json!({ "path": path })),
            Self::ProbeAudioFile { path } => ("probe_audio_file", json!({ "path": path })),
            Self::GetWaveform { path } => ("get_waveform", json!({ "path": path })),
            Self::GetThumbnail { path } => ("get_thumbnail", json!({ "path": path })),
            Self::GetMediaUrl { path } => ("get_media_url", json!({ "path": path })),
            Self::ReleaseMediaToken { token } => ("release_media_token", json!({ "token": token })),
            Self::AnalyzeCut { path, work_id } => {
                ("analyze_cut", json!({ "path": path, "work_id": work_id }))
            }
            Self::GetCutAnalysis {
                path,
                keyframes_revision,
                keyframes_from,
            } => {
                let mut payload = json!({ "path": path });
                if let Some(revision) = keyframes_revision {
                    payload["keyframes_revision"] = json!(revision);
                }
                if let Some(from) = keyframes_from {
                    payload["keyframes_from"] = json!(from);
                }
                ("get_cut_analysis", payload)
            }
            Self::CancelCutWork { work_id } => ("cancel_cut_work", json!({ "work_id": work_id })),
            Self::CreatePlan { request } => ("create_plan", json!({ "request": request })),
            Self::EnqueueWithOptions { request } => {
                ("enqueue_with_options", json!({ "request": request }))
            }
            Self::EnqueueBatch { requests } => ("enqueue_batch", json!({ "requests": requests })),
            Self::GetQueueState => ("get_queue_state", json!({})),
            Self::CancelItem { item_id } => ("cancel_item", json!({ "item_id": item_id })),
            Self::RemoveItem { item_id } => ("remove_item", json!({ "item_id": item_id })),
            Self::CancelAllItems => ("cancel_all_items", json!({})),
            Self::ClearCompleted => ("clear_completed", json!({})),
            Self::MoveItem { item_id, new_index } => (
                "move_item",
                json!({ "item_id": item_id, "new_index": new_index }),
            ),
            Self::RetryItem { item_id } => ("retry_item", json!({ "item_id": item_id })),
            Self::StopAfterCurrent => ("stop_after_current", json!({})),
            Self::GetDiagnostics { context } => {
                if let Some(ctx) = context {
                    ("get_diagnostics", json!({ "context": ctx }))
                } else {
                    ("get_diagnostics", json!({}))
                }
            }
            Self::GetStoragePaths => ("get_storage_paths", json!({})),
            Self::GetSettings => ("get_settings", json!({})),
            Self::SaveSettings { settings } => ("save_settings", json!({ "settings": settings })),
            Self::RefreshEncoders => ("refresh_encoders", json!({})),
            Self::ExportSettingsToFile { path } => {
                ("export_settings_to_file", json!({ "path": path }))
            }
            Self::ImportSettingsFromFile { path } => {
                ("import_settings_from_file", json!({ "path": path }))
            }
            Self::ResetSettings => ("reset_settings", json!({})),
            Self::GetProfilesJson => ("get_profiles_json", json!({})),
            Self::CreateProfile { profile } => ("create_profile", json!({ "profile": profile })),
            Self::UpdateProfile {
                profile_id,
                profile,
            } => (
                "update_profile",
                json!({ "profile_id": profile_id, "profile": profile }),
            ),
            Self::DeleteProfile { profile_id } => {
                ("delete_profile", json!({ "profile_id": profile_id }))
            }
            Self::DuplicateProfile { profile_id } => {
                ("duplicate_profile", json!({ "profile_id": profile_id }))
            }
            Self::ImportProfilesFromFile { path } => {
                ("import_profiles_from_file", json!({ "path": path }))
            }
            Self::ExportProfileToFile { path, profile_id } => (
                "export_profile_to_file",
                json!({ "path": path, "profile_id": profile_id }),
            ),
            Self::InstallGenericSendto { kind } => {
                ("install_generic_sendto", json!({ "kind": kind }))
            }
            Self::RemoveGenericSendto { kind } => {
                ("remove_generic_sendto", json!({ "kind": kind }))
            }
            Self::RepairGenericSendto { kind } => {
                ("repair_generic_sendto", json!({ "kind": kind }))
            }
            Self::InstallProfileSendto { profile_id, action } => (
                "install_profile_sendto",
                profile_sendto_params(profile_id, action.as_deref()),
            ),
            Self::RemoveProfileSendto { profile_id } => {
                ("remove_profile_sendto", json!({ "profile_id": profile_id }))
            }
            Self::RepairProfileSendto { profile_id, action } => (
                "repair_profile_sendto",
                profile_sendto_params(profile_id, action.as_deref()),
            ),
            Self::ListSendtoShortcuts => ("list_sendto_shortcuts", json!({})),
        };
        crate::backend::protocol::request_frame(request_id, method, params)
    }
}

fn profile_sendto_params(profile_id: &str, action: Option<&str>) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("profile_id".into(), json!(profile_id));
    if let Some(action) = action {
        params.insert("action".into(), json!(action));
    }
    Value::Object(params)
}

#[tauri::command]
pub async fn backend_request(
    state: tauri::State<'_, BackendState>,
    command: BackendCommand,
) -> Result<Value, PublicBackendError> {
    reject_unsupported_backend_command(
        &command,
        &crate::platform::current_capabilities().platform,
    )?;
    state.request(command).await
}

fn reject_unsupported_backend_command(
    command: &BackendCommand,
    platform: &str,
) -> Result<(), PublicBackendError> {
    if platform == "linux" && command.is_send_to_command() {
        return Err(PublicBackendError::new(
            "UNSUPPORTED_OPERATION",
            "Send To integration is not supported on Linux.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_rejects_every_send_to_command_before_sidecar_ipc() {
        let commands = [
            BackendCommand::InstallGenericSendto {
                kind: SendToKind::Open,
            },
            BackendCommand::RemoveGenericSendto {
                kind: SendToKind::Compress,
            },
            BackendCommand::RepairGenericSendto {
                kind: SendToKind::Cut,
            },
            BackendCommand::InstallProfileSendto {
                profile_id: "profile-1".into(),
                action: None,
            },
            BackendCommand::RemoveProfileSendto {
                profile_id: "profile-1".into(),
            },
            BackendCommand::RepairProfileSendto {
                profile_id: "profile-1".into(),
                action: None,
            },
            BackendCommand::ListSendtoShortcuts,
        ];

        for command in commands {
            assert_eq!(
                reject_unsupported_backend_command(&command, "linux")
                    .expect_err("Linux must reject Send To IPC")
                    .code,
                "UNSUPPORTED_OPERATION"
            );
        }
    }

    #[test]
    fn windows_keeps_send_to_commands_available() {
        assert!(reject_unsupported_backend_command(
            &BackendCommand::RemoveGenericSendto {
                kind: SendToKind::Open
            },
            "windows"
        )
        .is_ok());
    }

    #[test]
    fn generic_send_to_commands_carry_an_allowlisted_kind() {
        for (command, method) in [
            ("install_generic_sendto", "install_generic_sendto"),
            ("remove_generic_sendto", "remove_generic_sendto"),
            ("repair_generic_sendto", "repair_generic_sendto"),
        ] {
            for kind in ["open", "compress", "upscale", "cut"] {
                let parsed: BackendCommand =
                    serde_json::from_value(json!({"command": command, "payload": {"kind": kind}}))
                        .expect("allowlisted kind");
                let request = parsed.to_sidecar_request("kind").unwrap();
                assert_eq!(request["method"], method);
                assert_eq!(request["params"], json!({ "kind": kind }));
            }
        }
    }

    #[test]
    fn generic_send_to_commands_reject_other_kinds() {
        for payload in [
            json!({}),
            json!({"kind": "trim"}),
            json!({"kind": "Open"}),
            json!({"kind": 1}),
            json!({"kind": null}),
        ] {
            for command in [
                "install_generic_sendto",
                "remove_generic_sendto",
                "repair_generic_sendto",
            ] {
                assert!(
                    serde_json::from_value::<BackendCommand>(
                        json!({"command": command, "payload": payload.clone()})
                    )
                    .is_err(),
                    "{command} accepted {payload}"
                );
            }
        }
    }

    #[test]
    fn cut_analysis_forwards_the_keyframe_cursor_only_when_given() {
        let paged = serde_json::from_value::<BackendCommand>(json!({
            "command": "get_cut_analysis",
            "payload": {"path": "/media/a.mp4", "keyframes_revision": 3, "keyframes_from": 4096},
        }))
        .unwrap()
        .to_sidecar_request("r1")
        .unwrap();
        assert_eq!(
            paged["params"],
            json!({"path": "/media/a.mp4", "keyframes_revision": 3, "keyframes_from": 4096})
        );

        let plain = serde_json::from_value::<BackendCommand>(json!({
            "command": "get_cut_analysis",
            "payload": {"path": "/media/a.mp4"},
        }))
        .unwrap()
        .to_sidecar_request("r2")
        .unwrap();
        assert_eq!(plain["params"], json!({"path": "/media/a.mp4"}));
    }

    #[test]
    fn send_to_commands_never_carry_a_webview_supplied_executable() {
        for (command, payload) in [
            (
                "install_generic_sendto",
                json!({"kind": "upscale", "executable_path": "C:\\Tuck\\Tuck.exe"}),
            ),
            (
                "repair_generic_sendto",
                json!({"kind": "upscale", "executable_path": "C:\\Tuck\\Tuck.exe"}),
            ),
            (
                "install_profile_sendto",
                json!({"profile_id": "p", "executable_path": "C:\\evil.exe"}),
            ),
            (
                "repair_profile_sendto",
                json!({"profile_id": "p", "action": "start", "executable_path": "C:\\evil.exe"}),
            ),
        ] {
            let request = serde_json::from_value::<BackendCommand>(
                json!({"command": command, "payload": payload}),
            )
            .expect("unknown payload fields are dropped, not forwarded")
            .to_sidecar_request("path")
            .unwrap();
            assert!(
                request["params"].get("executable_path").is_none(),
                "{command} forwarded an executable path"
            );
        }
        let request = BackendCommand::InstallProfileSendto {
            profile_id: "p".into(),
            action: Some("review".into()),
        }
        .to_sidecar_request("profile")
        .unwrap();
        assert_eq!(
            request["params"],
            json!({"profile_id": "p", "action": "review"})
        );
    }

    #[test]
    fn the_webview_cannot_request_a_backend_shutdown() {
        assert!(serde_json::from_value::<BackendCommand>(json!({"command": "shutdown"})).is_err());
    }

    #[test]
    fn settings_backup_commands_reach_the_sidecar_with_only_a_path() {
        for (command, method) in [
            ("export_settings_to_file", "export_settings_to_file"),
            ("import_settings_from_file", "import_settings_from_file"),
        ] {
            let parsed: BackendCommand = serde_json::from_value(
                json!({"command": command, "payload": {"path": "backup.json"}}),
            )
            .expect("allowlisted backup command");
            let request = parsed.to_sidecar_request("backup").unwrap();
            assert_eq!(request["method"], method);
            assert_eq!(request["params"], json!({ "path": "backup.json" }));
        }
        let reset: BackendCommand =
            serde_json::from_value(json!({"command": "reset_settings"})).expect("reset");
        let request = reset.to_sidecar_request("reset").unwrap();
        assert_eq!(request["method"], "reset_settings");
        assert_eq!(request["params"], json!({}));
    }

    #[test]
    fn lut_import_is_allowlisted_and_preserves_the_path() {
        let command: BackendCommand =
            serde_json::from_value(json!({"command":"load_lut","payload":{"path":"look.cube"}}))
                .unwrap();
        let request = command.to_sidecar_request("lut-test").unwrap();
        assert_eq!(request["method"], "load_lut");
        assert_eq!(request["params"]["path"], "look.cube");
    }

    #[test]
    fn frame_blending_settings_reach_the_sidecar_unchanged() {
        let request = json!({
            "source": "clip.mp4",
            "custom_fps": 29.97,
            "frame_blending": {
                "enabled": true,
                "amount": 1.5,
                "curve": "gaussian",
                "sigma": 0.25,
                "custom_weights": [1.0, 2.0, 1.0],
                "linear_light": true
            }
        });
        for command in [
            BackendCommand::CreatePlan {
                request: request.clone(),
            },
            BackendCommand::EnqueueWithOptions {
                request: request.clone(),
            },
        ] {
            let envelope = command
                .to_sidecar_request("blend-1")
                .expect("valid request");
            assert_eq!(envelope["params"]["request"], request);
        }
    }
}

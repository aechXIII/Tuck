use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::backend::{BackendState, PublicBackendError};

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "command", content = "payload", rename_all = "snake_case")]
pub enum BackendCommand {
    Health,
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
    InstallGenericSendto {
        executable_path: Option<String>,
    },
    RemoveGenericSendto,
    InstallProfileSendto {
        profile_id: String,
        action: Option<String>,
        executable_path: Option<String>,
    },
    RemoveProfileSendto {
        profile_id: String,
    },
    RepairProfileSendto {
        profile_id: String,
        action: Option<String>,
        executable_path: Option<String>,
    },
    ListSendtoShortcuts,
    Shutdown,
}

impl BackendCommand {
    pub fn to_sidecar_request(&self, request_id: &str) -> Result<Value, PublicBackendError> {
        let (method, params) = match self {
            Self::Health => ("health", json!({})),
            Self::ProbeFile { path } => ("probe_file", json!({ "path": path })),
            Self::ProbeAudioFile { path } => ("probe_audio_file", json!({ "path": path })),
            Self::GetWaveform { path } => ("get_waveform", json!({ "path": path })),
            Self::GetThumbnail { path } => ("get_thumbnail", json!({ "path": path })),
            Self::GetMediaUrl { path } => ("get_media_url", json!({ "path": path })),
            Self::ReleaseMediaToken { token } => ("release_media_token", json!({ "token": token })),
            Self::CreatePlan { request } => ("create_plan", json!({ "request": request })),
            Self::EnqueueWithOptions { request } => {
                ("enqueue_with_options", json!({ "request": request }))
            }
            Self::EnqueueBatch { requests } => ("enqueue_batch", json!({ "requests": requests })),
            Self::GetQueueState => ("get_queue_state", json!({})),
            Self::CancelItem { item_id } => ("cancel_item", json!({ "item_id": item_id })),
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
            Self::InstallGenericSendto { executable_path } => {
                let mut params = serde_json::Map::new();
                if let Some(p) = executable_path {
                    params.insert("executable_path".into(), json!(p));
                }
                ("install_generic_sendto", Value::Object(params))
            }
            Self::RemoveGenericSendto => ("remove_generic_sendto", json!({})),
            Self::InstallProfileSendto {
                profile_id,
                action,
                executable_path,
            } => {
                let mut params = serde_json::Map::new();
                params.insert("profile_id".into(), json!(profile_id));
                if let Some(a) = action {
                    params.insert("action".into(), json!(a));
                }
                if let Some(p) = executable_path {
                    params.insert("executable_path".into(), json!(p));
                }
                ("install_profile_sendto", Value::Object(params))
            }
            Self::RemoveProfileSendto { profile_id } => {
                ("remove_profile_sendto", json!({ "profile_id": profile_id }))
            }
            Self::RepairProfileSendto {
                profile_id,
                action,
                executable_path,
            } => {
                let mut params = serde_json::Map::new();
                params.insert("profile_id".into(), json!(profile_id));
                if let Some(a) = action {
                    params.insert("action".into(), json!(a));
                }
                if let Some(p) = executable_path {
                    params.insert("executable_path".into(), json!(p));
                }
                ("repair_profile_sendto", Value::Object(params))
            }
            Self::ListSendtoShortcuts => ("list_sendto_shortcuts", json!({})),
            Self::Shutdown => ("shutdown", json!({})),
        };
        crate::backend::protocol::request_frame(request_id, method, params)
    }
}

#[tauri::command]
pub async fn backend_request(
    state: tauri::State<'_, BackendState>,
    command: BackendCommand,
) -> Result<Value, PublicBackendError> {
    if matches!(command, BackendCommand::Shutdown) {
        state.shutdown().await?;
        Ok(json!({ "status": "stopped" }))
    } else {
        state.request(command).await
    }
}

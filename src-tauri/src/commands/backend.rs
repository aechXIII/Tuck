use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::backend::{BackendState, PublicBackendError};

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "command", content = "payload", rename_all = "snake_case")]
pub enum BackendCommand {
    Health,
    ProbeFile { path: String },
    CreatePlan { request: Value },
    EnqueueWithOptions { request: Value },
    GetQueueState,
    CancelItem { item_id: String },
    Shutdown,
}

impl BackendCommand {
    pub fn to_sidecar_request(&self, request_id: &str) -> Result<Value, PublicBackendError> {
        let (method, params) = match self {
            Self::Health => ("health", json!({})),
            Self::ProbeFile { path } => ("probe_file", json!({ "path": path })),
            Self::CreatePlan { request } => ("create_plan", json!({ "request": request })),
            Self::EnqueueWithOptions { request } => {
                ("enqueue_with_options", json!({ "request": request }))
            }
            Self::GetQueueState => ("get_queue_state", json!({})),
            Self::CancelItem { item_id } => ("cancel_item", json!({ "item_id": item_id })),
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

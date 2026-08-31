use std::collections::HashMap;

use serde_json::Value;
use tokio::sync::{oneshot, Mutex};

use super::PublicBackendError;

type PendingResult = Result<Value, PublicBackendError>;

/// Routes one protocol response to the request that owns its correlation id.
#[derive(Default)]
pub struct PendingRequests {
    entries: Mutex<HashMap<String, oneshot::Sender<PendingResult>>>,
}

impl PendingRequests {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(
        &self,
        request_id: impl Into<String>,
    ) -> oneshot::Receiver<PendingResult> {
        let request_id = request_id.into();
        let (sender, receiver) = oneshot::channel();
        let previous = self.entries.lock().await.insert(request_id, sender);
        debug_assert!(previous.is_none(), "request ids must be unique");
        receiver
    }

    pub async fn resolve(&self, request_id: &str, result: PendingResult) -> bool {
        let sender = self.entries.lock().await.remove(request_id);
        match sender {
            Some(sender) => sender.send(result).is_ok(),
            None => false,
        }
    }

    pub async fn remove(&self, request_id: &str) -> bool {
        self.entries.lock().await.remove(request_id).is_some()
    }

    pub async fn fail_all(&self, error: PublicBackendError) {
        let pending = std::mem::take(&mut *self.entries.lock().await);
        for sender in pending.into_values() {
            let _ = sender.send(Err(error.clone()));
        }
    }

    pub async fn count(&self) -> usize {
        self.entries.lock().await.len()
    }
}

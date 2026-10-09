//! Supervision and protocol handling for the Python backend process.

mod pending;
mod process;
pub(crate) mod protocol;

pub use pending::PendingRequests;
pub use process::{BackendLaunchConfig, BackendProcess, BackendStarter, BackendState};
pub use protocol::PublicBackendError;

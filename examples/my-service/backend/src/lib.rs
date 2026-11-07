//! The backend: a Plexus service named `my-service` with one
//! activation. `register` is the whole wiring — add an activation by
//! registering it there.

pub mod greeter;
pub mod login;
pub mod serve;

use plexus_core::plexus::{DynamicHub as DynamicService, RemoteChild};
use std::sync::Arc;

/// The service's name: what `synapse` and the generated client call the backend.
pub const SERVICE: &str = "my-service";

/// The app's activations, registered on `service` — a bare service (`build_service`)
/// or one that login has put its `auth` on (layer login's `login.rs`).
pub fn register(service: DynamicService) -> DynamicService {
    service.register(greeter::Greeter::default())
}

pub fn build_service() -> Arc<DynamicService> {
    build_service_with(Vec::new())
}

/// The service with each `--child` mounted beside its own activations
/// (plexus-core's `RemoteChild`, spec/12): a process on stdio or a peer on
/// a WebSocket, under its mount name — a dendrite (VISION-4) is one.
pub fn build_service_with(children: Vec<RemoteChild>) -> Arc<DynamicService> {
    let mut service = register(DynamicService::new(SERVICE));
    for child in children {
        service = service.register(child);
    }
    Arc::new(service)
}

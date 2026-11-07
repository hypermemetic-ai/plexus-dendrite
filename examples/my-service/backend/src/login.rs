//! The login seam — here, no login: the service as [`crate::build_service`] makes
//! it, nothing added to the shell or to the WebSocket, no flags.
//!
//! main.rs calls exactly these five things whether or not the app has
//! login; layer login replaces this file with sign-in through
//! plexus-login (`--auth-provider`, the gate, roles, `/login`), so main.rs
//! is the same file in every app.

use crate::serve::Socket;
use plexus_core::plexus::{DynamicHub as DynamicService, RemoteChild};
use plexus_shell::ShellConfig;
use std::sync::Arc;

/// The login's flags: none.
#[derive(clap::Args, Debug, Clone, Default)]
pub struct LoginArgs {}

/// No login.
pub struct Login;

impl Login {
    /// Nothing to wire: a service on `ws_port`, its shell (if any) on
    /// `shell_port`, reached at `public_url` (`--public-url`; `None`: the
    /// shell's loopback address), admitting `allowed_origins` besides the
    /// shell's.
    pub fn wire(
        _args: &LoginArgs,
        _ws_port: u16,
        _shell_port: Option<u16>,
        _public_url: Option<&str>,
        _allowed_origins: &[String],
    ) -> anyhow::Result<Self> {
        Ok(Login)
    }

    /// The service, as `build_service_with` makes it: its activations and
    /// the children `--child` mounted.
    pub fn service(&self, children: Vec<RemoteChild>) -> Arc<DynamicService> {
        crate::build_service_with(children)
    }

    /// The shell, as it is.
    pub fn shell(&self, _shell: &mut ShellConfig) {}

    /// The shell's router, as it is.
    pub fn guard<R>(&self, router: R) -> R {
        router
    }

    /// The WebSocket's upgrade, as it is.
    pub fn socket(&self, _socket: &mut Socket) {}
}

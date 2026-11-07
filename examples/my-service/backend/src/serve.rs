//! The service's WebSocket, served on an address of the app's choosing.
//!
//! plexus-transport 0.5's `TransportServer` binds its WebSocket to
//! `127.0.0.1` only (`with_websocket(port)`), which a container behind a
//! reverse proxy cannot be reached on. So the app serves the socket through
//! the transport's own lower-level entry, `websocket::serve_websocket_with`,
//! which takes the address — the same upgrade (origins, quotas, the login's
//! validator and anonymous view) and the same accept loop — and does the
//! two things `TransportServer::serve` adds itself: the registry's
//! announcement (Z2H-6: off with `PLEXUS_NO_REGISTRY=1`) and a stop on
//! SIGTERM or ctrl-c.

use plexus_core::plexus::{Activation, DynamicHub as DynamicService, SessionValidator};
use plexus_transport::registry::{self, RegistryRegistration};
use plexus_transport::websocket::serve_websocket_with;
use plexus_transport::{ConnectionQuotas, UpgradeOptions, WebSocketConfig};
use std::net::SocketAddr;
use std::sync::Arc;

/// What the WebSocket's upgrade admits, and where it listens. The login
/// seam (`login.rs`'s `Login::socket`) adds its validator and options.
pub struct Socket {
    /// Where to listen: `--bind` and `--port`.
    pub addr: SocketAddr,
    /// The origins whose pages may open it (none: no origin is checked).
    pub origins: Vec<String>,
    /// Who the upgrade's credential names (login on).
    pub validator: Option<Arc<dyn SessionValidator>>,
    /// The anonymous view, the credential cookies, RFC 9728's metadata.
    pub upgrade: UpgradeOptions,
    /// Every peer is one reverse proxy (`--behind-proxy`): the per-IP
    /// connection quotas would count every visitor as one, so they are
    /// lifted to the totals (plexus-transport counts by the accepted peer's
    /// address and reads no forwarded header).
    pub behind_proxy: bool,
}

impl Socket {
    pub fn new(addr: SocketAddr) -> Self {
        Socket { addr, origins: Vec::new(), validator: None, upgrade: UpgradeOptions::default(), behind_proxy: false }
    }

    fn quotas(&self) -> ConnectionQuotas {
        let q = ConnectionQuotas::default();
        if self.behind_proxy {
            ConnectionQuotas { max_per_ip: q.max_connections, max_anonymous_per_ip: q.max_anonymous, ..q }
        } else {
            q
        }
    }
}

/// The WebSocket, serving: where it is bound, and how to stop it.
pub struct Serving {
    /// The bound address (port 0 was a free one).
    pub addr: SocketAddr,
    stop: tokio::sync::watch::Sender<bool>,
    done: tokio::task::JoinHandle<()>,
}

impl Serving {
    /// Stops it, and waits until it has.
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = self.done.await;
    }

    /// Waits until it stops by itself.
    pub async fn stopped(&mut self) {
        let _ = (&mut self.done).await;
    }
}

/// Starts the WebSocket.
pub async fn start(service: Arc<DynamicService>, socket: Socket) -> anyhow::Result<Serving> {
    let module = DynamicService::arc_into_rpc_module(service).map_err(|e| anyhow::anyhow!("rpc module: {e}"))?;
    let mut config = WebSocketConfig::new(socket.addr.port());
    config.addr = socket.addr;
    config.allowed_origins = socket.origins.clone();
    config.quotas = socket.quotas();
    let (handle, addr) = serve_websocket_with(module, config, socket.validator.clone(), socket.upgrade.clone())
        .await
        .map_err(|e| anyhow::anyhow!("cannot serve the WebSocket on {}: {e}", socket.addr))?;
    let (stop, mut stop_rx) = tokio::sync::watch::channel(false);
    let done = tokio::spawn(async move {
        tokio::select! {
            _ = handle.clone().stopped() => {}
            Ok(()) = stop_rx.changed() => {
                let _ = handle.stop();
                handle.stopped().await;
            }
        }
    });
    Ok(Serving { addr, stop, done })
}

/// Serves the WebSocket until it stops or the process is told to (SIGTERM,
/// ctrl-c), announced to the registry meanwhile unless `PLEXUS_NO_REGISTRY`.
pub async fn run(service: Arc<DynamicService>, socket: Socket) -> anyhow::Result<()> {
    let schema = Activation::plugin_schema(service.as_ref());
    let mut serving = start(service, socket).await?;
    let reg = (!registry::registry_disabled_by_env()).then(|| RegistryRegistration {
        url: registry::registry_url_from_env(),
        name: schema.namespace.clone(),
        host: "127.0.0.1".into(),
        port: serving.addr.port(),
        version: schema.version.clone(),
        schema_hash: schema.hash.clone(),
    });
    let registered = reg.clone().map(|reg| tokio::spawn(async move { registry::register_with_retry(&reg).await }));
    tokio::select! {
        _ = serving.stopped() => tracing::info!("the WebSocket stopped"),
        _ = shutdown_signal() => {
            tracing::info!("shutdown signal — stopping");
            serving.stop().await;
        }
    }
    if let (Some(reg), Some(registered)) = (reg, registered) {
        if registered.await.unwrap_or(false) {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), registry::deregister(&reg)).await;
        }
    }
    Ok(())
}

/// ctrl-c, or SIGTERM on unix (what `docker stop` and systemd send).
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// The page's socket URL for a shell reached at `public_url`: its origin's
/// `/ws` (https → wss, http → ws), where the reverse proxy in front routes
/// the WebSocket. `None` for no public URL (the page then dials this host
/// at the stamped port) or one that is not http(s).
pub fn public_ws_url(public_url: &str) -> Option<String> {
    let origin = origin_of(public_url)?;
    let rest = origin.strip_prefix("https://").map(|h| format!("wss://{h}")).or_else(|| origin.strip_prefix("http://").map(|h| format!("ws://{h}")))?;
    Some(format!("{rest}/ws"))
}

/// `scheme://host[:port]` of an http(s) URL, lowercased, no path.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_socket_is_the_origins_ws_path() {
        assert_eq!(public_ws_url("https://app.example").as_deref(), Some("wss://app.example/ws"));
        assert_eq!(public_ws_url("https://App.Example/some/path").as_deref(), Some("wss://app.example/ws"));
        assert_eq!(public_ws_url("http://127.0.0.1:8080/").as_deref(), Some("ws://127.0.0.1:8080/ws"));
        assert_eq!(public_ws_url("ftp://x"), None);
        assert_eq!(public_ws_url("https://u@x"), None);
        assert_eq!(origin_of("https://app.example/x?y").as_deref(), Some("https://app.example"));
    }

    #[test]
    fn behind_a_proxy_the_per_ip_quotas_are_the_totals() {
        let mut s = Socket::new("127.0.0.1:0".parse().unwrap());
        assert_eq!(s.quotas(), ConnectionQuotas::default());
        s.behind_proxy = true;
        let q = s.quotas();
        assert_eq!((q.max_per_ip, q.max_anonymous_per_ip), (q.max_connections, q.max_anonymous));
    }
}

use my_service_backend::login::{Login, LoginArgs};
use my_service_backend::serve::{self, Socket};
use clap::Parser;
use plexus_shell::{AppSource, EmbeddedTable, ShellConfig};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

/// The frontend's build, compiled into the binary by build.rs when the
/// `embedded-app` feature is on (`frontend/dist`); empty otherwise.
static APP: EmbeddedTable = plexus_shell::embedded_app!();

/// Where a checkout's frontend build lands. Resolved from the crate's
/// source directory, not the working directory, so `cargo run` finds it
/// from anywhere in the checkout; a binary run elsewhere serves its
/// embedded build, or the not-built page.
const CHECKOUT_DIST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../frontend/dist");

#[derive(Parser, Debug)]
#[command(name = "my-service", about = "my-service's Plexus RPC backend")]
struct Args {
    /// WebSocket port. synapse.config.json's `url` names the same one.
    #[arg(short, long, env = "MY_SERVICE_PORT", default_value = "4610")]
    port: u16,

    /// The shell's port: the frontend's build over HTTP (default: the
    /// WebSocket port + 1).
    #[arg(long, env = "MY_SERVICE_SHELL_PORT")]
    shell_port: Option<u16>,

    /// The address both listeners bind: loopback by default; `0.0.0.0` in
    /// a container, where the reverse proxy in front reaches them.
    #[arg(long, env = "MY_SERVICE_BIND", default_value = "127.0.0.1", value_name = "ADDR")]
    bind: IpAddr,

    /// Where people reach the app when it is served behind a reverse proxy,
    /// e.g. `https://my-service.example`: the page dials the WebSocket at its
    /// origin's `/ws` (stamped into `{{WS_URL}}`; the proxy routes `/ws` to
    /// the WebSocket port), the WebSocket admits that origin, and login's
    /// redirects and cookies follow it. Default: none — the page dials its
    /// own host at the WebSocket port.
    #[arg(long, env = "MY_SERVICE_PUBLIC_URL", value_name = "URL")]
    public_url: Option<String>,

    /// Every connection arrives through one reverse proxy: the WebSocket's
    /// per-IP connection quotas, which would count every visitor as the
    /// proxy, are lifted to the totals.
    #[arg(long, env = "MY_SERVICE_BEHIND_PROXY")]
    behind_proxy: bool,

    /// Serve the frontend's build from this directory. Default: the build
    /// embedded in the binary (`--features embedded-app`) when there is
    /// one, else the checkout's frontend/dist.
    #[arg(long, env = "MY_SERVICE_APP_DIST")]
    app_dist: Option<PathBuf>,

    /// No shell: the WebSocket alone.
    #[arg(long)]
    no_shell: bool,

    /// A further origin whose pages may open the WebSocket (repeatable),
    /// e.g. a frontend dev server's. The shell's own are always admitted;
    /// a caller with no Origin (synapse, a native client) always is.
    #[arg(long = "allow-origin", value_name = "ORIGIN")]
    allow_origins: Vec<String>,

    /// The login's flags (backend/src/login.rs: none without layer login).
    #[command(flatten)]
    login: LoginArgs,

    /// The children mounted under this service: `--child NAME=stdio:CMD`
    /// or `--child NAME=ws://HOST:PORT` (plexus-core's `ChildArgs`, spec/12).
    #[command(flatten)]
    children: plexus_core::plexus::ChildArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let mut origins = args.allow_origins.clone();
    let public_url = match args.public_url.as_deref() {
        Some(url) => {
            let origin = serve::origin_of(url).ok_or_else(|| anyhow::anyhow!("--public-url '{url}' is not an http(s) URL"))?;
            origins.push(origin);
            Some(url.trim_end_matches('/').to_string())
        }
        None => None,
    };

    // The shell's port: bound before anything serves, so a port that is
    // taken fails the start rather than half of it.
    let listener = if args.no_shell {
        None
    } else {
        let shell_port = match args.shell_port {
            Some(p) => p,
            None => args.port.checked_add(1).ok_or_else(|| anyhow::anyhow!("--port {} leaves no room for the shell's (+1); pass --shell-port", args.port))?,
        };
        let listener = tokio::net::TcpListener::bind((args.bind, shell_port))
            .await
            .map_err(|e| anyhow::anyhow!("cannot bind the shell to {}:{shell_port}: {e}", args.bind))?;
        Some(listener)
    };
    let shell_port = listener.as_ref().map(|l| l.local_addr()).transpose()?.map(|a| a.port());

    // The login seam (backend/src/login.rs): the service — with login, its
    // `auth` and the roles its activations declare — and what login adds to
    // the shell and the WebSocket. Without layer login, nothing.
    let login = Login::wire(&args.login, args.port, shell_port, public_url.as_deref(), &args.allow_origins)?;
    // Each `--child` started (or dialed) and its schema asked before
    // anything is served; one that does not answer stops the start.
    let children = args
        .children
        .connect_all(my_service_backend::SERVICE)
        .await
        .map_err(|e| anyhow::anyhow!("--child refused: {e}"))?;
    let service = login.service(children);

    if let (Some(listener), Some(shell_port)) = (listener, shell_port) {
        origins.extend([format!("http://127.0.0.1:{shell_port}"), format!("http://localhost:{shell_port}")]);
        let app = match &args.app_dist {
            Some(dir) => AppSource::Dir(dir.clone()),
            None => AppSource::embedded_or(APP, CHECKOUT_DIST),
        };
        // Mounted at `/`: the build's own paths (Vite's and Trunk's default
        // base) are the shell's.
        let mut shell = ShellConfig::new(my_service_backend::SERVICE, app);
        shell.mount = "/".into();
        // The socket's full URL behind a proxy (`wss://<public host>/ws`);
        // empty without --public-url, and the page dials its own host at
        // `{{WS_PORT}}`.
        let ws_url = public_url.as_deref().and_then(serve::public_ws_url).unwrap_or_default();
        shell.stamps.push(("{{WS_URL}}".into(), ws_url));
        login.shell(&mut shell);
        let router = login.guard(plexus_shell::router(shell, args.port).await);
        tracing::info!("app on http://{}:{shell_port}/{}", args.bind, public_url.as_deref().map(|u| format!(" (public: {u})")).unwrap_or_default());
        tokio::spawn(async move {
            if let Err(e) = plexus_shell::serve_on(listener, router, std::future::pending()).await {
                tracing::error!("the shell stopped: {e}");
            }
        });
    }

    let mut socket = Socket::new(SocketAddr::new(args.bind, args.port));
    socket.origins = origins;
    socket.behind_proxy = args.behind_proxy;
    login.socket(&mut socket);
    tracing::info!("{} on ws://{}", my_service_backend::SERVICE, socket.addr);
    serve::run(service, socket).await
}

# my-service

A Plexus RPC app: a Rust service named `my-service` on the plexus 0.6 line, made
by plexus-starter's `scripts/new.sh` (the first commit names the layers it
was made from).

```
backend/            Rust — the service `my-service` with one activation, `greeter`, and its shell
  build.rs            with `embedded-app`, compiles frontend/dist into the binary
  src/login.rs        the login seam main.rs calls — here, no login (layer login replaces it)
  src/serve.rs        the WebSocket on --bind (origins, quotas, the login's upgrade), registry, SIGTERM
xtask/              `cargo xtask <task>` — runs scripts/<task>.sh
scripts/ci.sh       every CI step, locally (scripts/ci.d/ holds the layers' steps)
scripts/dev.sh      what `cargo xtask dev` runs
```

## Run it

```sh
cargo run -p my-service-backend                       # ws://127.0.0.1:4610 (--port, or MY_SERVICE_PORT)
synapse -P 4610 my-service greeter hello --name Ada
synapse -P 4610 my-service greeter count --to 3
```

The backend is two listeners on `--bind` (default 127.0.0.1): the service's
WebSocket (`--port`, default 4610) and its **shell** (`--shell-port`, default `--port` + 1),
which serves the frontend's build — the service alone serves the
app; there is no second server in production. The shell is
[plexus-shell](https://crates.io/crates/plexus-shell), mounted at `/`:

- **What it serves**, first that applies: the directory `--app-dist DIR`
  (or `MY_SERVICE_APP_DIST`); the build compiled into the binary, when it was
  built with `--features embedded-app` after the frontend's build; the
  checkout's `frontend/dist` (found from the crate's source directory, so
  from any working directory — read again whenever its `index.html`
  changes, so a rebuild needs no restart); else a "frontend not built" page.
- **Stamping.** As it serves `index.html` it replaces `{{WS_PORT}}` with the
  WebSocket's port, `{{WS_URL}}` with the socket's full URL behind a
  reverse proxy (below; empty otherwise) and `{{TITLE}}` with the service's
  name — that is how a page it serves finds the WebSocket: the URL if there
  is one, else its own host at the port.
- **Origins.** The WebSocket admits pages from the shell's own origins
  (`http://127.0.0.1:<shell>`, `http://localhost:<shell>`), from
  `--public-url`'s, and from each `--allow-origin ORIGIN` (a dev
  server's), and refuses any other with 403. A caller with no `Origin` — synapse, a native client — is always
  admitted. `--no-shell` runs the WebSocket alone (and, given no
  `--allow-origin`, checks no origin).

```sh
cargo build --release -p my-service-backend --features embedded-app   # after the frontend's build
target/release/my-service      # ws :4610 and the app on the next port — no frontend/dist on disk needed
```

`scripts/ci.d/90-embedded.sh` checks exactly that: built with
`embedded-app`, run on free ports, `/` is 200 and stamped, every file it
names is 200, and the WebSocket admits the shell's origin and refuses
another — then again with `--public-url`.

**Behind a reverse proxy** (one https origin in front: layer host's edge,
or any proxy) the backend takes three more flags, each with its variable:

| flag | env | |
| -- | -- | -- |
| `--bind ADDR` | `MY_SERVICE_BIND` | the address both listeners bind; `0.0.0.0` in a container (default `127.0.0.1`) |
| `--public-url URL` | `MY_SERVICE_PUBLIC_URL` | where people reach the app, e.g. `https://my-service.example`: the page dials `wss://my-service.example/ws` (stamped into `{{WS_URL}}`), the WebSocket admits that origin (and answers at `/ws` as at `/`), and login (if the app has it) takes its redirects and cookies from it |
| `--behind-proxy` | `MY_SERVICE_BEHIND_PROXY` | every connection arrives from the proxy: the WebSocket's per-IP connection quotas, which would count every visitor as the proxy, are lifted to the totals |

The proxy routes `/ws` to the WebSocket port and everything else to the
shell's. The backend trusts no forwarded header: who a caller is comes from
its credential, the public scheme and host from `--public-url`.
`backend/src/serve.rs` serves the WebSocket (plexus-transport's own
upgrade and accept loop, at the bound address — its `TransportServer`
binds loopback only), announces it to the registry (`PLEXUS_NO_REGISTRY=1`
to not) and stops on SIGTERM or ctrl-c.

`synapse`'s options go before the backend name; `synapse -P 4610 my-service`
lists the activations, `… my-service greeter` their methods, and `<method>
--help` a method's parameters.

| command | what it runs |
| -- | -- |
| `cargo test --workspace` | the backend's tests — never needs Docker or Node |
| `cargo xtask` | lists the tasks (one per `scripts/*.sh`) |
| `cargo xtask dev` | `scripts/dev.sh` |
| `cargo xtask ci` / `scripts/ci.sh` | every CI step, locally |
| `.github/workflows/*.yml` | the same steps on GitHub |

## Add an activation

1. Write it beside `backend/src/greeter.rs` — every method returns a stream
   of one event enum tagged by `type`, with an in-band `Error` variant.
2. Register it in `backend/src/lib.rs`'s `register`.

## Versions

plexus-core 0.6, plexus-macros 0.6, plexus-transport 0.5 and
plexus-shell 0.1, from crates.io. The activation API is `#[plexus_macros::activation(namespace =
…, crate_path = "plexus_core")]` on an `impl` whose methods carry
`#[plexus_macros::method(…)]`.

## Frontend: TypeScript (layer ts)

```
client/             @my-service/client — the TypeScript library
  generated/          written by synapse-cc from the running backend; never edited, not committed
  index.ts            the hand-written part: connect()
frontend/           Vite + TypeScript — depends on @my-service/client
synapse.config.json what synapse-cc generates: backend name, URL, transport, output dir
scripts/codegen.sh  the one definition of codegen (every entry point below runs it)
```

```sh
cd frontend && npm ci && npm run build   # backend, codegen, client, frontend → frontend/dist
cargo xtask dev                          # the backend on :4610 and Vite's dev server, together
cargo xtask codegen                      # regenerate the client (also: cargo xtask client)
cargo build --release -p my-service-backend --features embedded-app   # the app inside the binary
```

### Served by the service

`frontend/dist` is what the service's shell serves (README "Run it"): from disk
in a checkout, or compiled into the binary with `--features embedded-app`
after `npm run build` — the release binary alone then serves the app at
`http://127.0.0.1:<4610 + 1>/`. Vite's `base` stays `/`: the shell is
mounted at `/`, so the build's own paths (`/assets/…`) are the shell's.

**How the page finds the WebSocket.** `frontend/index.html` carries
`<meta name="plexus-ws-port" content="{{WS_PORT}}">` and `<meta
name="plexus-ws-url" content="{{WS_URL}}">`; the shell stamps the service's
WebSocket port into the first as it serves the page, and into the second
the socket's full URL when the backend runs behind a reverse proxy
(`--public-url https://HOST` → `wss://HOST/ws`; empty otherwise). The
client's `pageUrl()` reads the URL if there is one, else
`ws://127.0.0.1:<port>`, so `connect()` with no URL reaches the service that
served the page — whatever `--port` it runs on, or behind whatever edge. Under Vite's dev server the
placeholder is not stamped and the URL falls back to `VITE_PLEXUS_URL`,
then `DEFAULT_URL` (`ws://127.0.0.1:4610`).

**Development.** `cargo xtask dev` runs the backend with `--allow-origin`
for Vite's origin (`http://127.0.0.1:5173`, pinned in `vite.config.ts`)
— the WebSocket refuses pages from any origin it was not told of — and
Vite with hot reload. The shell (:4610 + 1) serves the last
`npm run build` meanwhile.

Change the backend, then regenerate the client (`cargo xtask codegen`, or
`npm run build` in `client/`). A method or event field renamed on the
backend is a TypeScript compile error in the frontend after that — the
generated types are the backend's.

**Once per machine**, the codegen image must exist. Build it from the
hypermemetic checkouts (synapse, synapse-cc, plexus-protocol, service-codegen
side by side) with `<workspace>/dockerfiles/plexus-codegen/build.sh`
(tags `plexus-codegen:latest`), or point `PLEXUS_CODEGEN_IMAGE` at a
published one (a name with a registry in it is pulled when missing).

### How codegen works

`scripts/codegen.sh` reads the port from `synapse.config.json`'s `url`. If a
backend already answers there it uses it; otherwise it builds the backend,
starts it (`--no-shell`: the WebSocket is all codegen needs), and stops it
when done. Then it runs `synapse-cc build` in the
`plexus-codegen` image (`docker run --network host --security-opt
label=disable --user …`) — the container reads the schema over the host's
loopback, writes `client/generated/`, installs its dependencies, compiles
it and runs its smoke tests against the live backend. `label=disable` is
for SELinux hosts, where the bind mount is otherwise unreadable inside the
container. synapse-cc also writes `synapse.lock` (the versions and hashes
of what it generated); commit it if you want that record.

| entry point | what it runs |
| -- | -- |
| `npm run build` in `client/` | codegen, then a type-check of the library |
| `npm run build` in `frontend/` | the client's build, then `tsc` and `vite build` |
| `npm run build:app` in `frontend/` | the app alone, against the client already generated |
| `cargo xtask codegen` | codegen |
| `scripts/ci.d/20-frontend.sh` | `npm ci && npm run build` in `frontend/` (a step of `scripts/ci.sh`) |
| `scripts/ci.d/90-embedded.sh` | that build embedded and served by the service alone (base's step) |
| `.github/workflows/frontend.yml` | the same, on GitHub |

### Add an activation's client

After registering an activation, `cargo xtask codegen`, then expose its
client in `client/index.ts`'s `connect()` (`createXClient(rpc)` from
`./generated/x`).

## Work

Tracked in menger under the shortcode **MYSERVICE** (root
*not filed yet* (made with `--no-tracker`; file it: `synapse -P 4455 menger tickets create --epic MYSERVICE --kind scope --parent PLEXUS-1 --title 'MyService — …'`, then put its id here)), run the menger ticketing way — AGENTS.md "How work is run" has the
commands.

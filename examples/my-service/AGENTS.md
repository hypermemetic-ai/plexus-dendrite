# my-service

A Plexus RPC app made by plexus-starter. README.md has the layout and every
command; these are the rules.

- **Every activation method returns a stream of one event enum**,
  `#[serde(tag = "type", rename_all = "snake_case")]`, with an in-band
  `Error { message }` variant. Those enums are the wire types every client
  is made from.
- **Nothing in a `build.rs` runs codegen or a frontend build.** `cargo
  build` and `cargo test` must work without Docker or Node. backend's
  build.rs only *reads* `frontend/dist` (with `--features embedded-app`)
  into the binary; an absent build embeds nothing, with a warning.
- **The service serves the app** (plexus-shell, mounted at `/`, on `--port` +
  1): its entrypoint is stamped with `{{WS_PORT}}` — and, behind a reverse
  proxy (`--public-url`), `{{WS_URL}}`, the socket's full URL — which is
  how the page finds the WebSocket. Never add a second server for the
  frontend; a dev server's origin is admitted with `--allow-origin`.
- **The WebSocket is served by `backend/src/serve.rs`**, which binds
  `--bind` (plexus-transport 0.5's `TransportServer` binds loopback only):
  the same upgrade, origins and quotas, the registry's announcement, a stop
  on SIGTERM. A layer adds to the upgrade through the login seam's
  `socket()`, never by serving the socket another way.
- **main.rs is the same file in every app.** What a layer changes about
  the service, the shell or the socket goes through a seam it calls —
  `backend/src/login.rs` (no login here; layer login replaces the file) —
  never an edit to main.rs.
- **Automation lives in `scripts/`**; `cargo xtask <task>` runs
  `scripts/<task>.sh` and CI runs `scripts/ci.sh`'s steps. Add an entry
  point by calling a script, never by copying what it does. A CI step is a
  file in `scripts/ci.d/` and a workflow beside `.github/workflows/ci.yml`.
- **Reach the backend with `synapse`**: `synapse -P 4610 my-service greeter
  hello --name Ada`. Options go before the backend name; params are flags;
  a list parameter is its flag repeated or comma-separated. The house
  invocation contract is `menger-skills/reaching/SKILL.md`.

## Frontend: TypeScript (layer ts)

- **Codegen has one definition: `scripts/codegen.sh`.** `npm run build` in
  `client/` or `frontend/`, `cargo xtask codegen` and CI all run it. Add an
  entry point by calling it, never by copying its `docker run`.
- **`client/generated/` is output.** Never edit it and never commit it; it
  is rewritten by every codegen run. Hand-written client code goes in
  `client/index.ts`.
- The codegen image (`plexus-codegen`) is built by
  `dockerfiles/plexus-codegen/build.sh` from the hypermemetic checkouts;
  `PLEXUS_CODEGEN_IMAGE` names another.
- **The page finds the service through the shell's stamp**, never a
  hard-coded port: `<meta name="plexus-ws-port" content="{{WS_PORT}}">` and
  `<meta name="plexus-ws-url" content="{{WS_URL}}">` (the socket's full URL
  behind a reverse proxy) in `frontend/index.html`, read by `pageUrl()` in
  `client/index.ts`. Keep both metas, and keep Vite's `base` at `/` (the
  shell is mounted at `/`).
- **Vite's dev server is for development only.** In production the service's
  shell serves `frontend/dist`, embedded with `--features embedded-app`; a
  new dev origin is admitted with the backend's `--allow-origin` (as
  `scripts/dev.sh` does), never by turning the origin check off.

## How work is run (layer method)

Work on my-service is planned, built and landed the **menger ticketing** way
(`menger-skills`, checked out beside plexus-starter; each skill is also a
doc on the tracker under `SKILL-1`), tracked in **menger**. Read the skills; this section is
only what is particular to my-service.

- **Tracker:** menger on `-P 4455`; the app's shortcode is
  **MYSERVICE**, its root the scope ticket *not filed yet* (made with `--no-tracker`; file it: `synapse -P 4455 menger tickets create --epic MYSERVICE --kind scope --parent PLEXUS-1 --title 'MyService — …'`, then put its id here) (its parent:
  PLEXUS-1). Every ticket of my-service is `MYSERVICE-N`, a
  descendant of the root; `--parent` names one inside MYSERVICE.
  Read `menger-skills/reaching/SKILL.md` before synapse: options before the backend
  name; params are flags; `<method> --help` lists them.
- **Planning** (`menger-skills/planning/SKILL.md`, `menger-skills/ticketing/`): a milestone
  is a scope ticket + an execution ticket, its builds and spikes children
  of the execution ticket. Tickets are born `Pending`; only the owner
  promotes to `Ready`, and nothing is built from `Pending`. An agent never
  answers its own decision.
- **Building** (`menger-skills/building/SKILL.md`): one worktree and one branch per
  ticket (the branch named for it), one commit per ticket.
- **A ticket's outputs are tickets** — a finding, report or manifest is a
  child of the ticket that produced it (`--kind doc`), not a file here.

```sh
T="synapse -P 4455 menger tickets"
$T get --id MYSERVICE-1            # the root: the app's scope, grilled before work is planned
$T list --epic MYSERVICE --summary  # every ticket of the shortcode
$T ready_set --filter 'in MYSERVICE' --summary   # what can start
# file (born Pending): the execution ticket under the root, its builds under it
$T create --epic MYSERVICE --kind execution --parent MYSERVICE-1 --title 'Execution · …' --body "$(cat body.md)"
$T create --epic MYSERVICE --kind build --parent MYSERVICE-2 --title 'B1 · …' --body "$(cat body.md)"
# move (once the owner has made it Ready)
$T set_status --id MYSERVICE-3 --status Coding       # the moment work starts
$T amend --id MYSERVICE-3 --body "$(cat body.md)"     # the whole body, the branch recorded in it
$T link_commits --id MYSERVICE-3 --commits my-service@<hash>   # repo@hash
$T set_status --id MYSERVICE-3 --status 'In Review'  # gate green, committed, linked
```

- **The lifecycle:** `Pending → Ready → Coding → In Review → Complete`
  (the legacy `active` is `Coding`, `in review` is `In Review`, `done` is
  `Complete`). The worker sets `Coding` when it starts and `In Review` in
  the step that commits the finished work — `scripts/ci.sh` green first.
  The merge sets `Complete` and links the merge commit if it differs.
- **Commits** name their ticket first and say what changed:
  `MYSERVICE-3: <what it does now> — in review` for the finishing
  commit, `Merge MYSERVICE-3: …` for the merge. Link a commit as
  `my-service@<hash>` (`repo@hash`): the tracker holds many repositories.
- **Delegation:** an implementation subagent gets one ticket, its own
  worktree, and the ticket's id; it moves the ticket as above and reports
  the commit hash. It never promotes a ticket or closes the owner's input.

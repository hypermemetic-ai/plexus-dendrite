# plexus-dendrite

The "Grow" chapter of PLEXUS-40's film, built (VISION-4): *grow a dendrite
toward a service — a runtime reads its schema and writes the client. Shape
it into a method of your own.*

```ts
// dendrites/digest/index.ts
import { weather } from "./clients/weather"; // generated

export async function* do_thing({ city }) {
  const days = await weather.forecast({ city, days: 7 });
  yield { rain_days: days.filter((d) => d.rain > 0.5).length };
}
```

```sh
$ ./run.sh                     # build, start registry · weather · my-service, ask, stop
$ synapse -P 4600 my-service digest do_thing --city lisbon
rain_days: 3

$ REGISTRY_PORT=4444 ./run.sh  # the registry on synapse's default port: the film's bare command
$ synapse my-service digest do_thing --city lisbon
rain_days: 3

$ ./run.sh up && ./run.sh proof && ./run.sh down
                               # edit index.ts (> 0.5 → > 1.5), restart the dendrite: rain_days: 1; put it back: 3
```

## What is here

| path | what |
| -- | -- |
| `bin/plexus-dendrite`, `src/` | the runtime (TypeScript, Node ≥ 22, tsx) |
| `dendrites/digest/index.ts` | the film's dendrite, as the film shows it |
| `examples/weather` | `weather-service`: `weather.forecast { city, days }` → a stream of `day { date, rain }`; deterministic per city (lisbon: 3 of 7 days over 0.5 mm), `--live` reads open-meteo |
| `examples/my-service` | an app made by `plexus-starter` (`new.sh my-service --frontend ts --set port=4610`), moved to plexus-core 0.7 for its `RemoteChild`, with `--child` (`ChildArgs`) wired into `main.rs` |
| `run.sh` | starts the three (and plexus-registry) on 4600–4619 and plays the command |
| `test/` | the runtime as a service sees it (`npm test`), `--via-host` included |
| `src/pipe.ts`, `src/host.ts` | the pipe both ways (spec/14 rule 2) and the calls back to the host |

## The runtime

```sh
plexus-dendrite serve DIR [--target NAME=ws://HOST:PORT]… [--via-host [NAME=]PATH,…]… [--name NS]
                                                                         # a peer on stdio (a spec/12 child)
plexus-dendrite grow  DIR [--target NAME=ws://HOST:PORT]…               # the clients only
plexus-dendrite schema DIR                                              # the schema it would serve
```

At start, for each target:

1. asks its `_info` for the backend's name;
2. runs **synapse-cc** (`build --no-install --no-build --no-tests`; the local
   binary, else the `plexus-codegen` container with `--network host
   --security-opt label=disable`) into `DIR/clients/NAME/generated/` — the
   target's IR and its typed client;
3. writes `DIR/clients/NAME/index.ts` over it: one object per activation
   (`weather`), a method per method taking a params object, whose call is
   awaited as an array of the stream's items or iterated as the stream (an
   in-band `error` item throws); and `stamp.json`, the backend, its url and
   its IR hash.

A target is optional. **`--via-host [NAME=]PATH,…`** (NEST-11) grows a
client toward a service **its host** serves at `PATH` (`weather`,
`dyn.peer.w.weather`; `NAME` defaults to the last segment), and every call
goes back through the host — plexus-wire spec/14, "A child calls its service
back":

1. at start, before serving, it asks the host on the pipe it was spawned on
   for `PATH.schema` (`_host.call` with no `under`: the host's own view; the
   host's `_info` waits meanwhile), and writes `DIR/clients/NAME/index.ts`
   from it — no synapse-cc, no socket: one method per method, its params
   typed from the schema's;
2. each call made through it is `_host.call {method, params, under}`,
   `under` the `hop.call` of the call the dendrite is serving (found by
   `AsyncLocalStorage`, `src/host.ts`), so the host's gate decides it **as
   that call's caller**, within its reach, and ends it when that call ends;
   a refusal throws, its `kind` on the error.

`DIR/dendrite.json` may say `"via_host": ["dyn.peer.w.weather"]` too.
plexus-dyn's `dyn.grow` starts a dendrite this way.

**What it needs of its host** (NEST-16). A host on plexus-core 0.11 lets a
child call back only the standard upward interface (`host.schema`,
`host.whoami`, `host.log`, `host.notify`) and what its schema's `needs`
names. A dendrite grown `--via-host` declares them, read from `index.ts`: a
call `weather.forecast(…)` on a client imported from `./clients/weather` is
`<PATH>.forecast`; a client used any other way (aliased, passed on) needs
every method it has. What the code cannot show is said by hand, as `export
const needs = ["shop.items"]` in `index.ts` or `"needs": […]` in
`dendrite.json`. Each need is checked by its presence when the dendrite is
grafted (it holds no shape hash of the host's methods). A dendrite that
calls no host declares nothing.

Then it loads `DIR/index.ts` and serves every exported async generator (many
items) or async function (one) as a method of a peer — a Plexus child (spec/12) — whose namespace is the
directory's name, on stdio (plexus-wire spec/11, spec/12): `_info`,
`{ns}.schema`, `{ns}.call {method, params, hop}`, `{ns}.call_unsub`, EOF.
The far side decides again: no hop is `unauthenticated`, a hop admitted for
another grant `forbidden`. A method's parameters are read from the source
(the TypeScript compiler API): annotated types, else a default's type, else
a string; its description is its JSDoc. Hashes cover the shape, not the
body, so an edited body restarts under the same schema and the mounting
service (which refuses a restarted child whose schema moved) takes it back.

Any Plexus service on plexus-core ≥ 0.7 mounts it:

```sh
my-service --port 4610 --child-timeout 60s \
  --child "digest=stdio:$PWD/bin/plexus-dendrite serve $PWD/dendrites/digest --target weather=ws://127.0.0.1:4601"
```

## How synapse finds `my-service`

synapse's `-P` is its registry/discovery port (default 4444): it dials it,
and when what answers has a `registry` activation, it resolves the backend
by name there. `run.sh` starts `plexus-registry` (the sibling checkout) on
`REGISTRY_PORT` (4600) with its own database and config in `.run/`, and
every service announces itself to it at boot (plexus-transport's Z2H-6,
`PLEXUS_REGISTRY_URL`). So `synapse -P 4600 my-service …` resolves by name;
with `REGISTRY_PORT=4444` the bare `synapse my-service …` does.

## Rough

- The dendrite is a **flat child** (`--child`, plexus-core's `RemoteChild`),
  not NEST-1's target, an untyped peer returned as `Result<Box<dyn Peer>,
  PeerError>` by a `#[peer]` slot: no `PeerError`, a mount at start rather
  than a peer grown at runtime, gated as a whole child. NEST-4/NEST-7 bring
  the target.
- Untyped parameters (`{ city }`) are read as strings.
- The stamp is written, not checked: a target whose IR moves is regenerated
  at the next start of the dendrite, never mid-run.
- The client is regenerated at every start (synapse-cc caches the IR; it
  takes well under a second), so the target must be up before the
  dendrite.
- synapse-cc 0.3.6 reads plexus-macros 0.7's `streaming` methods as
  `mdStreaming: false`, so its typed client collects one item; the
  dendrite's face calls `rpc.call` itself and collects them all.

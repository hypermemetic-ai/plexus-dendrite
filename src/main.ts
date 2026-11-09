// plexus-dendrite — a runtime for dendrites: a directory with an `index.ts`
// whose exported async generators are methods, grown toward the services it
// names. At start it reads each target's schema, writes its client into
// `./clients/<name>` (synapse-cc), loads `index.ts`, and serves its methods
// as a Plexus child named after the directory, on stdio (spec/11, spec/12)
// — what a Rust service mounts with `--child NAME=stdio:CMD`.
//
//   plexus-dendrite serve DIR [--target NAME=ws://HOST:PORT]… [--via-host [NAME=]PATH,…]… [--name NS]
//   plexus-dendrite grow  DIR [--target NAME=ws://HOST:PORT]…     the clients only
//   plexus-dendrite schema DIR [--name NS]                         the schema it would serve
//
// Targets also come from `DIR/dendrite.json` (`{"targets": {"weather": "ws://…"},
// "via_host": ["dyn.peer.weather"]}`); a flag wins over it. A target is
// optional: `--via-host` (NEST-11) grows a client from the host's own view of
// a service it serves — asked over the pipe the dendrite was spawned on — and
// calls it back through the host, as the caller of the call being served.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serveStdio, type Handler } from "./stdio.ts";
import { grow, growViaHost, parseTarget, parseViaHost, type Target, type ViaHost } from "./grow.ts";
import { attach, hostCall } from "./host.ts";
import { openPipe } from "./pipe.ts";
import { log } from "./log.ts";
import { readNeeds, readSurface, schemaOf, type Method } from "./surface.ts";

const VERSION = "0.1.0";

function usage(): never {
  process.stderr.write(
    "usage: plexus-dendrite serve|grow|schema DIR [--target NAME=ws://HOST:PORT]… [--via-host [NAME=]PATH,…]… [--name NS]\n",
  );
  process.exit(2);
}

interface Opts {
  cmd: string;
  dir: string;
  ns: string;
  targets: Target[];
  viaHost: ViaHost[];
  /** NEST-16: `"needs"` in dendrite.json. */
  needs: string[];
}

function parse(argv: string[]): Opts {
  const [cmd, dirArg, ...rest] = argv;
  if (!cmd || !dirArg || !["serve", "grow", "schema"].includes(cmd)) usage();
  const dir = resolve(dirArg);
  if (!existsSync(join(dir, "index.ts"))) {
    process.stderr.write(`plexus-dendrite: ${dir} has no index.ts\n`);
    process.exit(2);
  }
  let ns = basename(dir);
  const targets = new Map<string, Target>();
  const via = new Map<string, ViaHost>();
  let needs: string[] = [];
  const file = join(dir, "dendrite.json");
  if (existsSync(file)) {
    const conf = JSON.parse(readFileSync(file, "utf8"));
    needs = Array.isArray(conf.needs) ? conf.needs.map(String) : [];
    for (const [name, url] of Object.entries(conf.targets ?? {})) targets.set(name, parseTarget(`${name}=${url}`));
    for (const v of parseViaHost((conf.via_host ?? []).join(","))) via.set(v.name, v);
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = rest[i + 1];
    if (a === "--target" && v) (targets.set(parseTarget(v).name, parseTarget(v)), i++);
    else if (a.startsWith("--target=")) { const t = parseTarget(a.slice(9)); targets.set(t.name, t); }
    else if (a === "--via-host" && v) { for (const x of parseViaHost(v)) via.set(x.name, x); i++; }
    else if (a.startsWith("--via-host=")) { for (const x of parseViaHost(a.slice(11))) via.set(x.name, x); }
    else if (a === "--name" && v) (ns = v, i++);
    else usage();
  }
  for (const n of via.keys()) if (targets.has(n)) throw new Error(`\`${n}\` is both a --target and a --via-host`);
  return { cmd, dir, ns, targets: [...targets.values()], viaHost: [...via.values()], needs };
}

/** The module's exports that are methods, with their shapes from the source. */
async function load(dir: string, surface: Map<string, Method>): Promise<{ methods: Method[]; handlers: Map<string, Handler> }> {
  const mod = await import(pathToFileURL(join(dir, "index.ts")).href);
  const methods: Method[] = [];
  const handlers = new Map<string, Handler>();
  for (const [name, f] of Object.entries(mod)) {
    const kind = Object.prototype.toString.call(f);
    if (kind !== "[object AsyncGeneratorFunction]" && kind !== "[object AsyncFunction]") continue;
    const m = surface.get(name) ?? { name, description: name, params: [], streaming: kind === "[object AsyncGeneratorFunction]" };
    methods.push(m);
    handlers.set(name, f as Handler);
  }
  methods.sort((a, b) => a.name.localeCompare(b.name));
  return { methods, handlers };
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  // stdout is the wire: whatever a dendrite logs goes to stderr.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const surface = readSurface(join(o.dir, "index.ts"));
  const describe = (names: string[]) =>
    `A dendrite grown in ${basename(o.dir)}/index.ts${names.length ? `, toward ${names.join(", ")}` : ""}`;

  if (o.cmd === "schema") {
    const methods = [...surface.values()].sort((a, b) => a.name.localeCompare(b.name));
    const needs = readNeeds(join(o.dir, "index.ts"), o.viaHost, o.needs);
    const declares = o.viaHost.length > 0 || needs.length > 0;
    process.stdout.write(JSON.stringify(schemaOf(o.ns, VERSION, describe(o.targets.map((t) => t.name)), methods, declares ? needs : undefined), null, 2) + "\n");
    return;
  }

  if (o.cmd === "grow" && o.viaHost.length) throw new Error("`grow` reaches targets only: --via-host is grown at `serve`, on the pipe to the host");
  // The pipe first: the host's `_info` waits while the clients grow over it.
  const pipe = o.cmd === "serve" ? openPipe() : null;
  if (pipe) attach(pipe);
  const grown: { backend: string }[] = [];
  for (const t of o.targets) grown.push(await grow(o.dir, t));
  if (o.cmd === "grow") return;
  const viaGrown: { name: string; path: string; methods: string[] }[] = [];
  for (const v of o.viaHost) {
    const g = await growViaHost(o.dir, v, (m, p) => hostCall(m, p, undefined));
    viaGrown.push({ name: v.name, path: v.path, methods: g.methods });
    grown.push({ backend: v.path });
  }

  const { methods, handlers } = await load(o.dir, surface);
  // NEST-16: what it calls of its host, read from index.ts — declared when it
  // calls its host at all, so the host holds it to them.
  const needs = readNeeds(join(o.dir, "index.ts"), viaGrown, o.needs);
  const declares = o.viaHost.length > 0 || needs.length > 0;
  const schema = schemaOf(o.ns, VERSION, describe(grown.map((g) => g.backend)), methods, declares ? needs : undefined);
  if (declares) log(`needs of its host: ${needs.join(", ") || "(the standard interface alone)"}`);
  log(`serving ${o.ns} on stdio: ${methods.map((m) => `${o.ns}.${m.name}(${m.params.map((p) => p.name).join(", ")})`).join(", ")} — schema ${schema.hash}`);
  await serveStdio({ ns: o.ns, schema: () => schema, methods: handlers }, pipe!);
  log("stdin closed — exiting");
  process.exit(0);
}

main().catch((e) => {
  log(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

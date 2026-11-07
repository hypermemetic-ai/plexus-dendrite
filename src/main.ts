// plexus-dendrite — a runtime for dendrites: a directory with an `index.ts`
// whose exported async generators are methods, grown toward the services it
// names. At start it reads each target's schema, writes its client into
// `./clients/<name>` (synapse-cc), loads `index.ts`, and serves its methods
// as a Plexus child named after the directory, on stdio (spec/11, spec/12)
// — what a Rust service mounts with `--child NAME=stdio:CMD`.
//
//   plexus-dendrite serve DIR [--target NAME=ws://HOST:PORT]… [--name NS]
//   plexus-dendrite grow  DIR [--target NAME=ws://HOST:PORT]…     the clients only
//   plexus-dendrite schema DIR [--name NS]                         the schema it would serve
//
// Targets also come from `DIR/dendrite.json` (`{"targets": {"weather": "ws://…"}}`);
// a `--target` wins over it.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serveStdio, type Handler } from "./stdio.ts";
import { grow, parseTarget, type Target } from "./grow.ts";
import { log } from "./log.ts";
import { readSurface, schemaOf, type Method } from "./surface.ts";

const VERSION = "0.1.0";

function usage(): never {
  process.stderr.write(
    "usage: plexus-dendrite serve|grow|schema DIR [--target NAME=ws://HOST:PORT]… [--name NS]\n",
  );
  process.exit(2);
}

interface Opts {
  cmd: string;
  dir: string;
  ns: string;
  targets: Target[];
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
  const file = join(dir, "dendrite.json");
  if (existsSync(file)) {
    const conf = JSON.parse(readFileSync(file, "utf8"));
    for (const [name, url] of Object.entries(conf.targets ?? {})) targets.set(name, parseTarget(`${name}=${url}`));
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = rest[i + 1];
    if (a === "--target" && v) (targets.set(parseTarget(v).name, parseTarget(v)), i++);
    else if (a.startsWith("--target=")) { const t = parseTarget(a.slice(9)); targets.set(t.name, t); }
    else if (a === "--name" && v) (ns = v, i++);
    else usage();
  }
  return { cmd, dir, ns, targets: [...targets.values()] };
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
    process.stdout.write(JSON.stringify(schemaOf(o.ns, VERSION, describe(o.targets.map((t) => t.name)), methods), null, 2) + "\n");
    return;
  }

  const grown = [];
  for (const t of o.targets) grown.push(await grow(o.dir, t));
  if (o.cmd === "grow") return;

  const { methods, handlers } = await load(o.dir, surface);
  const schema = schemaOf(o.ns, VERSION, describe(grown.map((g) => g.backend)), methods);
  log(`serving ${o.ns} on stdio: ${methods.map((m) => `${o.ns}.${m.name}(${m.params.map((p) => p.name).join(", ")})`).join(", ")} — schema ${schema.hash}`);
  await serveStdio({ ns: o.ns, schema: () => schema, methods: handlers });
  log("stdin closed — exiting");
  process.exit(0);
}

main().catch((e) => {
  log(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

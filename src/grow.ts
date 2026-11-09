// Growing toward a target: its `_info` read, its `ir` turned into a client by
// synapse-cc, and a client the dendrite imports written over it.
//
//   <dendrite>/clients/<name>/generated/   synapse-cc's output (ir.json, the typed client)
//   <dendrite>/clients/<name>/index.ts     the dendrite's face of it: one object per
//                                          activation, a method per method, taking a
//                                          params object; awaiting a call collects its
//                                          stream, iterating it streams
//   <dendrite>/clients/<name>/stamp.json   what it was grown from: the backend, the url,
//                                          the ir's hash and each method's
//
// synapse-cc runs as the local binary when there is one, else in the
// plexus-codegen container (SELinux: label=disable, --network host).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { log } from "./log.ts";

export interface Target {
  /** The name the dendrite imports it by: `./clients/<name>`. */
  name: string;
  /** Its socket, `ws://HOST:PORT`. */
  url: string;
}

export interface Grown {
  target: Target;
  backend: string;
  irHash: string;
  activations: string[];
  regenerated: boolean;
}

/** `NAME=ws://…` → a target. */
export function parseTarget(spec: string): Target {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`--target ${spec}: want NAME=ws://HOST:PORT`);
  const name = spec.slice(0, eq);
  const url = spec.slice(eq + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error(`--target ${spec}: NAME must be a word`);
  if (!/^wss?:\/\//.test(url)) throw new Error(`--target ${spec}: the url must be ws:// or wss://`);
  return { name, url };
}

/** The target's `_info`: the backend's name (spec/07), over one socket. */
export async function backendOf(url: string, timeoutMs = 5000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${url}: no _info within ${timeoutMs} ms`));
    }, timeoutMs);
    const done = (f: () => void) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* closing */ }
      f();
    };
    ws.onerror = () => done(() => reject(new Error(`${url}: cannot connect`)));
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_info", params: null }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const item = msg?.params?.result;
      if (msg.error) done(() => reject(new Error(`${url}: _info: ${msg.error.message}`)));
      else if (item?.type === "data" && typeof item.content?.backend === "string") done(() => resolve(item.content.backend));
      else if (item?.type === "error") done(() => reject(new Error(`${url}: _info: ${item.message}`)));
    };
  });
}

function which(cmd: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** synapse-cc, local or in the container, writing into `out`. */
function synapseCc(backend: string, url: string, work: string): void {
  const config = {
    schema: "1.0",
    language: "typescript",
    backend,
    url,
    packageManager: "npm",
    targets: { client: { generate: ["transport", "rpc", "plugins"], transport: "ws", outputDir: "generated" } },
  };
  writeFileSync(join(work, "synapse.config.json"), JSON.stringify(config, null, 2) + "\n");
  // The dependencies (ws) are the runtime's; nothing is installed, built
  // or tested in the generated directory — tsx loads it as source.
  const args = ["build", "--no-install", "--no-build", "--no-tests"];
  const local = process.env.PLEXUS_DENDRITE_SYNAPSE_CC ?? which("synapse-cc");
  const image = process.env.PLEXUS_CODEGEN_IMAGE ?? "plexus-codegen:latest";
  let r;
  if (local && process.env.PLEXUS_DENDRITE_CODEGEN !== "docker") {
    log(`synapse-cc ${args.join(" ")} (${local}) — ${backend} at ${url}`);
    r = spawnSync(local, args, { cwd: work, stdio: ["ignore", 2, 2], env: { ...process.env, NO_COLOR: "1", TERM: "dumb" } });
  } else {
    log(`synapse-cc ${args.join(" ")} (in ${image}) — ${backend} at ${url}`);
    const uid = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    r = spawnSync(
      "docker",
      ["run", "--rm", "--network", "host", "--security-opt", "label=disable", "--user", uid,
        "-e", "HOME=/tmp", "-v", `${work}:/work`, "-w", "/work", image, "synapse-cc", ...args],
      { stdio: ["ignore", 2, 2] },
    );
  }
  if (r.error) throw new Error(`synapse-cc: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`synapse-cc exited ${r.status}`);
}

interface IrParam { pdName: string; pdRequired: boolean; pdDescription?: string | null; pdType: any; pdSource?: unknown }
interface IrMethod { mdName: string; mdNamespace: string; mdDescription?: string; mdParams: IrParam[]; mdReturns: any; mdStreaming: boolean }

function tsIdent(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(t) ? `_${t}` : t;
}

/** A parameter's type in TS, from the ir's reference. */
function paramType(t: any, ns: string, exported: Set<string>): string {
  if (t?.tag === "RefPrimitive") {
    const p = t.contents?.[0];
    if (p === "string") return "string";
    if (p === "integer" || p === "number") return "number";
    if (p === "boolean") return "boolean";
  }
  if (t?.tag === "RefNamed" && t.contents?.qnNamespace === ns && exported.has(t.contents.qnLocalName)) {
    return `T_${tsIdent(ns)}.${t.contents.qnLocalName}`;
  }
  if (t?.tag === "RefOptional") return `${paramType(t.contents, ns, exported)} | null`;
  if (t?.tag === "RefArray") return `Array<${paramType(t.contents, ns, exported)}>`;
  return "unknown";
}

/** The client the dendrite imports: `export const <activation> = { method(params) }`. */
function writeFace(dir: string, target: Target, backend: string, ir: any): string[] {
  const methods = Object.values(ir.irMethods as Record<string, IrMethod>);
  const activations = Object.keys(ir.irPlugins as Record<string, string[]>).filter((p) => p && !p.includes("."));
  const lines: string[] = [];
  lines.push(`// Grown by plexus-dendrite from ${backend} at ${target.url} (ir ${ir.irHash}).`);
  lines.push(`// Regenerated at every start of the dendrite; never edit it.`);
  lines.push(`import { createClient } from "./generated/transport";`);
  lines.push(`import { extractData } from "./generated/rpc";`);
  for (const ns of activations) {
    lines.push(`import type * as T_${tsIdent(ns)} from "./generated/${ns}/types";`);
  }
  lines.push("");
  lines.push(`/** The target, as grown: its backend, its socket, its ir's hash (the stamp). */`);
  lines.push(`export const stamp = ${JSON.stringify({ backend, url: target.url, ir: ir.irHash })} as const;`);
  lines.push("");
  lines.push(`const rpc = createClient({ backend: stamp.backend, url: process.env.PLEXUS_DENDRITE_TARGET_${tsIdent(target.name).toUpperCase()} ?? stamp.url });`);
  lines.push("");
  lines.push(`/** A call: \`await\` it for every item as an array, or \`for await\` it as a stream. An in-band \`error\` item throws. */`);
  lines.push(`export class Call<T> implements PromiseLike<T[]>, AsyncIterable<T> {`);
  lines.push(`  constructor(private method: string, private params: Record<string, unknown>) {}`);
  lines.push(`  async *[Symbol.asyncIterator](): AsyncIterator<T> {`);
  lines.push(`    for await (const item of extractData<any>(rpc.call(this.method, this.params))) {`);
  lines.push(`      if (item && typeof item === "object" && item.type === "error") throw new Error(\`\${this.method}: \${item.message ?? "error"}\`);`);
  lines.push(`      yield item as T;`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  async collect(): Promise<T[]> {`);
  lines.push(`    const out: T[] = [];`);
  lines.push(`    for await (const x of this) out.push(x);`);
  lines.push(`    return out;`);
  lines.push(`  }`);
  lines.push(`  then<A = T[], B = never>(ok?: ((v: T[]) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {`);
  lines.push(`    return this.collect().then(ok, err);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");
  lines.push(`/** Close the socket to the target. */`);
  lines.push(`export function close(): void { rpc.disconnect(); }`);
  for (const ns of activations) {
    const typesFile = join(dir, "generated", ns, "types.ts");
    const src = existsSync(typesFile) ? readFileSync(typesFile, "utf8") : "";
    const exported = new Set([...src.matchAll(/export (?:type|interface) ([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    lines.push("");
    lines.push(`/** \`${ns}\` on ${backend}. */`);
    lines.push(`export const ${tsIdent(ns)} = {`);
    for (const m of methods.filter((m) => m.mdNamespace === ns && m.mdName !== "schema")) {
      const ps = m.mdParams.filter((p) => !p.pdSource);
      const shape = ps.map((p) => `${JSON.stringify(p.pdName)}${p.pdRequired ? "" : "?"}: ${paramType(p.pdType, ns, exported)}`).join("; ");
      const ret = m.mdReturns?.tag === "RefNamed" && exported.has(m.mdReturns.contents?.qnLocalName)
        ? `Exclude<T_${tsIdent(ns)}.${m.mdReturns.contents.qnLocalName}, { type: "error" }>`
        : "unknown";
      if (m.mdDescription) lines.push(`  /** ${m.mdDescription.replace(/\*\//g, "* /")} */`);
      lines.push(`  ${tsIdent(m.mdName)}(params: { ${shape} }): Call<${ret}> {`);
      lines.push(`    return new Call<${ret}>(${JSON.stringify(`${ns}.${m.mdName}`)}, params);`);
      lines.push(`  },`);
    }
    lines.push(`};`);
  }
  writeFileSync(join(dir, "index.ts"), lines.join("\n") + "\n");
  return activations;
}

/** The runtime's own `ws`, linked where the generated transport imports it from. */
function linkDeps(generated: string): void {
  const req = createRequire(import.meta.url);
  const ws = dirname(req.resolve("ws/package.json"));
  const nm = join(generated, "node_modules");
  mkdirSync(nm, { recursive: true });
  const at = join(nm, "ws");
  rmSync(at, { force: true, recursive: true });
  symlinkSync(ws, at, "dir");
}

/** Grow toward one target: its client in `<dendrite>/clients/<name>`. */
export async function grow(dendrite: string, target: Target): Promise<Grown> {
  const dir = join(dendrite, "clients", target.name);
  mkdirSync(dir, { recursive: true });
  const backend = await backendOf(target.url);
  const before = readStamp(dir);
  synapseCc(backend, target.url, dir);
  const irFile = join(dir, "generated", "ir.json");
  if (!existsSync(irFile)) throw new Error(`synapse-cc wrote no ${irFile}`);
  const ir = JSON.parse(readFileSync(irFile, "utf8"));
  linkDeps(join(dir, "generated"));
  const activations = writeFace(dir, target, backend, ir);
  const methods: Record<string, string> = {};
  for (const [k, v] of Object.entries(ir.irPluginHashes ?? {}) as [string, any][]) if (k) methods[k] = String(v?.phiHash ?? v);
  const stamp = { backend, url: target.url, ir: ir.irHash, activations: methods };
  writeFileSync(join(dir, "stamp.json"), JSON.stringify(stamp, null, 2) + "\n");
  const regenerated = before?.ir !== ir.irHash;
  log(`grew ./clients/${target.name}: ${backend} (ir ${ir.irHash}${before && regenerated ? `, was ${before.ir}` : ""}), activations ${activations.join(", ")}`);
  return { target, backend, irHash: ir.irHash, activations, regenerated };
}

function readStamp(dir: string): { ir?: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "stamp.json"), "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ via the host (NEST-11)

/** A service reached through the host: imported as `./clients/<name>`, called at `path`. */
export interface ViaHost {
  /** The name the dendrite imports it by. */
  name: string;
  /** Its dotted path at the service that mounted the dendrite (`weather`, `dyn.peer.weather`). */
  path: string;
}

/** `PATH` or `NAME=PATH`, comma-separated: `--via-host weather,w2=dyn.peer.weather`. */
export function parseViaHost(spec: string): ViaHost[] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((one) => {
    const eq = one.indexOf("=");
    const [name, path] = eq < 0 ? [one.split(".").pop()!, one] : [one.slice(0, eq), one.slice(eq + 1)];
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error(`--via-host ${one}: the name \`${name}\` must be a word (NAME=PATH)`);
    if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(path)) throw new Error(`--via-host ${one}: \`${path}\` is not a dotted path`);
    return { name, path };
  });
}

/** A JSON schema's type, in TS. */
function jsonTs(s: any): string {
  const t = Array.isArray(s?.type) ? s.type.filter((x: string) => x !== "null")[0] : s?.type;
  if (t === "string") return "string";
  if (t === "integer" || t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "array") return `Array<${jsonTs(s.items)}>`;
  return "unknown";
}

/**
 * Grow toward a service through the host (`--via-host`): ask the host — on
 * the pipe, outside any call — for `<path>.schema` (its own view), and write
 * `<dendrite>/clients/<name>/index.ts`: one method per method, each called
 * back through the host under the call being served (host.ts).
 */
export async function growViaHost(dendrite: string, via: ViaHost, call: (method: string, params: unknown) => AsyncIterable<{ type: string; content?: any; message?: string }>): Promise<{ via: ViaHost; hash: string; methods: string[] }> {
  let schema: any = null;
  for await (const item of call(`${via.path}.schema`, {})) {
    if (item.type === "data") schema = item.content;
    if (item.type === "error") throw new Error(`--via-host ${via.path}: its schema: ${item.message ?? "refused"}`);
  }
  if (!schema || !Array.isArray(schema.methods)) throw new Error(`--via-host ${via.path}: the host answered no schema`);
  const methods = (schema.methods as any[]).filter((m) => (m.role?.kind ?? m.role ?? "rpc") === "rpc" && m.name !== "schema");
  const dir = join(dendrite, "clients", via.name);
  mkdirSync(dir, { recursive: true });
  const host = new URL("./host.ts", import.meta.url).pathname;
  const lines: string[] = [];
  lines.push(`// Grown by plexus-dendrite through its host from \`${via.path}\` (schema ${schema.hash ?? "?"}).`);
  lines.push(`// Regenerated at every start of the dendrite; never edit it.`);
  lines.push(`import { hostCall } from ${JSON.stringify(host)};`);
  lines.push("");
  lines.push(`/** What it was grown from: the path at the host and its schema's hash. */`);
  lines.push(`export const stamp = ${JSON.stringify({ via: via.path, schema: schema.hash ?? null })} as const;`);
  lines.push("");
  lines.push(`/** A call through the host, as the caller of the call being served: \`await\` it for every item as an array, or \`for await\` it as a stream. An \`error\` item throws. */`);
  lines.push(`export class Call<T> implements PromiseLike<T[]>, AsyncIterable<T> {`);
  lines.push(`  constructor(private method: string, private params: Record<string, unknown>) {}`);
  lines.push(`  async *[Symbol.asyncIterator](): AsyncIterator<T> {`);
  lines.push(`    for await (const item of hostCall(this.method, this.params)) {`);
  lines.push(`      if (item.type === "error") throw Object.assign(new Error(\`\${this.method}: \${item.message ?? "error"}\`), { kind: item.error_kind ?? (item as any).error?.kind });`);
  lines.push(`      if (item.type === "data") yield item.content as T;`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  async collect(): Promise<T[]> {`);
  lines.push(`    const out: T[] = [];`);
  lines.push(`    for await (const x of this) out.push(x);`);
  lines.push(`    return out;`);
  lines.push(`  }`);
  lines.push(`  then<A = T[], B = never>(ok?: ((v: T[]) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {`);
  lines.push(`    return this.collect().then(ok, err);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");
  lines.push(`/** \`${via.path}\` at the host. */`);
  lines.push(`export const ${tsIdent(via.name)} = {`);
  for (const m of methods) {
    const props = m.params?.properties ?? {};
    const required = new Set<string>(m.params?.required ?? []);
    const shape = Object.entries(props).map(([k, v]) => `${JSON.stringify(k)}${required.has(k) ? "" : "?"}: ${jsonTs(v)}`).join("; ");
    if (m.description) lines.push(`  /** ${String(m.description).replace(/\*\//g, "* /")} */`);
    lines.push(`  ${tsIdent(m.name)}(params: { ${shape} }${required.size ? "" : " = {}"}): Call<unknown> {`);
    lines.push(`    return new Call<unknown>(${JSON.stringify(`${via.path}.${m.name}`)}, params);`);
    lines.push(`  },`);
  }
  lines.push(`};`);
  writeFileSync(join(dir, "index.ts"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "stamp.json"), JSON.stringify({ via: via.path, schema: schema.hash ?? null }, null, 2) + "\n");
  log(`grew ./clients/${via.name} through the host: ${via.path} (schema ${schema.hash ?? "?"}), methods ${methods.map((m) => m.name).join(", ")}`);
  return { via, hash: String(schema.hash ?? ""), methods: methods.map((m) => m.name) };
}

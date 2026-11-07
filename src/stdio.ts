// A peer on stdio — a Plexus child in spec/12 terms (plexus-wire spec/11, spec/12): one JSON-RPC
// message per line in on stdin and out on stdout, `{ns}.call {method,
// params, hop}` opening a subscription whose items come back as `{ns}.call`
// notifications, `{ns}.call_unsub [sid]` letting go, EOF ending everything.
//
// The far side decides again (spec/12 rule 2): a call with no hop is
// `unauthenticated`; a hop admitted for another grant is `forbidden`.

import { createInterface } from "node:readline";
import { log } from "./log.ts";

export interface Hop {
  principal?: string;
  for?: string[];
  limit?: { grant?: string; held_on?: string[] } | null;
  call?: string;
}

/** What a method is handed besides its params. */
export interface Context {
  hop: Hop;
  /** Aborted when the caller lets go. */
  signal: AbortSignal;
}

export type Handler = (params: Record<string, unknown>, ctx: Context) => AsyncIterable<unknown> | Promise<unknown>;

export interface Served {
  ns: string;
  schema: () => Record<string, unknown>;
  methods: Map<string, Handler>;
}

const md = (ns: string) => ({ provenance: [ns], plexus_hash: "dendrite", timestamp: Math.floor(Date.now() / 1000) });

export async function serveStdio(s: Served): Promise<void> {
  const { ns } = s;
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n"); // one unit per message (spec/11)
  const item = (sid: number, it: unknown) => write({ jsonrpc: "2.0", method: `${ns}.call`, params: { subscription: sid, result: it } });
  const data = (sid: number, ct: string, content: unknown) => item(sid, { type: "data", metadata: md(ns), content_type: ct, content });
  const done = (sid: number) => item(sid, { type: "done", metadata: md(ns) });
  const error = (sid: number, code: string, message: string, kind?: string, extra: Record<string, unknown> = {}) =>
    item(sid, { type: "error", metadata: md(ns), message, code, recoverable: false, ...(kind ? { error_kind: kind } : {}), ...extra });

  let nextSid = 1;
  const live = new Map<number, AbortController>();

  async function run(sid: number, path: string, params: unknown, hop: unknown, ac: AbortController) {
    try {
      if (path === "_info") {
        data(sid, "_info", { backend: ns, auth_capabilities: { mechanisms: [{ kind: "anonymous" }] } });
        return done(sid);
      }
      const dot = path.indexOf(".");
      const [pns, m] = dot < 0 ? [path, ""] : [path.slice(0, dot), path.slice(dot + 1)];
      if (pns !== ns) return error(sid, "-32601", `Activation not found: ${pns}`);
      if (m === "schema") {
        const want = (params as any)?.method;
        const sc = s.schema();
        if (want) {
          const hit = (sc.methods as any[]).find((x) => x.name === want);
          if (!hit) return error(sid, "-32602", `Method '${want}' not found`, "invalid_params");
          data(sid, `${ns}.schema`, hit);
        } else data(sid, `${ns}.schema`, sc);
        return done(sid);
      }
      const h = s.methods.get(m);
      if (!h) return error(sid, "-32601", `Method not found: ${path}`);
      if (!hop || typeof hop !== "object") return error(sid, "-32001", "Authentication required: no hop", "unauthenticated");
      const grant = (hop as Hop).limit?.grant;
      if (grant != null && grant !== `${ns}.${m}`) {
        return error(sid, "-32003", `needs ${ns}.${m}; the hop was admitted for ${grant}`, "forbidden",
          { grant: `${ns}.${m}`, scope: "*", roles: ["viewer", "admin"], held_on: [] });
      }
      const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const out = h(p, { hop: hop as Hop, signal: ac.signal });
      if (out && typeof (out as any)[Symbol.asyncIterator] === "function") {
        const it = (out as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        ac.signal.addEventListener("abort", () => { void it.return?.(undefined); });
        while (!ac.signal.aborted) {
          const r = await it.next();
          if (r.done || ac.signal.aborted) break;
          data(sid, `${ns}.${m}`, r.value);
        }
      } else {
        const v = await out;
        if (!ac.signal.aborted && v !== undefined) data(sid, `${ns}.${m}`, v);
      }
      if (!ac.signal.aborted) done(sid);
    } catch (e) {
      if (!ac.signal.aborted) {
        log(`${path}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        error(sid, "-32000", `${path}: ${e instanceof Error ? e.message : String(e)}`, "execution");
      }
    } finally {
      live.delete(sid);
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const { id, method, params } = msg;
    if (method === "_info" || method === `${ns}.call`) {
      if (method !== "_info" && !(params && typeof params.method === "string")) {
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: method" } });
        continue;
      }
      const sid = nextSid++;
      write({ jsonrpc: "2.0", id, result: sid }); // the id before any item (spec/02)
      const ac = new AbortController();
      live.set(sid, ac);
      if (method === "_info") void run(sid, "_info", null, null, ac);
      else void run(sid, params.method, params.params, params.hop, ac);
    } else if (typeof method === "string" && method.endsWith("_unsub")) {
      const sid = Array.isArray(params) ? params[0] : undefined;
      const ac = live.get(sid);
      if (ac) {
        live.delete(sid);
        ac.abort();
      }
      write({ jsonrpc: "2.0", id, result: !!ac });
    } else if (id !== undefined && id !== null) {
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  }
  // EOF ends every call (spec/11).
  for (const ac of live.values()) ac.abort();
}

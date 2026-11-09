// The dendrite's service, called back on the pipe it was spawned on
// (NEST-11; plexus-wire spec/14 "A child calls its service back").
//
// Either side of a connection may open a call (spec/14). A child opens one
// into the service that mounted it with
//
//   {"jsonrpc":"2.0","id":N,"method":"_host.call","params":{"method":"weather.forecast","params":{…},"under":"<hop.call>"}}
//
// answered with a subscription id the service minted, then `_host.call`
// notifications carrying the call's items, the last terminal; letting go is
// `_host.call_unsub [sid]`. `under` names the call the dendrite is serving:
// the service routes the call through its own gate as that call's caller,
// within its reach, and ends it when that call ends. Outside a call only a
// schema is answered (`<path>.schema`), from the service's own view — what
// `--via-host` grows a client from at the start.
//
// The call a method is serving is found by AsyncLocalStorage: `stdio.ts`
// runs every method (and every step of its generator) inside `serving`, so a
// grown client called anywhere in the method's body names its call.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Pipe } from "./pipe.ts";

// One state per process, whichever way this module is loaded: a grown
// client in a directory with no `package.json` is loaded by tsx as CommonJS,
// a second instance of this module beside main's ESM one — both must see the
// same pipe, the same calls and the same `serving`.
interface State {
  serving: AsyncLocalStorage<{ call?: string }>;
  pipe: Pipe | null;
  nextId: number;
  pending: Map<number, { resolve: (sid: number) => void; reject: (e: Error) => void; sub: Sub }>;
  subs: Map<number, Sub>;
}
const KEY = Symbol.for("plexus-dendrite.host");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const st: State = (g[KEY] ??= { serving: new AsyncLocalStorage(), pipe: null, nextId: 1, pending: new Map(), subs: new Map() });

/** The call being served: its hop's `call` id. */
export const serving = st.serving;

export interface Item {
  type: string;
  content?: unknown;
  message?: string;
  error_kind?: string;
  [k: string]: unknown;
}

interface Sub {
  push(item: Item): void;
}

const { pending, subs } = st;

/** The pipe calls back go out on (main.ts, at start). */
export function attach(p: Pipe): void {
  st.pipe = p;
  p.onResponse = (msg) => {
    const open = pending.get(msg.id);
    if (!open) return; // an unsubscribe's answer, or one nobody waits for
    pending.delete(msg.id);
    if (msg.error) {
      const e = new HostError(msg.error.message ?? "refused", msg.error.data?.kind ?? msg.error.data?.error_kind, msg.error.code);
      open.reject(e);
    } else {
      subs.set(msg.result, open.sub);
      open.resolve(msg.result);
    }
  };
  p.onItem = (sid, item) => {
    const s = subs.get(sid);
    if (!s) return;
    if (item.type === "done" || item.type === "error") subs.delete(sid);
    s.push(item as Item);
  };
  p.onClose = () => {
    for (const [, o] of pending) o.reject(new HostError("the connection to the service closed", "child_unavailable"));
    pending.clear();
    for (const [, s] of subs) s.push({ type: "error", message: "the connection to the service closed", error_kind: "child_unavailable" });
    subs.clear();
  };
}

/** A refusal from the service, at the JSON-RPC layer or as an error item. */
export class HostError extends Error {
  constructor(message: string, readonly kind?: string, readonly code?: unknown) {
    super(message);
  }
}

/**
 * Call `method` (a dotted path at the service, e.g. `dyn.peer.weather.forecast`)
 * with `params`, under the call being served (or `under`), yielding every item
 * until the terminal one. Breaking out of the loop lets go of the call.
 */
export async function* hostCall(method: string, params: unknown, under = serving.getStore()?.call): AsyncGenerator<Item> {
  const pipe = st.pipe;
  if (!pipe) throw new HostError("this dendrite was not started on a pipe to its service");
  const queue: Item[] = [];
  let wake: (() => void) | null = null;
  const sub: Sub = { push: (i) => { queue.push(i); wake?.(); } };
  const id = st.nextId++;
  const opened = new Promise<number>((resolve, reject) => pending.set(id, { resolve, reject, sub }));
  pipe.write({ jsonrpc: "2.0", id, method: "_host.call", params: { method, params: params ?? {}, ...(under ? { under } : {}) } });
  const sid = await opened;
  let ended = false;
  try {
    for (;;) {
      while (queue.length) {
        const item = queue.shift()!;
        if (item.type === "done" || item.type === "error") ended = true;
        yield item;
        if (ended) return;
      }
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  } finally {
    if (!ended) {
      subs.delete(sid);
      pipe.write({ jsonrpc: "2.0", id: st.nextId++, method: "_host.call_unsub", params: [sid] });
    }
  }
}

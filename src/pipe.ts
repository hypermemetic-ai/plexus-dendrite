// The pipe a dendrite is spawned on: stdin in, stdout out, one JSON-RPC
// message per line (plexus-wire spec/11). It carries both directions of
// spec/14's symmetric connection, told apart by shape (spec/14 rule 2):
//
//   no `method`, an `id`                 an answer to a request of ours (a call back, host.ts)
//   `_host.call`, no `id`                an item of a call back of ours (host.ts)
//   anything else                        a request into the dendrite (stdio.ts)
//
// Requests that come before the dendrite serves (the service's `_info`, while
// it is still growing its clients over this pipe) wait, in order.

import { createInterface } from "node:readline";

export interface Pipe {
  write(msg: unknown): void;
  /** Answers to our requests (host.ts). */
  onResponse: (msg: any) => void;
  /** Items of our calls back (host.ts). */
  onItem: (sid: number, item: any) => void;
  /** stdin ended. */
  onClose: () => void;
  /** Serve requests: those that waited first, then each as it comes; resolves at EOF. */
  serve(handler: (msg: any) => void): Promise<void>;
}

export function openPipe(): Pipe {
  const waiting: any[] = [];
  let handler: ((msg: any) => void) | null = null;
  let closed = false;
  let onEof: (() => void) | null = null;
  const p: Pipe = {
    write: (msg) => process.stdout.write(JSON.stringify(msg) + "\n"), // one unit per message (spec/11)
    onResponse: () => {},
    onItem: () => {},
    onClose: () => {},
    serve(h) {
      handler = h;
      for (const m of waiting.splice(0)) h(m);
      return closed ? Promise.resolve() : new Promise<void>((r) => (onEof = r));
    },
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      p.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (typeof msg?.method !== "string" && msg?.id !== undefined && msg?.id !== null) return p.onResponse(msg);
    if (msg?.method === "_host.call" && (msg.id === undefined || msg.id === null)) {
      return p.onItem(msg.params?.subscription, msg.params?.result);
    }
    if (handler) handler(msg);
    else waiting.push(msg);
  });
  rl.on("close", () => {
    closed = true;
    p.onClose();
    onEof?.();
  });
  return p;
}

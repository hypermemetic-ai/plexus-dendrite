// The runtime as a service sees it: spawned on stdio, asked its _info and
// schema, called with a hop, let go of, ended by EOF (plexus-wire spec/11, 12).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSurface } from "../src/surface.ts";

const root = join(import.meta.dirname, "..");
const fixture = join(root, "test", "fixtures", "hello");
const hop = { principal: "service:test", for: ["key:ab"], limit: null, call: "t" };

test("the surface is read from index.ts", () => {
  const s = readSurface(join(fixture, "index.ts"));
  assert.deepEqual([...s.keys()].sort(), ["forever", "hello", "one"]);
  const hello = s.get("hello")!;
  assert.equal(hello.description, "Say hello, `times` times.");
  assert.equal(hello.streaming, true);
  assert.deepEqual(hello.params.map((p) => [p.name, p.schema.type, p.required]), [["name", "string", true], ["times", "number", false]]);
  assert.deepEqual(s.get("one")!.params.map((p) => [p.name, p.schema.type, p.schema.default]), [["x", "number", 1]]);
});

test("a child on stdio: _info, schema, calls, the hop decided again, unsubscribe, EOF", async () => {
  const p = spawn(join(root, "bin", "plexus-dendrite"), ["serve", fixture], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: p.stdout! })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value);
  let id = 0;
  const send = (m: unknown) => p.stdin!.write(JSON.stringify(m) + "\n");
  async function call(method: string, params: unknown, h: unknown = hop, upto = Infinity) {
    send({ jsonrpc: "2.0", id: ++id, method: "hello.call", params: { method, params, hop: h } });
    const opened = await next();
    assert.equal(opened.id, id);
    const items: any[] = [];
    for (;;) {
      const it = (await next()).params.result;
      items.push(it);
      if (it.type === "done" || it.type === "error" || items.length >= upto) return { sid: opened.result, items };
    }
  }

  send({ jsonrpc: "2.0", id: 0, method: "_info", params: null });
  await next();
  assert.equal((await next()).params.result.content.backend, "hello");
  await next();

  const sc = (await call("hello.schema", {}, { ...hop, for: [] })).items[0].content;
  assert.equal(sc.namespace, "hello");
  assert.deepEqual(sc.methods.map((m: any) => m.name), ["forever", "hello", "one"]);

  const h = await call("hello.hello", { name: "ada" });
  assert.deepEqual(h.items.map((i) => i.content?.said ?? i.type), ["hello, ada", "hello, ada", "done"]);
  assert.deepEqual((await call("hello.one", {})).items[0].content, { x: 1 });
  assert.equal((await call("hello.one", {}, null)).items[0].error_kind, "unauthenticated");
  assert.equal((await call("hello.one", {}, { ...hop, limit: { grant: "hello.hello", held_on: ["*"] } })).items[0].error_kind, "forbidden");

  const f = await call("hello.forever", {}, hop, 3);
  send({ jsonrpc: "2.0", id: ++id, method: "hello.call_unsub", params: [f.sid] });
  for (;;) {
    const m = await next();
    if (m.id === id) { assert.equal(m.result, true); break; }
  }
  p.stdin!.end();
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 0);
});

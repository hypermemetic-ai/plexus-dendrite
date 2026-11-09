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

// NEST-11: a dendrite grown --via-host asks its host for the schema on the
// pipe (outside any call), serves, and calls the host back under the call it
// serves; a refusal comes back as a thrown error with its kind.
test("--via-host: the schema asked over the pipe, calls made back under the call served", async () => {
  const relay = join(root, "test", "fixtures", "relay");
  const p = spawn(join(root, "bin", "plexus-dendrite"), ["serve", relay, "--via-host", "weather=svc.weather"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: p.stdout! })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value);
  const send = (m: unknown) => p.stdin!.write(JSON.stringify(m) + "\n");
  // The host's _info goes first; it waits while the dendrite grows.
  send({ jsonrpc: "2.0", id: 1, method: "_info", params: null });
  const ask = await next();
  assert.equal(ask.method, "_host.call");
  assert.equal(ask.params.method, "svc.weather.schema");
  assert.equal(ask.params.under, undefined, "outside any call");
  const schema = {
    namespace: "weather", version: "0.1.0", description: "w", hash: "h1",
    methods: [{ name: "forecast", description: "Days of rain.", role: { kind: "rpc" }, params: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
  };
  send({ jsonrpc: "2.0", id: ask.id, result: 1 });
  send({ jsonrpc: "2.0", method: "_host.call", params: { subscription: 1, result: { type: "data", content_type: "weather.schema", content: schema } } });
  send({ jsonrpc: "2.0", method: "_host.call", params: { subscription: 1, result: { type: "done" } } });
  assert.equal((await next()).id, 1, "then _info is answered");
  assert.equal((await next()).params.result.content.backend, "relay");
  await next();

  // A call: the dendrite calls back under its hop's call id.
  send({ jsonrpc: "2.0", id: 2, method: "relay.call", params: { method: "relay.ask", params: { city: "lisbon" }, hop: { ...hop, call: "c-42" } } });
  assert.equal((await next()).id, 2);
  const back = await next();
  assert.deepEqual([back.method, back.params.method, back.params.params, back.params.under], ["_host.call", "svc.weather.forecast", { city: "lisbon" }, "c-42"]);
  send({ jsonrpc: "2.0", id: back.id, result: 7 });
  for (const rain of [0.1, 0.9]) send({ jsonrpc: "2.0", method: "_host.call", params: { subscription: 7, result: { type: "data", content: { rain } } } });
  send({ jsonrpc: "2.0", method: "_host.call", params: { subscription: 7, result: { type: "done" } } });
  const got = [(await next()).params.result, (await next()).params.result, (await next()).params.result];
  assert.deepEqual(got.map((i) => i.content ?? i.type), [{ rain: 0.1 }, { rain: 0.9 }, "done"]);

  // A refusal at the JSON-RPC layer throws, with its kind.
  send({ jsonrpc: "2.0", id: 3, method: "relay.call", params: { method: "relay.refused", params: { city: "x" }, hop: { ...hop, call: "c-43" } } });
  assert.equal((await next()).id, 3);
  const b2 = await next();
  assert.equal(b2.params.under, "c-43");
  send({ jsonrpc: "2.0", id: b2.id, error: { code: -32003, message: "Forbidden: svc.weather.forecast", data: { kind: "forbidden" } } });
  assert.deepEqual((await next()).params.result.content.kind, "forbidden");
  await next();
  p.stdin!.end();
  assert.equal(await new Promise((r) => p.on("exit", r)), 0);
});

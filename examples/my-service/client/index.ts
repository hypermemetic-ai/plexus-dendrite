// @my-service/client — the app's client library.
//
// ./generated/ is written by synapse-cc from the running backend's schema
// (scripts/codegen.sh, in a container) and is never edited by hand: a
// renamed method or event field on the backend becomes a type error here
// and in the frontend after the next `npm run build`. This file is the
// hand-written part: one place that knows how to connect.

import { PlexusRpcClient } from './generated/transport';
import { createGreeterClient, type GreeterClient } from './generated/greeter';

export * from './generated/index';

/** The backend's service name — `SERVICE` in backend/src/lib.rs. */
export const BACKEND = 'my-service';

/** Where the backend listens by default — synapse.config.json's `url`. */
export const DEFAULT_URL = 'ws://127.0.0.1:4610';

/**
 * The backend's URL as the page that loaded this was told it. The service's
 * shell stamps, as it serves the entrypoint, the socket's full URL into
 * `<meta name="plexus-ws-url" content="{{WS_URL}}">` when the app is served
 * behind a reverse proxy (`--public-url`: `wss://<public host>/ws`), and its
 * WebSocket port into `<meta name="plexus-ws-port" content="{{WS_PORT}}">`
 * always (then `ws://127.0.0.1:<port>`). `undefined` when there is no such
 * page or it was not stamped (Vite's dev server serves the placeholders as
 * written) — then the caller's fallback.
 */
export function pageUrl(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '';
  const url = meta('plexus-ws-url');
  if (/^wss?:\/\//.test(url)) return url;
  const port = meta('plexus-ws-port');
  // The shell's WebSocket listens beside the shell, on loopback by default.
  return /^[0-9]+$/.test(port) ? `ws://127.0.0.1:${port}` : undefined;
}

export interface Backend {
  rpc: PlexusRpcClient;
  greeter: GreeterClient;
}

/**
 * Connect once and get a typed client per activation. Without a `url`: the
 * stamped page's ({@link pageUrl}), else {@link DEFAULT_URL}.
 */
export async function connect(url: string = pageUrl() ?? DEFAULT_URL): Promise<Backend> {
  const rpc = new PlexusRpcClient({ backend: BACKEND, url, connectionTimeout: 5000 });
  await rpc.connect();
  return { rpc, greeter: createGreeterClient(rpc) };
}

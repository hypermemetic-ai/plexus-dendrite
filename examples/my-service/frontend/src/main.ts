// The frontend: one connection, two calls, through the generated client.
import { connect, pageUrl, DEFAULT_URL, type Greeter } from '@my-service/client';

// Served by the service's shell, the page carries the WebSocket's port (stamped
// into index.html); under Vite's dev server it does not, and VITE_PLEXUS_URL
// or the backend's default port is used.
const url = pageUrl() ?? import.meta.env.VITE_PLEXUS_URL ?? DEFAULT_URL;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function show(el: HTMLElement, ev: Greeter.GreeterEvent) {
  if (ev.type === 'error') {
    el.textContent = ev.message;
    el.className = 'error';
  } else if (ev.type === 'greeting') {
    el.textContent = ev.message;
    el.className = '';
  }
}

async function main() {
  const { greeter } = await connect(url);
  $('status').textContent = `connected to ${url}`;

  $('hello').addEventListener('submit', async (e) => {
    e.preventDefault();
    for await (const ev of greeter.hello($<HTMLInputElement>('name').value)) show($('greeting'), ev);
  });

  $('count').addEventListener('click', async () => {
    const list = $('ticks');
    list.replaceChildren();
    for await (const ev of greeter.count(5)) {
      if (ev.type === 'tick') list.append(Object.assign(document.createElement('li'), { textContent: String(ev.n) }));
    }
  });
}

main().catch((err) => {
  $('status').textContent = `could not reach the backend at ${url}: ${err}`;
  $('status').className = 'error';
});

// The runtime's log: stderr only — on stdio, stdout carries frames and
// nothing else (spec/11).

export function log(msg: string): void {
  process.stderr.write(`plexus-dendrite: ${msg}\n`);
}

/** Say hello, `times` times. */
export async function* hello({ name, times = 2 }: { /** who to greet */ name: string; times?: number }) {
  for (let i = 0; i < times; i++) yield { said: `hello, ${name}` };
}

export async function one({ x = 1 }) {
  return { x };
}

export async function* forever() {
  for (let n = 0; ; n++) {
    yield { n };
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const notAMethod = 5;

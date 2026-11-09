// A dendrite that calls its host back: `weather` is grown --via-host.
import { weather } from "./clients/weather";

/** The forecast for `city`, through the host. */
export async function* ask({ city }: { city: string }) {
  for await (const day of weather.forecast({ city })) yield day;
}

/** One call refused by the host: its kind. */
export async function refused({ city }: { city: string }) {
  try {
    await weather.forecast({ city });
    return { kind: null };
  } catch (e) {
    return { kind: (e as { kind?: string }).kind ?? null, message: (e as Error).message };
  }
}

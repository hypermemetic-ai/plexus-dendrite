import { weather } from "./clients/weather"; // generated

export async function* do_thing({ city }) {
  const days = await weather.forecast({ city, days: 7 });
  yield { rain_days: days.filter((d) => d.rain > 0.5).length };
}

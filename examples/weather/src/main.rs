//! `weather` — the foreign service of VISION-4's film: a Plexus service a
//! dendrite grows toward. One activation, one method:
//!
//! ```text
//! weather.forecast { city, days } → a stream of day { date, rain }
//! ```
//!
//! served as the service `weather-service` (`synapse weather-service weather forecast …`).
//!
//! The data is deterministic per city (a hash of its name; `lisbon` has
//! exactly 3 of its first 7 days with rain > 0.5 mm), or open-meteo's
//! forecast with `--live`.
//!
//! ```text
//! weather --port 4601 [--live]
//! ```

use async_stream::stream;
use clap::Parser;
use futures::Stream;
use plexus_core::plexus::DynamicHub as DynamicService;
use plexus_transport::TransportServer;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The service's root name (what synapse and the registry call it). It
/// differs from the activation's, `weather`: a root shadows a like-named
/// activation (plexus-core, Z2H-8).
pub const SERVICE: &str = "weather-service";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ForecastEvent {
    /// One day of the forecast.
    Day {
        /// The day, `YYYY-MM-DD` (UTC).
        date: String,
        /// Rain that day, in millimetres.
        rain: f64,
    },
    /// A forecast refused, in band.
    Error { message: String },
}

#[derive(Clone, Default)]
pub struct ForecastActivation {
    live: bool,
}

#[plexus_macros::activation(namespace = "weather", description = "A weather forecast, day by day", crate_path = "plexus_core")]
impl ForecastActivation {
    /// `days` events, `day { date, rain }`, from today.
    #[plexus_macros::method(
        streaming,
        description = "The forecast for a city: one `day { date, rain }` per day, from today",
        params(city = "The city (lisbon, porto, berlin, …)", days = "How many days (1 to 16)")
    )]
    pub async fn forecast(&self, city: String, days: u32) -> impl Stream<Item = ForecastEvent> + Send + 'static {
        let live = self.live;
        stream! {
            let city = city.trim().to_lowercase();
            if city.is_empty() {
                yield ForecastEvent::Error { message: "city is empty".into() };
                return;
            }
            if !(1..=16).contains(&days) {
                yield ForecastEvent::Error { message: format!("days must be 1 to 16, not {days}") };
                return;
            }
            let rains = if live {
                match open_meteo(&city, days).await {
                    Ok(r) => r,
                    Err(e) => {
                        yield ForecastEvent::Error { message: format!("open-meteo: {e}") };
                        return;
                    }
                }
            } else {
                (0..days).map(|i| rain_for(&city, i)).collect()
            };
            for (i, rain) in rains.into_iter().enumerate() {
                yield ForecastEvent::Day { date: date_from_today(i as u64), rain };
            }
        }
    }
}

/// Deterministic rain for `city` on day `i`: FNV-1a over the name, the day
/// stepped by the golden ratio, mixed by splitmix64's finalizer, folded into
/// 0.0..=2.0 mm at one decimal. lisbon: 2.0 1.1 0.4 0.4 0.1 0.4 1.1.
pub fn rain_for(city: &str, i: u32) -> f64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in city.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let mut z = h.wrapping_add((i as u64).wrapping_mul(0x9e3779b97f4a7c15));
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^= z >> 31;
    (z % 21) as f64 / 10.0
}

/// `YYYY-MM-DD`, `i` days after today (UTC).
fn date_from_today(i: u64) -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86_400 + i) as i64;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// open-meteo: the city geocoded, then its daily precipitation sum (mm).
async fn open_meteo(city: &str, days: u32) -> anyhow::Result<Vec<f64>> {
    let http = reqwest::Client::new();
    let geo: serde_json::Value = http
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", city), ("count", "1")])
        .send()
        .await?
        .json()
        .await?;
    let place = geo["results"].get(0).ok_or_else(|| anyhow::anyhow!("no place named {city}"))?;
    let (lat, lon) = (place["latitude"].as_f64().unwrap_or(0.0), place["longitude"].as_f64().unwrap_or(0.0));
    let fc: serde_json::Value = http
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("daily", "precipitation_sum".into()),
            ("forecast_days", days.to_string()),
            ("timezone", "UTC".into()),
        ])
        .send()
        .await?
        .json()
        .await?;
    let sums = fc["daily"]["precipitation_sum"].as_array().ok_or_else(|| anyhow::anyhow!("no daily precipitation_sum"))?;
    Ok(sums.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect())
}

#[derive(Parser, Debug)]
#[command(name = "weather", about = "VISION-4's weather service")]
struct Args {
    /// WebSocket port (loopback).
    #[arg(short, long, default_value = "4601")]
    port: u16,
    /// The forecast from open-meteo, not the deterministic table.
    #[arg(long)]
    live: bool,
    /// Print the deterministic forecast for a city and exit.
    #[arg(long, value_name = "CITY")]
    table: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    if let Some(city) = args.table {
        for i in 0..7 {
            println!("{} {:.1}", date_from_today(i as u64), rain_for(&city.to_lowercase(), i));
        }
        return Ok(());
    }
    let service = Arc::new(DynamicService::new(SERVICE).register(ForecastActivation { live: args.live }));
    tracing::info!("weather on ws://127.0.0.1:{}{}", args.port, if args.live { " (live: open-meteo)" } else { "" });
    // Registered with the registry (PLEXUS_REGISTRY_URL) unless PLEXUS_NO_REGISTRY.
    TransportServer::builder(service, |h| Ok(DynamicService::arc_into_rpc_module(h)?))
        .with_websocket(args.port)
        .build()
        .await?
        .serve()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lisbon_has_three_rainy_days_in_seven() {
        let n = (0..7).filter(|&i| rain_for("lisbon", i) > 0.5).count();
        assert_eq!(n, 3);
    }
}

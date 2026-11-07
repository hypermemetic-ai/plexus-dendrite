//! The app's first activation. Replace it with yours; keep the shape:
//! every method returns a stream of one event enum, tagged by `type`, with
//! an in-band `Error` variant — that enum is what the generated TypeScript
//! client's types are made from.

use async_stream::stream;
use futures::Stream;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GreeterEvent {
    /// The answer to `hello`.
    Greeting { message: String },
    /// One step of `count`.
    Tick { n: u32 },
    /// A call the activation refused, in band.
    Error { message: String },
}

#[derive(Clone, Default)]
pub struct Greeter;

#[plexus_macros::activation(
    namespace = "greeter",
    description = "A greeting and a counted stream",
    crate_path = "plexus_core"
)]
impl Greeter {
    /// One event: `greeting { message }`.
    #[plexus_macros::method(
        description = "Greet someone",
        params(name = "Who to greet")
    )]
    pub async fn hello(&self, name: String) -> impl Stream<Item = GreeterEvent> + Send + 'static {
        stream! {
            let name = name.trim().to_string();
            if name.is_empty() {
                yield GreeterEvent::Error { message: "name is empty".into() };
            } else {
                yield GreeterEvent::Greeting { message: format!("Hello, {name}!") };
            }
        }
    }

    /// `to` events, `tick { n }` for n = 1..=to — a stream, to show that a
    /// method answers with as many events as it likes.
    #[plexus_macros::method(
        streaming,
        description = "Count from 1 to `to`, one event each",
        params(to = "How far to count (at most 1000)")
    )]
    pub async fn count(&self, to: u32) -> impl Stream<Item = GreeterEvent> + Send + 'static {
        stream! {
            if to > 1000 {
                yield GreeterEvent::Error { message: format!("{to} is more than 1000") };
                return;
            }
            for n in 1..=to {
                yield GreeterEvent::Tick { n };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[tokio::test]
    async fn hello_greets_and_refuses_an_empty_name() {
        let g = Greeter;
        let events: Vec<_> = g.hello("Ada".into()).await.collect().await;
        assert!(matches!(&events[..], [GreeterEvent::Greeting { message }] if message == "Hello, Ada!"));
        let events: Vec<_> = g.hello("  ".into()).await.collect().await;
        assert!(matches!(&events[..], [GreeterEvent::Error { .. }]));
    }

    #[tokio::test]
    async fn count_streams_one_tick_per_step() {
        let events: Vec<_> = Greeter.count(3).await.collect().await;
        let ns: Vec<u32> = events
            .iter()
            .map(|e| match e {
                GreeterEvent::Tick { n } => *n,
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(ns, [1, 2, 3]);
    }
}

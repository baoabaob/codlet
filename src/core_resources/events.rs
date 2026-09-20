use super::{
    OwnerKey, Result, ServiceError, bounded, bytes, decode, invalid, missing, name, token,
};
use crate::capabilities::{CapabilityDescriptor, CapabilityScope};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};

#[derive(Default)]
pub(super) struct Events {
    topics: BTreeMap<String, Topic>,
    subscriptions: BTreeMap<String, Subscription>,
}
struct Topic {
    owner: OwnerKey,
    name: String,
    capability: Option<CapabilityDescriptor>,
    sequence: u64,
    events: VecDeque<(u64, Value, usize)>,
    bytes: usize,
    max_events: usize,
    max_bytes: usize,
    closed: bool,
    provider_retired: bool,
}
struct Subscription {
    owner: OwnerKey,
    topic: String,
    acknowledged: u64,
    delivered: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    name: String,
    max_events: Option<usize>,
    max_bytes: Option<usize>,
    capability: Option<CapabilityDescriptor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Publish {
    topic: String,
    event: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Subscribe {
    topic: String,
    after: Option<String>,
    capability: Option<CapabilityDescriptor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    subscription: String,
    after: Option<String>,
    limit: Option<usize>,
    #[serde(default)]
    wait_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
    subscription: String,
    cursor: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Close {
    resource: String,
}

pub(super) fn invoke(
    store: &mut Events,
    owner: &OwnerKey,
    method: &str,
    params: Value,
) -> Result<Value> {
    invoke_for(store, owner, owner, method, params)
}

pub(super) fn invoke_for(
    store: &mut Events,
    owner: &OwnerKey,
    provider: &OwnerKey,
    method: &str,
    params: Value,
) -> Result<Value> {
    match method {
        "events.createTopic" => {
            let input: Create = decode(params)?;
            name(&input.name)?;
            if input
                .capability
                .as_ref()
                .is_some_and(|capability| capability.scope != CapabilityScope::Runtime)
            {
                return Err(invalid(
                    "shared event topic capabilities must use Runtime scope",
                ));
            }
            if store.topics.len() >= 128
                || store.topics.values().filter(|t| &t.owner == owner).count() >= 16
            {
                return Err(ServiceError::new(
                    "resource_limit",
                    "event topic limit reached",
                ));
            }
            if store
                .topics
                .values()
                .any(|t| &t.owner == owner && t.name == input.name && !t.closed)
            {
                return Err(ServiceError::new(
                    "resource_conflict",
                    "topic name already exists",
                ));
            }
            let max_events = bounded(input.max_events, 256, 1024)?;
            let max_bytes = bounded(input.max_bytes, 1024 * 1024, 1024 * 1024)?;
            let id = token()?;
            store.topics.insert(
                id.clone(),
                Topic {
                    owner: owner.clone(),
                    name: input.name,
                    capability: input.capability.clone(),
                    sequence: 0,
                    events: VecDeque::new(),
                    bytes: 0,
                    max_events,
                    max_bytes,
                    closed: false,
                    provider_retired: false,
                },
            );
            Ok(json!({
                "topic": id,
                "cursor": cursor(&id, 0),
                "scope": if input.capability.is_some() { "capability" } else { "owner" },
                "capability": input.capability,
                "maxEvents": max_events,
                "maxBytes": max_bytes
            }))
        }
        "events.publish" => {
            let input: Publish = decode(params)?;
            bytes(&input.event, 32 * 1024)?;
            let topic = store
                .topics
                .get_mut(&input.topic)
                .filter(|t| &t.owner == owner)
                .ok_or_else(missing)?;
            if topic.closed {
                return Err(ServiceError::new("resource_closed", "topic is closed"));
            }
            let size = serde_json::to_vec(&input.event)
                .map_err(|_| invalid("invalid event"))?
                .len();
            if size > topic.max_bytes {
                return Err(ServiceError::new(
                    "resource_limit",
                    "event exceeds topic byte limit",
                ));
            }
            let sequence = topic
                .sequence
                .checked_add(1)
                .ok_or_else(|| ServiceError::new("resource_limit", "topic sequence exhausted"))?;
            while topic.events.len() >= topic.max_events || topic.bytes + size > topic.max_bytes {
                if let Some((_, _, size)) = topic.events.pop_front() {
                    topic.bytes -= size;
                } else {
                    break;
                }
            }
            topic.sequence = sequence;
            topic.events.push_back((sequence, input.event, size));
            topic.bytes += size;
            Ok(json!({"cursor":cursor(&input.topic,sequence)}))
        }
        "events.subscribe" => {
            let input: Subscribe = decode(params)?;
            let topic = store
                .topics
                .get(&input.topic)
                .filter(|t| &t.owner == provider && !t.provider_retired)
                .ok_or_else(missing)?;
            let capability_matches = input.capability.as_ref() == topic.capability.as_ref();
            if (owner != provider && (!capability_matches || topic.capability.is_none()))
                || (owner == provider && input.capability.is_some() && !capability_matches)
            {
                // Do not reveal whether a guessed topic exists or which capability
                // it exports. Central admission independently validates requires.
                return Err(missing());
            }
            if store.subscriptions.len() >= 256
                || store
                    .subscriptions
                    .values()
                    .filter(|s| &s.owner == owner)
                    .count()
                    >= 32
            {
                return Err(ServiceError::new(
                    "resource_limit",
                    "subscription limit reached",
                ));
            }
            let after = input
                .after
                .as_deref()
                .map(|c| parse(c, &input.topic, topic.sequence))
                .transpose()?
                .unwrap_or(topic.sequence);
            let id = token()?;
            store.subscriptions.insert(
                id.clone(),
                Subscription {
                    owner: owner.clone(),
                    topic: input.topic.clone(),
                    acknowledged: after,
                    delivered: after,
                },
            );
            Ok(
                json!({"subscription":id,"cursor":cursor(&input.topic,after),"scope":if owner==provider{"owner"}else{"capability"}}),
            )
        }
        "events.read" => {
            let input: Read = decode(params)?;
            if input.wait_ms > 1000 {
                return Err(invalid("waitMs exceeds 1000"));
            }
            let limit = bounded(input.limit, 32, 64)?;
            let subscription = store
                .subscriptions
                .get_mut(&input.subscription)
                .filter(|s| &s.owner == owner)
                .ok_or_else(missing)?;
            let topic = store.topics.get(&subscription.topic).ok_or_else(missing)?;
            let after = input
                .after
                .as_deref()
                .map(|c| parse(c, &subscription.topic, topic.sequence))
                .transpose()?
                .unwrap_or(subscription.acknowledged);
            let first = topic
                .events
                .front()
                .map(|e| e.0)
                .unwrap_or(topic.sequence.saturating_add(1));
            let gap = after.saturating_add(1) < first;
            let mut last = after;
            let mut result = Vec::new();
            let mut response_bytes = 0;
            for (sequence, value, size) in topic.events.iter().filter(|e| e.0 > after).take(limit) {
                if response_bytes + size + 128 > 192 * 1024 {
                    break;
                }
                result.push(json!({"cursor":cursor(&subscription.topic,*sequence),"value":value}));
                response_bytes += size + 128;
                last = *sequence;
            }
            if topic.provider_retired {
                last = topic.sequence;
            }
            subscription.delivered = subscription.delivered.max(last);
            Ok(
                json!({"events":result,"cursor":cursor(&subscription.topic,last),"gap":gap,"terminal":if topic.provider_retired {Some("provider_retired")} else if topic.closed && last>=topic.sequence {Some("topic_closed")} else {None}}),
            )
        }
        "events.ack" => {
            let input: Ack = decode(params)?;
            let subscription = store
                .subscriptions
                .get_mut(&input.subscription)
                .filter(|s| &s.owner == owner)
                .ok_or_else(missing)?;
            let sequence = parse(&input.cursor, &subscription.topic, subscription.delivered)?;
            if sequence < subscription.acknowledged {
                return Err(invalid("acknowledgement cannot move backwards"));
            }
            subscription.acknowledged = sequence;
            Ok(json!({"acknowledged":true,"cursor":input.cursor}))
        }
        "events.close" => {
            let input: Close = decode(params)?;
            if store
                .subscriptions
                .get(&input.resource)
                .is_some_and(|s| &s.owner == owner)
            {
                store.subscriptions.remove(&input.resource);
            } else if let Some(topic) = store
                .topics
                .get_mut(&input.resource)
                .filter(|t| &t.owner == owner)
            {
                topic.closed = true;
                if !store
                    .subscriptions
                    .values()
                    .any(|s| s.topic == input.resource)
                {
                    store.topics.remove(&input.resource);
                }
            } else {
                return Err(missing());
            }
            store
                .topics
                .retain(|id, t| !t.closed || store.subscriptions.values().any(|s| &s.topic == id));
            Ok(json!({"closed":true}))
        }
        _ => Err(ServiceError::new(
            "method_not_found",
            "unknown events method",
        )),
    }
}
fn cursor(topic: &str, sequence: u64) -> String {
    format!("{topic}:{sequence}")
}
fn parse(value: &str, topic: &str, max: u64) -> Result<u64> {
    let (epoch, sequence) = value
        .rsplit_once(':')
        .ok_or_else(|| invalid("invalid event cursor"))?;
    let sequence = sequence
        .parse::<u64>()
        .map_err(|_| invalid("invalid cursor sequence"))?;
    if epoch != topic || sequence > max {
        return Err(ServiceError::new(
            "cursor_invalid",
            "cursor belongs to another topic or future event",
        ));
    }
    Ok(sequence)
}
impl Events {
    pub(super) fn retire(&mut self, owner: &OwnerKey) {
        self.subscriptions.retain(|_, s| &s.owner != owner);
        for topic in self.topics.values_mut().filter(|t| &t.owner == owner) {
            topic.closed = true;
            topic.provider_retired = true;
            topic.events.clear();
            topic.bytes = 0;
        }
        self.topics
            .retain(|id, t| !t.closed || self.subscriptions.values().any(|s| &s.topic == id));
    }
    pub(super) fn list(&self, owner: &OwnerKey) -> Vec<Value> {
        let mut entries:Vec<_>=self.topics.iter().filter(|(_,t)| &t.owner==owner).map(|(id,t)|json!({"id":id,"kind":"eventTopic","name":t.name,"capability":t.capability,"closed":t.closed,"bufferedEvents":t.events.len(),"bufferedBytes":t.bytes})).collect();
        entries.extend(
            self.subscriptions
                .iter()
                .filter(|(_, s)| &s.owner == owner)
                .map(|(id, _)| json!({"id":id,"kind":"eventSubscription"})),
        );
        entries
    }
}

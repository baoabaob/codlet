use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_CAPABILITY_NAME_BYTES: usize = 128;
const MAX_PROVIDER_ID_BYTES: usize = 128;
static NEXT_REGISTRY_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub struct CapabilityName(String);

impl CapabilityName {
    pub fn new(name: impl Into<String>) -> Result<Self, CapabilityValidationError> {
        let name = name.into();
        if valid_capability_name(&name) {
            Ok(Self(name))
        } else {
            Err(CapabilityValidationError::InvalidName(name))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for CapabilityName {
    type Error = CapabilityValidationError;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        Self::new(name)
    }
}

impl fmt::Display for CapabilityName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(try_from = "u32")]
pub struct ApiVersion(u32);

impl ApiVersion {
    pub fn new(version: u32) -> Result<Self, CapabilityValidationError> {
        if version == 0 {
            Err(CapabilityValidationError::InvalidApiVersion(version))
        } else {
            Ok(Self(version))
        }
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl TryFrom<u32> for ApiVersion {
    type Error = CapabilityValidationError;

    fn try_from(version: u32) -> Result<Self, Self::Error> {
        Self::new(version)
    }
}

impl fmt::Display for ApiVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityScope {
    Runtime,
    Target,
    BackendSession,
    Thread,
}

impl fmt::Display for CapabilityScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Runtime => "runtime",
            Self::Target => "target",
            Self::BackendSession => "backend-session",
            Self::Thread => "thread",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapabilityScopeInstance {
    Runtime,
    Target(String),
    BackendSession(String),
    Thread(String),
}

impl CapabilityScopeInstance {
    pub fn scope(&self) -> CapabilityScope {
        match self {
            Self::Runtime => CapabilityScope::Runtime,
            Self::Target(_) => CapabilityScope::Target,
            Self::BackendSession(_) => CapabilityScope::BackendSession,
            Self::Thread(_) => CapabilityScope::Thread,
        }
    }
}

impl fmt::Display for CapabilityScopeInstance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime => formatter.write_str("runtime"),
            Self::Target(id) => write!(formatter, "target:{id}"),
            Self::BackendSession(id) => write!(formatter, "backend-session:{id}"),
            Self::Thread(id) => write!(formatter, "thread:{id}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityDescriptor {
    pub name: CapabilityName,
    pub api: ApiVersion,
    pub scope: CapabilityScope,
}

impl CapabilityDescriptor {
    pub fn new(
        name: impl Into<String>,
        api: u32,
        scope: CapabilityScope,
    ) -> Result<Self, CapabilityValidationError> {
        Ok(Self {
            name: CapabilityName::new(name)?,
            api: ApiVersion::new(api)?,
            scope,
        })
    }
}

impl fmt::Display for CapabilityDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}@{} [{}]", self.name, self.api, self.scope)
    }
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum CapabilityValidationError {
    #[error("capability name is invalid: {0}")]
    InvalidName(String),
    #[error("capability api version must be a positive integer, got {0}")]
    InvalidApiVersion(u32),
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum CapabilityRegistryError {
    #[error("provider id is invalid: {0}")]
    InvalidProviderId(String),
    #[error("provider {provider_id} is already registered")]
    ProviderConflict { provider_id: String },
    #[error("provider {provider_id} generation must be positive, got {generation}")]
    InvalidGeneration {
        provider_id: String,
        generation: u64,
    },
    #[error("capability scope {scope} is already active")]
    ScopeAlreadyActive { scope: CapabilityScopeInstance },
    #[error(
        "capability {name} [{scope}] from provider {conflicting_provider} conflicts with provider {existing_provider}"
    )]
    CapabilityConflict {
        name: CapabilityName,
        scope: CapabilityScope,
        existing_provider: String,
        conflicting_provider: String,
    },
    #[error("provider {consumer} requires {requirement}, but no provider is registered")]
    MissingRequirement {
        consumer: String,
        requirement: CapabilityDescriptor,
    },
    #[error(
        "provider {consumer} requires {requirement}, but provider {provider} exposes api {provided_api}"
    )]
    VersionMismatch {
        consumer: String,
        provider: String,
        requirement: CapabilityDescriptor,
        provided_api: ApiVersion,
    },
    #[error("capability dependency cycle detected among providers {providers:?}")]
    DependencyCycle { providers: Vec<String> },
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum CapabilityAccessError {
    #[error(transparent)]
    Registry(#[from] CapabilityRegistryError),
    #[error("plugin {plugin_id} is not registered")]
    PluginNotRegistered { plugin_id: String },
    #[error("plugin {plugin_id} generation {requested} is stale; current generation is {current}")]
    StaleGeneration {
        plugin_id: String,
        requested: u64,
        current: u64,
    },
    #[error("plugin {consumer} did not declare requirement {requirement}")]
    UndeclaredRequirement {
        consumer: String,
        requirement: CapabilityDescriptor,
    },
    #[error("capability {requirement} cannot be resolved in scope {scope}")]
    ScopeMismatch {
        requirement: CapabilityDescriptor,
        scope: CapabilityScopeInstance,
    },
    #[error("capability scope {scope} is not active")]
    ScopeInactive { scope: CapabilityScopeInstance },
    #[error("capability principal for {consumer} in {scope} is stale")]
    StalePrincipal {
        consumer: String,
        scope: CapabilityScopeInstance,
    },
    #[error("capability lease for {consumer} using {requirement} in {scope} is stale")]
    StaleLease {
        consumer: String,
        requirement: CapabilityDescriptor,
        scope: CapabilityScopeInstance,
    },
    #[error("capability lease for {requirement} is not owned by principal {consumer}")]
    LeaseOwnerMismatch {
        consumer: String,
        requirement: CapabilityDescriptor,
    },
}

/// An opaque caller identity signed by the host.
///
/// Its registry, registration, scope epoch, and grants are private. Only the
/// trusted host can issue one.
///
/// ```compile_fail
/// use codlet::capabilities::CapabilityPrincipal;
///
/// let forged = CapabilityPrincipal(());
/// ```
#[derive(Clone, PartialEq, Eq)]
pub struct CapabilityPrincipal(CapabilityPrincipalFacts);

#[derive(Clone, PartialEq, Eq)]
struct CapabilityPrincipalFacts {
    registry_id: u64,
    consumer_id: String,
    consumer_generation: u64,
    consumer_registration: u64,
    scope: CapabilityScopeInstance,
    scope_generation: u64,
    grants: BTreeSet<String>,
}

impl CapabilityPrincipal {
    pub fn has_grant(&self, grant: &str) -> bool {
        self.0.grants.contains(grant)
    }
}

impl fmt::Debug for CapabilityPrincipal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CapabilityPrincipal(<opaque>)")
    }
}

/// An opaque resolved capability owned by one [`CapabilityPrincipal`].
///
/// ```compile_fail
/// use codlet::capabilities::CapabilityLease;
///
/// let forged = CapabilityLease(());
/// ```
#[derive(Clone, PartialEq, Eq)]
pub struct CapabilityLease(CapabilityLeaseFacts);

#[derive(Clone, PartialEq, Eq)]
struct CapabilityLeaseFacts {
    registry_id: u64,
    owner_consumer_id: String,
    owner_consumer_generation: u64,
    owner_consumer_registration: u64,
    owner_scope: CapabilityScopeInstance,
    owner_scope_generation: u64,
    provider_id: String,
    provider_generation: u64,
    provider_registration: u64,
    requirement: CapabilityDescriptor,
}

impl fmt::Debug for CapabilityLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CapabilityLease(<opaque>)")
    }
}

#[derive(Debug)]
pub struct CapabilityRegistry {
    registry_id: u64,
    registrations: BTreeMap<String, ProviderRegistration>,
    providers: BTreeMap<CapabilityKey, ProviderRecord>,
    active_scopes: BTreeMap<CapabilityScopeInstance, u64>,
    next_epoch: u64,
}

#[derive(Debug)]
struct ProviderRegistration {
    generation: u64,
    epoch: u64,
    provides: Vec<CapabilityDescriptor>,
    requires: Vec<CapabilityDescriptor>,
    grants: BTreeSet<String>,
}

#[derive(Debug)]
struct ProviderRecord {
    provider_id: String,
    provider_generation: u64,
    registration_epoch: u64,
    descriptor: CapabilityDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct CapabilityKey {
    name: CapabilityName,
    scope: CapabilityScope,
}

impl CapabilityKey {
    fn from_descriptor(descriptor: &CapabilityDescriptor) -> Self {
        Self {
            name: descriptor.name.clone(),
            scope: descriptor.scope,
        }
    }
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        Self {
            registry_id: allocate_registry_id(),
            registrations: BTreeMap::new(),
            providers: BTreeMap::new(),
            active_scopes: BTreeMap::new(),
            next_epoch: 0,
        }
    }

    /// Inspect current declarations already admitted by this registry. The
    /// borrowed view exposes neither authority tokens nor registration epochs.
    pub(crate) fn registered_providers(
        &self,
    ) -> impl Iterator<Item = (&str, u64, &[CapabilityDescriptor])> {
        self.registrations.iter().map(|(id, registration)| {
            (
                id.as_str(),
                registration.generation,
                registration.provides.as_slice(),
            )
        })
    }

    pub(crate) fn scope_is_active(&self, scope: &CapabilityScopeInstance) -> bool {
        self.active_scopes.contains_key(scope)
    }

    pub fn register_provider(
        &mut self,
        provider_id: &str,
        generation: u64,
        provides: &[CapabilityDescriptor],
        requires: &[CapabilityDescriptor],
        grants: &[String],
    ) -> Result<(), CapabilityRegistryError> {
        if !valid_provider_id(provider_id) {
            return Err(CapabilityRegistryError::InvalidProviderId(
                provider_id.to_owned(),
            ));
        }
        if self.registrations.contains_key(provider_id) {
            return Err(CapabilityRegistryError::ProviderConflict {
                provider_id: provider_id.to_owned(),
            });
        }
        if generation == 0 {
            return Err(CapabilityRegistryError::InvalidGeneration {
                provider_id: provider_id.to_owned(),
                generation,
            });
        }

        let mut incoming = BTreeSet::new();
        for descriptor in provides {
            let key = CapabilityKey::from_descriptor(descriptor);
            if !incoming.insert(key.clone()) {
                return Err(CapabilityRegistryError::CapabilityConflict {
                    name: key.name,
                    scope: key.scope,
                    existing_provider: provider_id.to_owned(),
                    conflicting_provider: provider_id.to_owned(),
                });
            }
            if let Some(existing) = self.providers.get(&key) {
                return Err(CapabilityRegistryError::CapabilityConflict {
                    name: key.name,
                    scope: key.scope,
                    existing_provider: existing.provider_id.clone(),
                    conflicting_provider: provider_id.to_owned(),
                });
            }
        }

        let registration_epoch = self.allocate_epoch();

        for descriptor in provides {
            self.providers.insert(
                CapabilityKey::from_descriptor(descriptor),
                ProviderRecord {
                    provider_id: provider_id.to_owned(),
                    provider_generation: generation,
                    registration_epoch,
                    descriptor: descriptor.clone(),
                },
            );
        }
        self.registrations.insert(
            provider_id.to_owned(),
            ProviderRegistration {
                generation,
                epoch: registration_epoch,
                provides: provides.to_vec(),
                requires: requires.to_vec(),
                grants: grants.iter().cloned().collect(),
            },
        );
        Ok(())
    }

    pub fn unregister_provider(
        &mut self,
        provider_id: &str,
    ) -> Result<bool, CapabilityRegistryError> {
        if !valid_provider_id(provider_id) {
            return Err(CapabilityRegistryError::InvalidProviderId(
                provider_id.to_owned(),
            ));
        }
        let Some(registration) = self.registrations.remove(provider_id) else {
            return Ok(false);
        };
        for descriptor in registration.provides {
            self.providers
                .remove(&CapabilityKey::from_descriptor(&descriptor));
        }
        Ok(true)
    }

    pub fn activate_scope(
        &mut self,
        scope: CapabilityScopeInstance,
    ) -> Result<u64, CapabilityRegistryError> {
        if self.active_scopes.contains_key(&scope) {
            return Err(CapabilityRegistryError::ScopeAlreadyActive { scope });
        }
        let generation = self.allocate_epoch();
        self.active_scopes.insert(scope, generation);
        Ok(generation)
    }

    pub fn deactivate_scope(&mut self, scope: &CapabilityScopeInstance) -> bool {
        self.active_scopes.remove(scope).is_some()
    }

    pub(crate) fn issue_principal(
        &self,
        consumer_id: &str,
        consumer_generation: u64,
        scope: &CapabilityScopeInstance,
    ) -> Result<CapabilityPrincipal, CapabilityAccessError> {
        let consumer = self.registrations.get(consumer_id).ok_or_else(|| {
            CapabilityAccessError::PluginNotRegistered {
                plugin_id: consumer_id.to_owned(),
            }
        })?;
        if consumer.generation != consumer_generation {
            return Err(CapabilityAccessError::StaleGeneration {
                plugin_id: consumer_id.to_owned(),
                requested: consumer_generation,
                current: consumer.generation,
            });
        }
        let scope_generation = self.active_scopes.get(scope).copied().ok_or_else(|| {
            CapabilityAccessError::ScopeInactive {
                scope: scope.clone(),
            }
        })?;

        Ok(CapabilityPrincipal(CapabilityPrincipalFacts {
            registry_id: self.registry_id,
            consumer_id: consumer_id.to_owned(),
            consumer_generation,
            consumer_registration: consumer.epoch,
            scope: scope.clone(),
            scope_generation,
            grants: consumer.grants.clone(),
        }))
    }

    pub(crate) fn resolve_capability(
        &self,
        principal: &CapabilityPrincipal,
        requirement: &CapabilityDescriptor,
    ) -> Result<CapabilityLease, CapabilityAccessError> {
        if !self.principal_is_current(principal) {
            let facts = &principal.0;
            return Err(CapabilityAccessError::StalePrincipal {
                consumer: facts.consumer_id.clone(),
                scope: facts.scope.clone(),
            });
        }
        let facts = &principal.0;
        let consumer = self
            .registrations
            .get(&facts.consumer_id)
            .expect("a current principal must name a registered plugin");
        if !consumer.requires.contains(requirement) {
            return Err(CapabilityAccessError::UndeclaredRequirement {
                consumer: facts.consumer_id.clone(),
                requirement: requirement.clone(),
            });
        }
        if facts.scope.scope() != requirement.scope {
            return Err(CapabilityAccessError::ScopeMismatch {
                requirement: requirement.clone(),
                scope: facts.scope.clone(),
            });
        }
        let provider = self.provider_for_requirement(&facts.consumer_id, requirement)?;
        Ok(CapabilityLease(CapabilityLeaseFacts {
            registry_id: self.registry_id,
            owner_consumer_id: facts.consumer_id.clone(),
            owner_consumer_generation: facts.consumer_generation,
            owner_consumer_registration: facts.consumer_registration,
            owner_scope: facts.scope.clone(),
            owner_scope_generation: facts.scope_generation,
            provider_id: provider.provider_id.clone(),
            provider_generation: provider.provider_generation,
            provider_registration: provider.registration_epoch,
            requirement: requirement.clone(),
        }))
    }

    pub(crate) fn invoke<R>(
        &self,
        principal: &CapabilityPrincipal,
        lease: &CapabilityLease,
        invoke: impl FnOnce() -> R,
    ) -> Result<R, CapabilityAccessError> {
        if !self.principal_is_current(principal) {
            let facts = &principal.0;
            return Err(CapabilityAccessError::StalePrincipal {
                consumer: facts.consumer_id.clone(),
                scope: facts.scope.clone(),
            });
        }
        if !lease.is_owned_by(principal) {
            return Err(CapabilityAccessError::LeaseOwnerMismatch {
                consumer: principal.0.consumer_id.clone(),
                requirement: lease.0.requirement.clone(),
            });
        }
        if !self.lease_is_current(lease) {
            let facts = &lease.0;
            return Err(CapabilityAccessError::StaleLease {
                consumer: facts.owner_consumer_id.clone(),
                requirement: facts.requirement.clone(),
                scope: facts.owner_scope.clone(),
            });
        }
        Ok(invoke())
    }

    /// Validates a renderer endpoint call and exposes only the internal
    /// provider identity needed by the host router while the validation
    /// borrow is held. The closure is never run for a stale principal,
    /// lease, provider registration, generation, or scope.
    pub(crate) fn invoke_endpoint<R>(
        &self,
        principal: &CapabilityPrincipal,
        lease: &CapabilityLease,
        invoke: impl FnOnce(&str, &CapabilityDescriptor) -> R,
    ) -> Result<R, CapabilityAccessError> {
        if !self.principal_is_current(principal) {
            let facts = &principal.0;
            return Err(CapabilityAccessError::StalePrincipal {
                consumer: facts.consumer_id.clone(),
                scope: facts.scope.clone(),
            });
        }
        if !lease.is_owned_by(principal) {
            return Err(CapabilityAccessError::LeaseOwnerMismatch {
                consumer: principal.0.consumer_id.clone(),
                requirement: lease.0.requirement.clone(),
            });
        }
        if !self.lease_is_current(lease) {
            let facts = &lease.0;
            return Err(CapabilityAccessError::StaleLease {
                consumer: facts.owner_consumer_id.clone(),
                requirement: facts.requirement.clone(),
                scope: facts.owner_scope.clone(),
            });
        }
        let facts = &lease.0;
        Ok(invoke(&facts.provider_id, &facts.requirement))
    }

    pub fn resolve_activation_order(&self) -> Result<Vec<String>, CapabilityRegistryError> {
        let mut dependents: BTreeMap<String, BTreeSet<String>> = self
            .registrations
            .keys()
            .map(|provider| (provider.clone(), BTreeSet::new()))
            .collect();
        let mut dependency_count: BTreeMap<String, usize> = self
            .registrations
            .keys()
            .map(|provider| (provider.clone(), 0))
            .collect();

        for (consumer, registration) in &self.registrations {
            for requirement in &registration.requires {
                let provider = self.provider_for_requirement(consumer, requirement)?;
                if dependents
                    .get_mut(&provider.provider_id)
                    .expect("registered capability provider must have a dependency node")
                    .insert(consumer.clone())
                {
                    *dependency_count
                        .get_mut(consumer)
                        .expect("registered consumer must have a dependency count") += 1;
                }
            }
        }

        let mut ready: BTreeSet<String> = dependency_count
            .iter()
            .filter(|(_, count)| **count == 0)
            .map(|(provider, _)| provider.clone())
            .collect();
        let mut order = Vec::with_capacity(self.registrations.len());
        while let Some(provider) = ready.pop_first() {
            order.push(provider.clone());
            for consumer in dependents
                .get(&provider)
                .expect("registered provider must have a dependent set")
            {
                let count = dependency_count
                    .get_mut(consumer)
                    .expect("registered consumer must have a dependency count");
                *count -= 1;
                if *count == 0 {
                    ready.insert(consumer.clone());
                }
            }
        }

        if order.len() != self.registrations.len() {
            return Err(CapabilityRegistryError::DependencyCycle {
                providers: find_dependency_cycle(&dependents),
            });
        }
        Ok(order)
    }

    fn provider_for_requirement(
        &self,
        consumer: &str,
        requirement: &CapabilityDescriptor,
    ) -> Result<&ProviderRecord, CapabilityRegistryError> {
        let Some(provider) = self
            .providers
            .get(&CapabilityKey::from_descriptor(requirement))
        else {
            return Err(CapabilityRegistryError::MissingRequirement {
                consumer: consumer.to_owned(),
                requirement: requirement.clone(),
            });
        };
        if provider.descriptor.api != requirement.api {
            return Err(CapabilityRegistryError::VersionMismatch {
                consumer: consumer.to_owned(),
                provider: provider.provider_id.clone(),
                requirement: requirement.clone(),
                provided_api: provider.descriptor.api,
            });
        }
        Ok(provider)
    }

    fn principal_is_current(&self, principal: &CapabilityPrincipal) -> bool {
        let facts = &principal.0;
        facts.registry_id == self.registry_id
            && self.active_scopes.get(&facts.scope) == Some(&facts.scope_generation)
            && self
                .registrations
                .get(&facts.consumer_id)
                .is_some_and(|consumer| {
                    consumer.generation == facts.consumer_generation
                        && consumer.epoch == facts.consumer_registration
                        && consumer.grants == facts.grants
                })
    }

    fn lease_is_current(&self, lease: &CapabilityLease) -> bool {
        let facts = &lease.0;
        facts.registry_id == self.registry_id
            && self.active_scopes.get(&facts.owner_scope) == Some(&facts.owner_scope_generation)
            && self
                .registrations
                .get(&facts.owner_consumer_id)
                .is_some_and(|consumer| {
                    consumer.generation == facts.owner_consumer_generation
                        && consumer.epoch == facts.owner_consumer_registration
                        && consumer.requires.contains(&facts.requirement)
                })
            && self
                .providers
                .get(&CapabilityKey::from_descriptor(&facts.requirement))
                .is_some_and(|provider| {
                    provider.provider_id == facts.provider_id
                        && provider.provider_generation == facts.provider_generation
                        && provider.registration_epoch == facts.provider_registration
                        && provider.descriptor == facts.requirement
                })
    }

    fn allocate_epoch(&mut self) -> u64 {
        self.next_epoch = self
            .next_epoch
            .checked_add(1)
            .expect("capability principal epoch overflowed");
        self.next_epoch
    }
}

impl Default for CapabilityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CapabilityLease {
    fn is_owned_by(&self, principal: &CapabilityPrincipal) -> bool {
        let lease = &self.0;
        let owner = &principal.0;
        lease.registry_id == owner.registry_id
            && lease.owner_consumer_id == owner.consumer_id
            && lease.owner_consumer_generation == owner.consumer_generation
            && lease.owner_consumer_registration == owner.consumer_registration
            && lease.owner_scope == owner.scope
            && lease.owner_scope_generation == owner.scope_generation
    }
}

fn allocate_registry_id() -> u64 {
    NEXT_REGISTRY_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .expect("capability registry id overflowed")
}

fn find_dependency_cycle(graph: &BTreeMap<String, BTreeSet<String>>) -> Vec<String> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Visit {
        Active,
        Complete,
    }

    fn visit(
        provider: &str,
        graph: &BTreeMap<String, BTreeSet<String>>,
        states: &mut BTreeMap<String, Visit>,
        stack: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        states.insert(provider.to_owned(), Visit::Active);
        stack.push(provider.to_owned());
        for dependent in graph
            .get(provider)
            .expect("registered provider must have a dependent set")
        {
            match states.get(dependent) {
                Some(Visit::Active) => {
                    let start = stack
                        .iter()
                        .position(|entry| entry == dependent)
                        .expect("active dependency must be present in the DFS stack");
                    return Some(stack[start..].to_vec());
                }
                Some(Visit::Complete) => {}
                None => {
                    if let Some(cycle) = visit(dependent, graph, states, stack) {
                        return Some(cycle);
                    }
                }
            }
        }
        stack.pop();
        states.insert(provider.to_owned(), Visit::Complete);
        None
    }

    let mut states = BTreeMap::new();
    let mut stack = Vec::new();
    for provider in graph.keys() {
        if !states.contains_key(provider)
            && let Some(cycle) = visit(provider, graph, &mut states, &mut stack)
        {
            return cycle;
        }
    }
    unreachable!("topological sorting detected a cycle but DFS did not find one")
}

fn valid_capability_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_CAPABILITY_NAME_BYTES
        && name.is_ascii()
        && bytes
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'/' | b'-'))
        && bytes
            .windows(2)
            .all(|pair| pair[0].is_ascii_alphanumeric() || pair[1].is_ascii_alphanumeric())
}

fn valid_provider_id(provider_id: &str) -> bool {
    !provider_id.is_empty()
        && provider_id.len() <= MAX_PROVIDER_ID_BYTES
        && provider_id.is_ascii()
        && provider_id.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability(name: &str, api: u32, scope: CapabilityScope) -> CapabilityDescriptor {
        CapabilityDescriptor::new(name, api, scope).unwrap()
    }

    #[test]
    fn resolves_exact_requirements_and_orders_provider_before_consumer() {
        let shared = capability("runtime.storage", 1, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider("dev.provider", 1, std::slice::from_ref(&shared), &[], &[])
            .unwrap();
        registry
            .register_provider("dev.consumer", 1, &[], std::slice::from_ref(&shared), &[])
            .unwrap();

        assert_eq!(
            registry.resolve_activation_order().unwrap(),
            ["dev.provider", "dev.consumer"]
        );
    }

    #[test]
    fn rejects_provider_id_and_capability_conflicts() {
        let first = capability("runtime.storage", 1, CapabilityScope::Runtime);
        let second = capability("runtime.storage", 2, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        assert!(matches!(
            registry.register_provider("Invalid Provider", 1, &[], &[], &[]),
            Err(CapabilityRegistryError::InvalidProviderId(_))
        ));
        registry
            .register_provider("dev.first", 1, std::slice::from_ref(&first), &[], &[])
            .unwrap();
        assert!(matches!(
            registry.register_provider("dev.first", 1, &[], &[], &[]),
            Err(CapabilityRegistryError::ProviderConflict { provider_id })
                if provider_id == "dev.first"
        ));
        assert!(matches!(
            registry.register_provider("dev.second", 1, &[second], &[], &[]),
            Err(CapabilityRegistryError::CapabilityConflict {
                existing_provider,
                conflicting_provider,
                ..
            }) if existing_provider == "dev.first" && conflicting_provider == "dev.second"
        ));
    }

    #[test]
    fn failed_registration_leaves_registry_unchanged() {
        let occupied = capability("runtime.occupied", 1, CapabilityScope::Runtime);
        let available = capability("runtime.available", 1, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider("dev.first", 1, std::slice::from_ref(&occupied), &[], &[])
            .unwrap();

        assert!(matches!(
            registry.register_provider("dev.failed", 1, &[available.clone(), occupied], &[], &[],),
            Err(CapabilityRegistryError::CapabilityConflict { .. })
        ));
        registry
            .register_provider("dev.next", 1, std::slice::from_ref(&available), &[], &[])
            .unwrap();
        assert_eq!(
            registry.resolve_activation_order().unwrap(),
            ["dev.first", "dev.next"]
        );
    }

    #[test]
    fn reports_missing_requirement() {
        let requirement = capability("runtime.missing", 1, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider(
                "dev.consumer",
                1,
                &[],
                std::slice::from_ref(&requirement),
                &[],
            )
            .unwrap();

        assert_eq!(
            registry.resolve_activation_order(),
            Err(CapabilityRegistryError::MissingRequirement {
                consumer: "dev.consumer".to_owned(),
                requirement,
            })
        );
    }

    #[test]
    fn reports_exact_api_version_mismatch() {
        let provided = capability("runtime.storage", 1, CapabilityScope::Runtime);
        let required = capability("runtime.storage", 2, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider("dev.provider", 1, std::slice::from_ref(&provided), &[], &[])
            .unwrap();
        registry
            .register_provider("dev.consumer", 1, &[], std::slice::from_ref(&required), &[])
            .unwrap();

        assert_eq!(
            registry.resolve_activation_order(),
            Err(CapabilityRegistryError::VersionMismatch {
                consumer: "dev.consumer".to_owned(),
                provider: "dev.provider".to_owned(),
                requirement: required,
                provided_api: provided.api,
            })
        );
    }

    #[test]
    fn rejects_multi_provider_dependency_cycle() {
        let first = capability("runtime.first", 1, CapabilityScope::Runtime);
        let second = capability("runtime.second", 1, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider(
                "dev.first",
                1,
                std::slice::from_ref(&first),
                std::slice::from_ref(&second),
                &[],
            )
            .unwrap();
        registry
            .register_provider(
                "dev.second",
                1,
                std::slice::from_ref(&second),
                std::slice::from_ref(&first),
                &[],
            )
            .unwrap();

        assert_eq!(
            registry.resolve_activation_order(),
            Err(CapabilityRegistryError::DependencyCycle {
                providers: vec!["dev.first".to_owned(), "dev.second".to_owned()],
            })
        );
    }

    #[test]
    fn treats_self_dependency_as_a_cycle() {
        let own = capability("runtime.own", 1, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider(
                "dev.self",
                1,
                std::slice::from_ref(&own),
                std::slice::from_ref(&own),
                &[],
            )
            .unwrap();

        assert_eq!(
            registry.resolve_activation_order(),
            Err(CapabilityRegistryError::DependencyCycle {
                providers: vec!["dev.self".to_owned()],
            })
        );
    }

    #[test]
    fn activation_order_is_deterministic_across_registration_order() {
        let shared = capability("runtime.shared", 1, CapabilityScope::Runtime);
        let build = |registration_order: [&str; 3]| {
            let mut registry = CapabilityRegistry::new();
            for provider in registration_order {
                match provider {
                    "dev.z-provider" => registry
                        .register_provider(provider, 1, std::slice::from_ref(&shared), &[], &[])
                        .unwrap(),
                    "dev.b-consumer" => registry
                        .register_provider(provider, 1, &[], std::slice::from_ref(&shared), &[])
                        .unwrap(),
                    "dev.a-independent" => registry
                        .register_provider(provider, 1, &[], &[], &[])
                        .unwrap(),
                    _ => unreachable!(),
                }
            }
            registry.resolve_activation_order().unwrap()
        };

        let expected = ["dev.a-independent", "dev.z-provider", "dev.b-consumer"];
        assert_eq!(
            build(["dev.z-provider", "dev.b-consumer", "dev.a-independent"]),
            expected
        );
        assert_eq!(
            build(["dev.a-independent", "dev.b-consumer", "dev.z-provider"]),
            expected
        );
    }

    #[test]
    fn unregister_makes_consumers_unresolved() {
        let shared = capability("runtime.storage", 1, CapabilityScope::Runtime);
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider("dev.provider", 1, std::slice::from_ref(&shared), &[], &[])
            .unwrap();
        registry
            .register_provider("dev.consumer", 1, &[], std::slice::from_ref(&shared), &[])
            .unwrap();
        assert!(registry.resolve_activation_order().is_ok());

        assert!(registry.unregister_provider("dev.provider").unwrap());
        assert!(matches!(
            registry.resolve_activation_order(),
            Err(CapabilityRegistryError::MissingRequirement { consumer, .. })
                if consumer == "dev.consumer"
        ));
    }

    fn registered_pair(
        scope: CapabilityScope,
        consumer_id: &str,
        grants: &[String],
    ) -> (
        CapabilityRegistry,
        CapabilityDescriptor,
        CapabilityScopeInstance,
    ) {
        let shared = capability("runtime.storage", 1, scope);
        let scope = match scope {
            CapabilityScope::Runtime => CapabilityScopeInstance::Runtime,
            CapabilityScope::Target => CapabilityScopeInstance::Target("target-1".to_owned()),
            CapabilityScope::BackendSession => {
                CapabilityScopeInstance::BackendSession("backend-1".to_owned())
            }
            CapabilityScope::Thread => CapabilityScopeInstance::Thread("thread-1".to_owned()),
        };
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider("dev.provider", 1, std::slice::from_ref(&shared), &[], &[])
            .unwrap();
        registry
            .register_provider(consumer_id, 1, &[], std::slice::from_ref(&shared), grants)
            .unwrap();
        registry.activate_scope(scope.clone()).unwrap();
        (registry, shared, scope)
    }

    #[test]
    fn principal_and_lease_are_opaque_and_grants_come_from_registration() {
        let grants = ["ui.dom".to_owned(), "host.process".to_owned()];
        let (registry, shared, scope) =
            registered_pair(CapabilityScope::Runtime, "dev.consumer", &grants);
        let principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let lease = registry.resolve_capability(&principal, &shared).unwrap();

        assert_eq!(format!("{principal:?}"), "CapabilityPrincipal(<opaque>)");
        assert_eq!(format!("{lease:?}"), "CapabilityLease(<opaque>)");
        assert!(principal.has_grant("ui.dom"));
        assert!(principal.has_grant("host.process"));
        assert!(!principal.has_grant("cdp.raw"));
        let mut invocations = 0;
        registry
            .invoke(&principal, &lease, || invocations += 1)
            .unwrap();
        assert_eq!(invocations, 1);
    }

    #[test]
    fn endpoint_invocation_never_runs_after_scope_revocation() {
        let (mut registry, shared, scope) =
            registered_pair(CapabilityScope::Target, "dev.consumer", &[]);
        let principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let lease = registry.resolve_capability(&principal, &shared).unwrap();
        assert!(registry.deactivate_scope(&scope));

        let mut invocations = 0;
        assert!(matches!(
            registry.invoke_endpoint(&principal, &lease, |_, _| invocations += 1),
            Err(CapabilityAccessError::StalePrincipal { .. })
        ));
        assert_eq!(invocations, 0);
    }

    #[test]
    fn endpoint_invocation_never_runs_after_provider_reregistration() {
        let (mut registry, shared, scope) =
            registered_pair(CapabilityScope::Target, "dev.consumer", &[]);
        let principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let old_lease = registry.resolve_capability(&principal, &shared).unwrap();
        registry.unregister_provider("dev.provider").unwrap();
        registry
            .register_provider("dev.provider", 2, std::slice::from_ref(&shared), &[], &[])
            .unwrap();

        let mut invocations = 0;
        assert!(matches!(
            registry.invoke_endpoint(&principal, &old_lease, |_, _| invocations += 1),
            Err(CapabilityAccessError::StaleLease { .. })
        ));
        assert_eq!(invocations, 0);
    }

    #[test]
    fn structurally_identical_registries_never_accept_each_others_tokens() {
        let (first, shared, first_scope) =
            registered_pair(CapabilityScope::Runtime, "dev.consumer", &[]);
        let (second, _, second_scope) =
            registered_pair(CapabilityScope::Runtime, "dev.consumer", &[]);
        let first_principal = first
            .issue_principal("dev.consumer", 1, &first_scope)
            .unwrap();
        let first_lease = first.resolve_capability(&first_principal, &shared).unwrap();
        let second_principal = second
            .issue_principal("dev.consumer", 1, &second_scope)
            .unwrap();
        let mut invocations = 0;

        assert!(matches!(
            second.invoke(&first_principal, &first_lease, || invocations += 1),
            Err(CapabilityAccessError::StalePrincipal { .. })
        ));
        assert!(matches!(
            second.invoke(&second_principal, &first_lease, || invocations += 1),
            Err(CapabilityAccessError::LeaseOwnerMismatch { .. })
        ));
        assert_eq!(invocations, 0);
    }

    #[test]
    fn lease_theft_by_another_plugin_is_rejected_before_action_runs() {
        let (mut registry, shared, scope) =
            registered_pair(CapabilityScope::Runtime, "dev.consumer", &[]);
        registry
            .register_provider("dev.other", 1, &[], std::slice::from_ref(&shared), &[])
            .unwrap();
        let owner = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let lease = registry.resolve_capability(&owner, &shared).unwrap();
        let thief = registry.issue_principal("dev.other", 1, &scope).unwrap();
        let mut invocations = 0;

        assert!(matches!(
            registry.invoke(&thief, &lease, || invocations += 1),
            Err(CapabilityAccessError::LeaseOwnerMismatch { .. })
        ));
        assert_eq!(invocations, 0);
    }

    #[test]
    fn lease_from_another_target_is_rejected_before_action_runs() {
        let (mut registry, shared, first_scope) =
            registered_pair(CapabilityScope::Target, "dev.consumer", &[]);
        let second_scope = CapabilityScopeInstance::Target("target-2".to_owned());
        registry.activate_scope(second_scope.clone()).unwrap();
        let first = registry
            .issue_principal("dev.consumer", 1, &first_scope)
            .unwrap();
        let first_lease = registry.resolve_capability(&first, &shared).unwrap();
        let second = registry
            .issue_principal("dev.consumer", 1, &second_scope)
            .unwrap();
        let mut invocations = 0;

        assert!(matches!(
            registry.invoke(&second, &first_lease, || invocations += 1),
            Err(CapabilityAccessError::LeaseOwnerMismatch { .. })
        ));
        assert_eq!(invocations, 0);
    }

    #[test]
    fn consumer_reregistration_revokes_its_principal_and_lease() {
        let (mut registry, shared, scope) =
            registered_pair(CapabilityScope::Runtime, "dev.consumer", &[]);
        let old_principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let old_lease = registry
            .resolve_capability(&old_principal, &shared)
            .unwrap();
        registry.unregister_provider("dev.consumer").unwrap();
        registry
            .register_provider(
                "dev.consumer",
                1,
                &[],
                std::slice::from_ref(&shared),
                &["ui.dom".to_owned()],
            )
            .unwrap();
        let mut invocations = 0;

        assert!(matches!(
            registry.invoke(&old_principal, &old_lease, || invocations += 1),
            Err(CapabilityAccessError::StalePrincipal { .. })
        ));
        let replacement = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        assert!(replacement.has_grant("ui.dom"));
        let replacement_lease = registry.resolve_capability(&replacement, &shared).unwrap();
        registry
            .invoke(&replacement, &replacement_lease, || invocations += 1)
            .unwrap();
        assert_eq!(invocations, 1);
    }

    #[test]
    fn provider_reregistration_revokes_only_the_old_lease() {
        let (mut registry, shared, scope) =
            registered_pair(CapabilityScope::Runtime, "dev.consumer", &[]);
        let principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let old_lease = registry.resolve_capability(&principal, &shared).unwrap();
        registry.unregister_provider("dev.provider").unwrap();
        registry
            .register_provider("dev.provider", 1, std::slice::from_ref(&shared), &[], &[])
            .unwrap();
        let mut invocations = 0;

        assert!(matches!(
            registry.invoke(&principal, &old_lease, || invocations += 1),
            Err(CapabilityAccessError::StaleLease { .. })
        ));
        let replacement = registry.resolve_capability(&principal, &shared).unwrap();
        registry
            .invoke(&principal, &replacement, || invocations += 1)
            .unwrap();
        assert_eq!(invocations, 1);
    }

    #[test]
    fn scope_recreation_revokes_old_principal_and_lease() {
        let (mut registry, shared, scope) =
            registered_pair(CapabilityScope::Target, "dev.consumer", &[]);
        let old_principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let old_lease = registry
            .resolve_capability(&old_principal, &shared)
            .unwrap();
        assert!(registry.deactivate_scope(&scope));
        registry.activate_scope(scope.clone()).unwrap();
        let new_principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let new_lease = registry
            .resolve_capability(&new_principal, &shared)
            .unwrap();
        let mut invocations = 0;

        assert!(matches!(
            registry.invoke(&old_principal, &old_lease, || invocations += 1),
            Err(CapabilityAccessError::StalePrincipal { .. })
        ));
        assert!(matches!(
            registry.invoke(&new_principal, &old_lease, || invocations += 1),
            Err(CapabilityAccessError::LeaseOwnerMismatch { .. })
        ));
        registry
            .invoke(&new_principal, &new_lease, || invocations += 1)
            .unwrap();
        assert_eq!(invocations, 1);
    }

    #[test]
    fn undeclared_and_wrong_scope_requirements_are_rejected() {
        let (registry, _, scope) = registered_pair(CapabilityScope::Runtime, "dev.consumer", &[]);
        let principal = registry.issue_principal("dev.consumer", 1, &scope).unwrap();
        let undeclared = capability("runtime.other", 1, CapabilityScope::Runtime);
        assert!(matches!(
            registry.resolve_capability(&principal, &undeclared),
            Err(CapabilityAccessError::UndeclaredRequirement { .. })
        ));

        let target_requirement = capability("runtime.storage", 1, CapabilityScope::Target);
        assert!(matches!(
            registry.resolve_capability(&principal, &target_requirement),
            Err(CapabilityAccessError::UndeclaredRequirement { .. })
        ));
    }

    #[test]
    fn descriptor_json_strictly_validates_name_api_scope_and_fields() {
        let valid: CapabilityDescriptor = serde_json::from_str(
            r#"{"name":"renderer.main-world","api":1,"scope":"backend-session"}"#,
        )
        .unwrap();
        assert_eq!(valid.name.as_str(), "renderer.main-world");
        assert_eq!(valid.api.get(), 1);
        assert_eq!(valid.scope, CapabilityScope::BackendSession);

        for invalid in [
            r#"{"name":"bad name","api":1,"scope":"runtime"}"#,
            r#"{"name":"runtime.good","api":0,"scope":"runtime"}"#,
            r#"{"name":"runtime.good","api":1,"scope":"process"}"#,
            r#"{"name":"runtime.good","api":1,"scope":"runtime","extra":true}"#,
        ] {
            assert!(serde_json::from_str::<CapabilityDescriptor>(invalid).is_err());
        }
    }

    #[test]
    fn descriptor_json_accepts_every_declared_scope() {
        for (scope, expected) in [
            ("runtime", CapabilityScope::Runtime),
            ("target", CapabilityScope::Target),
            ("backend-session", CapabilityScope::BackendSession),
            ("thread", CapabilityScope::Thread),
        ] {
            let json = format!(r#"{{"name":"runtime.test","api":1,"scope":"{scope}"}}"#);
            let descriptor: CapabilityDescriptor = serde_json::from_str(&json).unwrap();
            assert_eq!(descriptor.scope, expected);
        }
    }
}

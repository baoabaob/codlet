//! Conservative admission budget for isolated generations in one Core lifetime.
//! Chromium may retain retired worlds. Navigation and CDP reattachment do not
//! refund this budget; stopping a plugin must not create another world.
use super::{RendererError, RendererRuntime};
use crate::plugin_control::PluginControlError;
use crate::plugins::{LoadedPlugin, RendererWorld};

pub(super) const WORLD_LIMIT: usize = 256;

impl RendererRuntime {
    pub(super) fn reserve_world_capacity(
        &mut self,
        replacements: &[LoadedPlugin],
    ) -> Result<(), PluginControlError> {
        let isolated = |plugin: &&LoadedPlugin| {
            plugin
                .manifest
                .renderer
                .as_ref()
                .is_some_and(|entry| entry.world == RendererWorld::Isolated)
        };
        let candidates = replacements.iter().filter(isolated).count();
        let rollback = self
            .plugins
            .iter()
            .filter(|plugin| {
                replacements
                    .iter()
                    .any(|next| next.manifest.id == plugin.manifest.id)
            })
            .filter(isolated)
            .count();
        let targets = self
            .sessions
            .values()
            .filter(|session| session.session.is_live())
            .count();
        let required = candidates.saturating_add(rollback).saturating_mul(targets);
        if required > self.world_limit.saturating_sub(self.world_attempts) {
            return Err(PluginControlError::new(
                "renderer_restart_required",
                format!(
                    "Isolated renderer budget: {}/{} used; this operation needs {} including rollback. Save your work, fully quit the client and restart Codlet before reloading. Existing plugins remain active.",
                    self.world_attempts, self.world_limit, required
                ),
            ));
        }
        self.world_reservations = self
            .sessions
            .iter()
            .filter(|(_, session)| candidates + rollback != 0 && session.session.is_live())
            .map(|(target, _)| (target.clone(), candidates + rollback))
            .collect();
        Ok(())
    }

    pub(super) fn charge_world(
        &mut self,
        target: &str,
        world: RendererWorld,
        managed: bool,
    ) -> Result<(), RendererError> {
        if world != RendererWorld::Isolated {
            return Ok(());
        }
        let reserved = self.world_reservations.values().sum::<usize>();
        let own_reservation = managed
            && self
                .world_reservations
                .get(target)
                .is_some_and(|count| *count > 0);
        if !own_reservation && self.world_attempts + reserved >= self.world_limit {
            return Err(RendererError::WorldBudgetExhausted);
        }
        if own_reservation {
            *self
                .world_reservations
                .get_mut(target)
                .expect("reserved target") -= 1;
        }
        // Even an uncertain CDP result may have created the world.
        self.world_attempts += 1;
        if self.world_attempts == self.world_limit * 3 / 4 {
            self.record_status_event(target, "renderer_world_budget_low", "Repeated isolated renderer activation has used 75% of this session's budget. Save your work and fully restart the client before further intensive reloading.");
        }
        Ok(())
    }

    #[cfg(all(test, windows))]
    pub(crate) fn set_world_limit_for_test(&mut self, limit: usize) {
        self.world_limit = limit;
    }
}

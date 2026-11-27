//! Turning sharing on and off. The order is the safety property.
//!
//! On: the owner is asked first, so a refusal changes nothing. Then the setting is saved and
//! the server binds the network. Off: remote requests stop, the server returns to loopback
//! only, and then the firewall rule is removed.

use crate::{
    firewall::{Firewall, Refusal, State},
    policy::Policy,
    tls::ListenSwitch,
};

pub struct Control {
    pub switch: ListenSwitch,
    pub firewall: Firewall,
    pub port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// The firewall refused. For `on` nothing changed; for `off` the server is already
    /// loopback only but the rule is still open.
    Firewall(Refusal),
    Save,
    Switch,
}

impl Control {
    /// `save` writes the setting for the given state.
    pub async fn apply(
        &self,
        on: bool,
        previous: bool,
        policy: &Policy,
        save: impl Fn(bool) -> Result<(), ()>,
    ) -> Result<(), Failure> {
        if on {
            if self.firewall.state() == State::Paused {
                self.firewall
                    .resume(self.port)
                    .await
                    .map_err(Failure::Firewall)?;
                if save(true).is_err() {
                    let _ = self.firewall.pause();
                    return Err(Failure::Save);
                }
                if self.switch.set(true).await.is_err() {
                    let _ = self.firewall.pause();
                    let _ = save(previous);
                    return Err(Failure::Switch);
                }
                policy.set_sharing(true);
                return Ok(());
            }
            if !previous {
                // A record left by a removal that was refused is cleared first, so a rule that
                // replaced Moss's is met by the add's own ownership check.
                self.firewall.close().await.map_err(Failure::Firewall)?;
            }
            self.firewall
                .open(self.port)
                .await
                .map_err(Failure::Firewall)?;
            if save(true).is_err() {
                self.firewall
                    .close()
                    .await
                    .map_err(|_| Failure::Firewall(Refusal::Stuck))?;
                return Err(Failure::Save);
            }
            if self.switch.set(true).await.is_err() {
                // The rule goes even when the setting cannot be put back.
                let closed = self.firewall.close().await;
                if save(previous).is_err() {
                    return Err(Failure::Save);
                }
                closed.map_err(|_| Failure::Firewall(Refusal::Stuck))?;
                return Err(Failure::Switch);
            }
            policy.set_sharing(true);
            return Ok(());
        }
        save(false).map_err(|_| Failure::Save)?;
        policy.set_sharing(false);
        if self.switch.set(false).await.is_err() {
            policy.set_sharing(previous);
            let _ = save(previous);
            return Err(Failure::Switch);
        }
        self.firewall.close().await.map_err(Failure::Firewall)
    }
}

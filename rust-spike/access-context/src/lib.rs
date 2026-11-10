//! Who is acting. Exactly two private fields, as `AccessContext` in TypeScript, which dropped
//! `workspaceId` on purpose. Its own crate, so the vault can require one.

use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessContext {
    actor_user_id: Uuid,
    request_id: String,
}

impl AccessContext {
    pub fn new(actor_user_id: Uuid, request_id: impl Into<String>) -> Self {
        Self { actor_user_id, request_id: request_id.into() }
    }

    pub fn actor_user_id(&self) -> Uuid {
        self.actor_user_id
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pattern is exhaustive, so a third field stops this test compiling.
    #[test]
    fn holds_exactly_the_actor_and_the_request() {
        let AccessContext { actor_user_id, request_id } = AccessContext::new(Uuid::nil(), "r1");
        assert_eq!(actor_user_id, Uuid::nil());
        assert_eq!(request_id, "r1");
    }
}
// proof JS-172

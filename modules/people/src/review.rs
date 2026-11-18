//! Existing match-review behavior; explicit merge/split actions remain separate.
use crate::{repository::Repository, repository_mutations::IdentityInput};
use moss_module_sdk::{Error, Host, Result};

impl<H: Host + ?Sized> Repository<'_, H> {
    pub fn accept_candidate(&self, id: &str) -> Result<()> {
        let candidate = self.candidate(id)?;
        let kind = candidate["candidateKind"].as_str().unwrap_or("");
        if matches!(kind, "merge_people" | "split_identity") {
            return Err(Error::new(format!("Candidate kind \"{kind}\" requires explicit action via people.merge or people.splitIdentity")));
        }
        if kind == "link_identity" && candidate["identityId"].is_string() {
            let person = candidate["primaryPersonId"].as_str();
            // Preserve the existing service: this action creates a confirmed alias
            // from the candidate ID; it does not move the suggested source identity.
            self.upsert_identity(&IdentityInput {
                person_id: person.map(str::to_owned),
                identity_kind: "alias".into(),
                source_kind: "manual".into(),
                normalized_value: id.into(),
                display_value: id.into(),
                source_ref: None,
                source_ref_hash: None,
                status: Some("active".into()),
                confidence: candidate["confidence"]
                    .as_str()
                    .and_then(|s| s.parse().ok()),
                provenance: Some("user_confirmed".into()),
            })?;
            self.event("candidate_accepted", person, None, None, Some(id), None)?;
        } else if kind == "create_person" {
            if let Some(name) = candidate["suggestedDisplayName"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                self.find_or_create_person(name)?;
            }
            self.event("candidate_accepted", None, None, None, Some(id), None)?;
        }
        self.set_candidate_status(id, "accepted")?;
        Ok(())
    }
    pub fn reject_candidate(&self, id: &str) -> Result<()> {
        self.set_candidate_status(id, "rejected")?;
        self.event("candidate_rejected", None, None, None, Some(id), None)?;
        Ok(())
    }
    pub fn suppress_candidate(&self, id: &str) -> Result<()> {
        self.set_candidate_status(id, "suppressed")?;
        Ok(())
    }
}

//! Meetings' answers to Memory about one recording. Memory asks before it stores a fact, so a
//! recording that has no reading, or that belongs to someone else, is refused.
use moss_memory_host::recording::{RecordingAuthority, SourceState};
use access_context::AccessContext;
use safety_core::db::{DataContext, Database};
use uuid::Uuid;

#[derive(Clone)]
pub struct MeetingsAuthority {
    database: Database,
}
impl MeetingsAuthority {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    /// Memory calls this inside its own runtime, so the query runs on a fresh thread with a
    /// runtime of its own, as the owner, under row-level security.
    fn read(&self, owner: &str, source_id: &str) -> Option<SourceState> {
        let owner = Uuid::parse_str(owner).ok()?;
        let source = Uuid::parse_str(source_id).ok()?;
        let database = self.database.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
            runtime.block_on(async move {
                let cx = DataContext::open(&database, &AccessContext::new(owner, "meetings-authority")).await.ok()?;
                let row = cx
                    .db()
                    .query_opt(
                        "SELECT output_version::int, side FROM app.meeting_recording_metadata WHERE meeting_id = $1",
                        &[&source],
                    )
                    .await
                    .ok()??;
                let (version, side): (Option<i32>, Option<String>) = (row.get(0), row.get(1));
                Some(SourceState { generation: 1, version: version?, side: side?, actor_generation: 1 })
            })
        })
        .join()
        .ok()?
    }
}
impl RecordingAuthority for MeetingsAuthority {
    fn current(&self, owner: &str, source_id: &str) -> Option<SourceState> {
        self.read(owner, source_id)
    }
    /// Deleting a recording's memory belongs to a later part, so no cleanup is ever open.
    fn cleaning(&self, _: &str, _: &str, _: Option<&str>) -> bool {
        false
    }
    fn sealed(&self, _: &str, _: &str) -> bool {
        false
    }
}

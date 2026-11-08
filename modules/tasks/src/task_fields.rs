//! Status values accepted by the existing create/update routes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Todo,
    Suggested,
    Done,
    Archived,
}
impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Suggested => "suggested",
            Self::Done => "done",
            Self::Archived => "archived",
        }
    }
}

export const fixtures = [
  {
    id: "allocation",
    valid: true,
    program: 'root = Reply([Section("Time to allocate", [Fact("hours"), Fact("projects")])]);',
    expected: "Time to allocate"
  },
  {
    id: "rearranged",
    valid: true,
    program:
      'root = Reply([Section("Resources", [Fact("budget")]), Section("Work", [Fact("projects"), Fact("hours")])]);',
    expected: "Resources"
  },
  {
    id: "unknown",
    valid: false,
    program: 'root = Reply([Section("Unknown", [InventedWidget("hours")])]);',
    expected: "Visual unavailable"
  },
  {
    id: "truncated",
    valid: false,
    program: 'root = Reply([Section("Incomplete", [Fact("hours")',
    expected: "Visual unavailable"
  },
  {
    id: "query",
    valid: false,
    program:
      'secret = Query("read_account", {}); root = Reply([Section("Read", [Fact("hours")])]);',
    expected: "Visual unavailable"
  },
  {
    id: "unknown-fact",
    valid: false,
    program: 'root = Reply([Section("Unknown fact", [Fact("bankBalance")])]);',
    expected: "Visual unavailable"
  }
] as const;

export function selectedFixture(search: string) {
  const id = new URLSearchParams(search).get("case");
  return fixtures.find((fixture) => fixture.id === id) ?? fixtures[0];
}

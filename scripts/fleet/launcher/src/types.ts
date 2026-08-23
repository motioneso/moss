export type Tier = "routine" | "sensitive" | "security";

export type BuildModel = { model: string; effort: string };

export type Settings = {
  judgeCmd: string;
  buildModels: Record<Tier, BuildModel>;
  laneCap: number;
  spawnBudget: number;
  deputyEnabled: boolean;
  deputyWaitSeconds: number;
  memoryFloorMb: number;
};

export type Lane = {
  issue: number;
  title?: string | null;
  spec?: string | null;
  tier?: Tier;
  status?: string;
  branch?: string | null;
  worktree?: string | null;
  pr?: number | null;
  agent?: string | null;
  relays?: number;
  qa_rounds?: number;
  blocked_reason?: string | null;
  paused?: boolean;
  pausedAt?: string | null;
  pausedBy?: string | null;
  question?: string | null;
  questionAskedAt?: string | null;
  checks?: Array<{ name?: string; state?: string }>;
  failedCheck?: string | null;
  updated_at?: string;
  error?: string;
};

export type LogEntry = { ts?: string; issue?: number; msg?: string };

export type LoadResult = {
  lanes: Lane[];
  errors: Lane[];
  logs: LogEntry[];
  runStarted: string | null;
  settings: Settings | null;
};

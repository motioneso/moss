// Day-plan apply composition (R2.2-T04C). One shared day-plan repository
// instance for routes and execution, plus the optional execution callback the
// Calendar routes call after reserving. Built from the injected connector and
// Google services; when this deployment has no connector runtime the callback
// is absent and apply/retry fail closed with 503 before any mutation. The
// change-approval port is always present: it is database-backed and needs no
// connector runtime.
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { AiRepository } from "@moss/ai";
import {
  ApplyExecutionService,
  CalendarRepository,
  CHANGE_APPROVAL_PERMISSION_ID,
  CHANGE_APPROVAL_TOOL_NAME,
  DayPlanRepository,
  readChangeBinding,
  type ApplyExecutionRouteCallback,
  type DayPlanChangeApprovalPort,
  type DayPlanChangeApprovalRecord
} from "@moss/calendar";
import {
  type ConnectorsRepository,
  GoogleApiClient,
  GoogleConnectionService,
  GoogleOAuthClient,
  createConnectorSecretCipher
} from "@moss/connectors";
import { TasksRepository } from "@moss/tasks";

import {
  buildApplyAccessGate,
  buildApplyFactsAdapter,
  WRITEBACK_POLICY_KEY
} from "../apply-execution-adapters.js";
import { buildApplyWriterPort } from "../apply-writer-port.js";
import { buildCalendarWriteService } from "../calendar-write-impl.js";

export interface DayPlanApplyCompositionDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly connectorsRepository?: ConnectorsRepository;
  readonly googleConnectionService?: GoogleConnectionService;
  readonly googleApiClient?: GoogleApiClient;
}

export interface DayPlanApplyComposition {
  readonly dayPlanRepository: DayPlanRepository;
  // Absent when this deployment has no connector runtime.
  readonly applyExecution?: ApplyExecutionRouteCallback;
  // Database-backed approval store for reserved moves and removals. Always
  // present; the routes fail closed with 503 when a gated batch needs it.
  readonly changeApproval: DayPlanChangeApprovalPort;
}

function toApprovalRecord(row: {
  readonly id: string;
  readonly owner_user_id: string;
  readonly status: string;
  readonly input_summary: unknown;
}): DayPlanChangeApprovalRecord {
  const status = row.status;
  if (
    status !== "pending" &&
    status !== "confirmed" &&
    status !== "rejected" &&
    status !== "cancelled"
  ) {
    throw new Error("Assistant action request has an unknown status.");
  }
  const inputSummary =
    typeof row.input_summary === "object" &&
    row.input_summary !== null &&
    !Array.isArray(row.input_summary)
      ? (row.input_summary as Record<string, unknown>)
      : {};
  return { id: row.id, ownerUserId: row.owner_user_id, status, inputSummary };
}

// Calendar-owned port over the audited assistant-action store. No migration:
// approvals reuse the existing request rows the gateway already writes.
function buildDayPlanChangeApprovalPort(repository: AiRepository): DayPlanChangeApprovalPort {
  const forOperation = async (
    scopedDb: DataContextDb,
    operationId: string,
    status: DayPlanChangeApprovalRecord["status"]
  ): Promise<DayPlanChangeApprovalRecord | undefined> => {
    const rows = await repository.listAssistantActions(scopedDb);
    for (const row of rows) {
      if (row.status !== status) continue;
      const record = toApprovalRecord(row);
      const binding = readChangeBinding(record.inputSummary);
      if (binding && binding.operationId === operationId) return record;
    }
    return undefined;
  };
  return {
    async createPendingApproval(scopedDb, input) {
      const row = await repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: "calendar",
        toolModuleName: "Calendar",
        toolName: CHANGE_APPROVAL_TOOL_NAME,
        permissionId: CHANGE_APPROVAL_PERMISSION_ID,
        risk: "write",
        inputSummary: input.inputSummary
      });
      return toApprovalRecord(row);
    },
    async getApproval(scopedDb, approvalId) {
      const row = await repository.getAssistantAction(scopedDb, approvalId);
      return row ? toApprovalRecord(row) : undefined;
    },
    async confirmApproval(scopedDb, approvalId) {
      // Single conditional update: only a pending row flips to confirmed,
      // so a replayed confirm returns undefined and never double-executes.
      const row = await repository.resolveAssistantAction(scopedDb, approvalId, {
        status: "confirmed"
      });
      return row ? toApprovalRecord(row) : undefined;
    },
    async findPendingApprovalForOperation(scopedDb, operationId) {
      return forOperation(scopedDb, operationId, "pending");
    },
    async findConfirmedApprovalForOperation(scopedDb, operationId) {
      return forOperation(scopedDb, operationId, "confirmed");
    },
    async listActionPolicies(scopedDb) {
      return repository.listActionPolicies(scopedDb);
    }
  };
}

function findExecutionTask(taskRepository: TasksRepository) {
  return async (scopedDb: DataContextDb, taskId: string) => {
    const row = await taskRepository.getById(scopedDb, taskId);
    if (!row) return undefined;
    return { id: row.id, ownerUserId: row.owner_user_id, status: row.status };
  };
}

export function buildDayPlanApplyComposition(
  deps: DayPlanApplyCompositionDeps
): DayPlanApplyComposition {
  const taskRepository = new TasksRepository();
  const dayPlanRepository = new DayPlanRepository({
    findTask: async (scopedDb, taskId) => {
      const task = await taskRepository.getById(scopedDb, taskId);
      return task ? { id: task.id, ownerUserId: task.owner_user_id } : undefined;
    }
  });
  const changeApproval = buildDayPlanChangeApprovalPort(new AiRepository());
  if (!deps.connectorsRepository) {
    return { dayPlanRepository, changeApproval };
  }
  const connectorsRepository = deps.connectorsRepository;
  const dataContext = deps.dataContext;
  const googleService =
    deps.googleConnectionService ??
    new GoogleConnectionService({
      repository: connectorsRepository,
      cipher: createConnectorSecretCipher(),
      oauthClient: new GoogleOAuthClient()
    });
  const googleClient = deps.googleApiClient ?? new GoogleApiClient();
  const calendarRepository = new CalendarRepository();
  const writer = buildCalendarWriteService({
    googleService,
    googleApiClient: googleClient,
    connectorsRepository,
    calendarRepository,
    dataContext
  });
  const applyExecution: ApplyExecutionRouteCallback = async (input) => {
    const access: AccessContext = input.access;
    const service = new ApplyExecutionService({
      dataContext,
      batches: dayPlanRepository,
      findTask: findExecutionTask(taskRepository),
      accessGate: buildApplyAccessGate({ connectorsRepository }),
      facts: buildApplyFactsAdapter({
        dataContext,
        connectorsRepository,
        googleService,
        googleClient,
        calendarRepository
      }).forAccess(access),
      writer: buildApplyWriterPort({ writer }).forAccess(access)
    });
    return service.executeReservedAdditions(input);
  };
  return { dayPlanRepository, applyExecution, changeApproval };
}

export interface DayPlanAutoApplyExecutorDeps extends DayPlanApplyCompositionDeps {
  readonly preferencesRepository?: Pick<PreferencesRepository, "get">;
}

// Worker-side executor for reserved automatic batches (R2.3-T06). Same
// service the routes use, but automatic writes happen without the actor
// watching, so they require explicit trust: when the calendar_writeback tier
// is anything but trusted_auto the batch denies with zero provider calls
// (an interactive reservation would still satisfy ask_each_time).
export function buildDayPlanAutoApplyExecutor(
  deps: DayPlanAutoApplyExecutorDeps
): ApplyExecutionRouteCallback {
  const taskRepository = new TasksRepository();
  const dayPlanRepository = new DayPlanRepository({
    findTask: async (scopedDb, taskId) => {
      const task = await taskRepository.getById(scopedDb, taskId);
      return task ? { id: task.id, ownerUserId: task.owner_user_id } : undefined;
    }
  });
  if (!deps.connectorsRepository) {
    return async () => {
      throw new HttpError(503, "day plan apply is unavailable");
    };
  }
  const connectorsRepository = deps.connectorsRepository;
  const dataContext = deps.dataContext;
  const googleService =
    deps.googleConnectionService ??
    new GoogleConnectionService({
      repository: connectorsRepository,
      cipher: createConnectorSecretCipher(),
      oauthClient: new GoogleOAuthClient()
    });
  const googleClient = deps.googleApiClient ?? new GoogleApiClient();
  const calendarRepository = new CalendarRepository();
  const writer = buildCalendarWriteService({
    googleService,
    googleApiClient: googleClient,
    connectorsRepository,
    calendarRepository,
    dataContext
  });
  const preferences = deps.preferencesRepository ?? new PreferencesRepository();
  const routeGate = buildApplyAccessGate({ connectorsRepository });
  return async (input) => {
    const access: AccessContext = input.access;
    const service = new ApplyExecutionService({
      dataContext,
      batches: dayPlanRepository,
      findTask: findExecutionTask(taskRepository),
      accessGate: {
        // Automatic application requires explicit trust: a tier downgrade
        // after generation denies the whole batch before any provider call.
        async checkAccess(scopedDb) {
          const tier = await preferences.get(scopedDb, WRITEBACK_POLICY_KEY);
          if (tier !== "trusted_auto") {
            return {
              ok: false as const,
              reason: "automatic application requires trusted_auto calendar writeback"
            };
          }
          return routeGate.checkAccess(scopedDb);
        }
      },
      facts: buildApplyFactsAdapter({
        dataContext,
        connectorsRepository,
        googleService,
        googleClient,
        calendarRepository
      }).forAccess(access),
      writer: buildApplyWriterPort({ writer }).forAccess(access)
    });
    return service.executeReservedAdditions(input);
  };
}

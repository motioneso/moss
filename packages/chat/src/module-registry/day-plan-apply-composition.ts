// Day-plan apply composition (R2.2-T04C). One shared day-plan repository
// instance for routes and execution, plus the optional execution callback the
// Calendar routes call after reserving. Built from the injected connector and
// Google services; when this deployment has no connector runtime the callback
// is absent and apply/retry fail closed with 503 before any mutation.
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  ApplyExecutionService,
  CalendarRepository,
  DayPlanRepository,
  type ApplyExecutionRouteCallback
} from "@moss/calendar";
import {
  type ConnectorsRepository,
  GoogleApiClient,
  GoogleConnectionService,
  GoogleOAuthClient,
  createConnectorSecretCipher
} from "@moss/connectors";
import { TasksRepository } from "@moss/tasks";

import { buildApplyAccessGate, buildApplyFactsAdapter } from "../apply-execution-adapters.js";
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
  if (!deps.connectorsRepository) {
    return { dayPlanRepository };
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
  return { dayPlanRepository, applyExecution };
}

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ExternalModuleToolsHandleV1 } from "@moss/module-web-sdk";
import { Button, Dialog } from "@moss/ui";
import { createModuleToolsController } from "./tool-controller";

interface Props {
  readonly moduleId: string;
  readonly actorScopeKey: string;
  readonly children: (tools: ExternalModuleToolsHandleV1) => ReactNode;
}

/** Remount on an actor/module change: no old decision can approve a new page's operation. */
export function ModuleToolsHost(props: Props) {
  return <ModuleToolsSession key={`${props.moduleId}:${props.actorScopeKey}`} {...props} />;
}

function ModuleToolsSession(props: Props) {
  const [controller] = useState(() => createModuleToolsController(props.moduleId));
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  return (
    <>
      {props.children(controller.handle)}
      {view?.kind === "confirmation" ? (
        <Dialog
          title={`Confirm ${view.confirmation.moduleName} action`}
          description={view.confirmation.actionLabel}
          onClose={() => controller.decide(false)}
          closeLabel="Cancel action"
          initialFocusRef={view.confirmation.risk === "destructive" ? cancel : undefined}
          footer={
            <>
              <Button variant="secondary" ref={cancel} onClick={() => controller.decide(false)}>
                Cancel
              </Button>
              <Button
                variant={view.confirmation.risk === "destructive" ? "danger" : "primary"}
                onClick={() => controller.decide(true)}
              >
                Confirm action
              </Button>
            </>
          }
        >
          <p>
            {view.confirmation.risk === "outbound"
              ? "This action sends information outside Moss. Continue only if you want to send it."
              : view.confirmation.risk === "destructive"
                ? "This action removes or replaces saved information. Review your selection before continuing."
                : "This action needs your confirmation before Moss can continue."}
          </p>
        </Dialog>
      ) : null}
      {view?.kind === "notice" ? (
        <Dialog
          title="Check this change"
          onClose={controller.dismissNotice}
          footer={<Button onClick={controller.dismissNotice}>Close</Button>}
        >
          <p role="alert">{view.message}</p>
        </Dialog>
      ) : null}
    </>
  );
}

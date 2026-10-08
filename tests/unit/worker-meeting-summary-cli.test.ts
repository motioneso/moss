import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcConnection } from "@moss/chat";
import { createWorkerMeetingSummaryCli } from "../../apps/worker/src/meeting-summary-cli.js";

const env = {
  JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
  JARVIS_CLI_RUNNER_RPC_SECRET: "synthetic-test-secret"
};
afterEach(() => vi.restoreAllMocks());

describe("automatic meeting summary CLI transport", () => {
  it("keeps an unconfigured host unavailable without an in-process fallback", async () => {
    const probe = vi.spyOn(RpcConnection.prototype, "probeProvider");
    const runtime = createWorkerMeetingSummaryCli({});
    expect(runtime.dependencies.createConstrainedCliStructuredAdapter).toBeUndefined();
    await expect(runtime.dependencies.probeConstrainedCli!("owner")).resolves.toBe(
      "model-unavailable"
    );
    expect(probe).not.toHaveBeenCalled();
    runtime.close();
  });

  it("refuses a configured socket without authentication before any RPC", () => {
    expect(() =>
      createWorkerMeetingSummaryCli({ JARVIS_CLI_RUNNER_SOCKET: env.JARVIS_CLI_RUNNER_SOCKET })
    ).toThrow("RPC_SECRET is missing or empty");
  });

  it.each([
    [{ status: "ready" }, "available"],
    [{ status: "not_installed" }, "model-unavailable"],
    [
      { status: "error", constrainedUnavailableReason: "per_user_isolation_required" },
      "subscription-isolation-unavailable"
    ]
  ] as const)("probes the constrained profile for the job owner (%j)", async (result, expected) => {
    const probe = vi.spyOn(RpcConnection.prototype, "probeProvider").mockResolvedValue(result);
    const close = vi.spyOn(RpcConnection.prototype, "close");
    const runtime = createWorkerMeetingSummaryCli(env);
    const signal = new AbortController().signal;
    await expect(runtime.dependencies.probeConstrainedCli!("owner", signal)).resolves.toBe(
      expected
    );
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      { provider: "anthropic", constrainedStructured: true },
      "owner",
      { timeoutMs: 5_000, signal }
    );
    runtime.close();
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.instances[0]).toBe(probe.mock.instances[0]);
  });

  it("preserves cancellation and does not convert a failed probe into readiness", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    vi.spyOn(RpcConnection.prototype, "probeProvider").mockRejectedValue(controller.signal.reason);
    const runtime = createWorkerMeetingSummaryCli(env);
    await expect(
      runtime.dependencies.probeConstrainedCli!("owner", controller.signal)
    ).rejects.toBe(controller.signal.reason);
    runtime.close();
  });

  it("uses the exact default model and owner through constrained RPC, then kills its session", async () => {
    const launch = vi.spyOn(RpcConnection.prototype, "launch").mockResolvedValue({ offset: 0 });
    const submit = vi
      .spyOn(RpcConnection.prototype, "submitStructured")
      .mockResolvedValue({ ok: true });
    vi.spyOn(RpcConnection.prototype, "readStructured").mockResolvedValue({
      text: '{"overview":"done"}',
      offset: 1,
      complete: true
    });
    const kill = vi.spyOn(RpcConnection.prototype, "kill").mockResolvedValue({ ok: true });
    const runtime = createWorkerMeetingSummaryCli(env);
    const schema = {
      type: "object",
      properties: { overview: { type: "string" } },
      required: ["overview"]
    };
    await expect(
      runtime.dependencies.createConstrainedCliStructuredAdapter!("anthropic").generateStructured({
        actorUserId: "owner",
        service: "module.meetings",
        model: { provider_kind: "anthropic", provider_model_id: "chosen-default-model" },
        schema,
        messages: [{ role: "user", content: "Synthetic meeting input" }],
        maxOutputTokens: 8192
      })
    ).resolves.toMatchObject({ rawText: '{"overview":"done"}' });
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^constrained-/), {
      provider: "anthropic",
      executionMode: "non_interactive",
      needsStructuredOutput: true,
      constrainedStructured: true,
      userId: "owner",
      personaText: "You produce structured JSON only.",
      model: "chosen-default-model",
      schema
    });
    const session = launch.mock.calls[0]![0];
    expect(submit).toHaveBeenCalledExactlyOnceWith(session, { text: "Synthetic meeting input" });
    expect(kill).toHaveBeenCalledExactlyOnceWith(session, undefined);
    runtime.close();
  });
});

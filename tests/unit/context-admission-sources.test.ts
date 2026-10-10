import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const live = resolve("packages/chat/src/live");
const read = (file: string) => readFileSync(resolve(live, file), "utf8");
const compact = (text: string) =>
  text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");

// Each entry matches one exact call and count, never an entire file exemption. Adapters only
// forward prepared input; changing a call or adding another requires revisiting this inventory.
const SUBMIT_INVENTORY = [
  {
    file: "context-admission.ts",
    call: "engine.submit(turn.text)",
    count: 1,
    reason: "Typed user turn assembled only with admitted outside blocks."
  },
  {
    file: "context-admission.ts",
    call: "engine.submit(context.text)",
    count: 1,
    reason: "Branded seed recorded before submission."
  },
  {
    file: "chat-session-launch.ts",
    call: "engine.submit(replayBatch)",
    count: 1,
    reason: "Bound replay retains durable taint; any fresh launch memory is already admitted."
  },
  {
    file: "chat-engine-rpc-client.ts",
    call: "this.conn.submit(this.sessionKey, { attemptId: randomUUID(), text })",
    count: 1,
    reason: "RPC transport forwards already assembled input without retrieving sources."
  },
  {
    file: "module-build-cli-engine.ts",
    call: "this.codexExec.submit(sanitized)",
    count: 2,
    reason: "CLI transport forwards submitted input; these are the initial and retry branches."
  },
  {
    file: "module-build-cli-engine.ts",
    call: "this.mux.submit(this.requireHandle(), sanitized)",
    count: 1,
    reason: "Multiplexer transport forwards submitted input without retrieving sources."
  },
  {
    file: "module-build-cli-engine.ts",
    call: "this.submit(replayBatch)",
    count: 1,
    reason: "Runner-owned drain of the same already-admitted launch replay batch."
  },
  {
    file: "cli-check-turn.ts",
    call: "engine.submit(prompt)",
    count: 1,
    reason: "Throwaway provider-check session, separate from saved conversation and write tools."
  },
  {
    file: "cli-structured-adapter.ts",
    call: "engine.submit(buildCliStructuredPrompt(input))",
    count: 1,
    reason: "Separate structured generation session, with no MCP write-tool token at launch."
  }
] as const;

// Plan 1.4 no-new-taint rows. Outside context sources are checked separately below.
const NO_NEW_TAINT = {
  b: {
    file: "chat-session-launch.ts",
    evidence: "{ forceReplay: opts?.forceReplay, threadId }",
    reason: "Replay reads the captured owner/surface-scoped conversation; its row carries taint."
  },
  b3: {
    file: "structured-claude-engine.ts",
    evidence: "--resume",
    reason:
      "CLI resume continues the launch-bound conversation; it does not choose the actor's current thread."
  },
  b3_gemini: {
    file: "structured-gemini-engine.ts",
    evidence: "--resume ${this.sessionId}",
    reason:
      "Gemini resumes the engine's captured session, retaining that conversation's durable state."
  },
  user: {
    file: "engine-text.ts",
    evidence: "userText: text",
    reason: "The directly typed user message is an instruction, not an outside source."
  },
  g: {
    file: "chat-session-turn.ts",
    evidence: "attachmentManifest: renderAttachmentsManifest(attachments)",
    reason: "Only server-composed attachment metadata; file bytes use read-tool admission."
  },
  k: {
    file: "chat-session-launch.ts",
    evidence: "personaText: persona",
    reason: "Trusted system/persona prompt is not retrieved outside content."
  },
  m: {
    file: "classifier-gate-lifecycle.ts",
    evidence: "recordHandledTurn",
    reason:
      "Gate calls use gateway result admission rather than prepending another raw context block."
  },
  n: {
    file: "meeting-chat-service.ts",
    evidence: "prepareGeneration",
    reason: "Separate tool-less meeting generation, outside the phase-1 live tool session."
  }
} as const;

function productionCalls() {
  const calls: { file: string; call: string; kind: "submit" | "combine" }[] = [];
  for (const file of readdirSync(live).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
  )) {
    const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "submit"
        )
          calls.push({ file, call: compact(node.getText(tree)), kind: "submit" });
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "combineHiddenContextBlocks"
        )
          calls.push({ file, call: compact(node.getText(tree)), kind: "combine" });
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return calls;
}

describe("context admission source coverage", () => {
  it("has no unreviewed engine submit call or extra instance of an exempt call", () => {
    expect(
      productionCalls()
        .filter((entry) => entry.kind === "submit")
        .map(({ file, call }) => `${file}: ${call}`)
        .sort()
    ).toEqual(
      SUBMIT_INVENTORY.flatMap(({ file, call, count, reason }) => {
        expect(reason.length).toBeGreaterThan(20);
        return Array.from({ length: count }, () => `${file}: ${call}`);
      }).sort()
    );
  });

  it("calls the admitted-block combiner only inside the admission boundary", () => {
    expect(productionCalls().filter((entry) => entry.kind === "combine")).toEqual([
      {
        file: "context-admission.ts",
        call: "combineHiddenContextBlocks(input.passive, input.crossTool, input.notes)",
        kind: "combine"
      }
    ]);
    const combiner = read("chat-context-blocks.ts");
    expect(compact(combiner)).toContain(
      "passiveBlock: AdmittedContext | null, crossToolBlock: AdmittedContext | null, notesBlock?: AdmittedContext | null"
    );
  });

  it.each(Object.entries(NO_NEW_TAINT))(
    "pins the narrow no-new-taint reason for row %s",
    (_row, entry) => {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(compact(read(entry.file))).toContain(entry.evidence);
    }
  );

  it("routes every raw non-tool source through admission and submits only its branded result", () => {
    const launch = compact(read("chat-session-launch.ts"));
    const manager = compact(read("chat-session-turn.ts"));
    const turn = compact(read("engine-text.ts"));
    for (const path of ["recall_memory_turn", "recall_cross_tool", "recall_notes"]) {
      expect(turn).toContain(`admitToContext(admission, turnBinding?.threadId ?? null, "${path}"`);
    }
    expect(launch).toContain("memorySeed = await admitToContext(");
    expect(launch).toContain("if (engine.admitsOutsideContentWithoutPermission)");
    expect(launch).toContain("await admitOutsideAgentLaunch(");
    expect(read("acp-chat-engine.ts")).toContain(
      "readonly admitsOutsideContentWithoutPermission = true"
    );
    expect(launch).toContain('"launch_memory_seed"');
    expect(launch).toContain("replayParts.push(memorySeed.text)");
    expect(launch).toContain('args.admissionPath ?? "seed_route"');
    expect(launch).toContain("await submitAdmittedContext(session.engine, admitted)");
    expect(manager).toContain('"module_control_context"');
    expect(manager.match(/submitPreparedTurn\(session.engine, engineText\)/g)).toHaveLength(2);
    expect(compact(read("runtime.ts"))).toContain(
      "gateway.runReadToolForActor(actorUserId, toolName, input, binding)"
    );
    const routes = readFileSync(resolve("packages/chat/src/live-routes.ts"), "utf8");
    expect(compact(routes)).toContain(
      'seed.context, undefined, bodyResult.surface, "evening_seed"'
    );
  });

  it("both native hook vault-allow branches await the report first", () => {
    const source = read("persistent-claude-permission-hook.ts");
    const branches = [...source.matchAll(/if \(safeVaultRead\(tool, input\)\) \{([^}]+)\}/g)];
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(compact(branch[1]!)).toMatch(
        /^ await reportVaultRead\(tool, input, event\?\.cwd\); decide\("allow",/
      );
    }
    expect(source.match(/\$\{VAULT_READ_REPORT_SOURCE\}/g)).toHaveLength(2);
  });
});

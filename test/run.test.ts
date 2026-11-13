import { expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { buildPrompt, claudeArgs, parsePayload, plannerRules } from "../run.ts";

const config: Config = {
  host: "127.0.0.1",
  port: 4319,
  token: "x".repeat(40),
  allowedOrigins: [],
  allowedProjectRoots: [],
  timeoutMinutes: 1,
  approvalTimeoutMinutes: 1,
  maxConcurrentRuns: 1,
  allowAutoMode: true,
  trustProjectPlannerScript: false,
  claude: {
    bin: "claude",
    permissionMode: "acceptEdits",
    model: "",
    allowedTools: [],
    extraArgs: [],
  },
};

test("prompt never reaches argv, so it can't be parsed as a flag", () => {
  const context = "--dangerously-skip-permissions";
  const args = claudeArgs(
    { projectPath: "/p", context, auto: false },
    { id: "r", token: "t" },
    config,
  );
  expect(args).not.toContain(context);
  expect(args.join(" ")).not.toContain("dangerously");
});

test("master token is never handed to the run", () => {
  const args = claudeArgs(
    { projectPath: "/p", context: "hi", auto: false },
    { id: "r", token: "runtok" },
    config,
  );
  expect(args.join(" ")).not.toContain(config.token);
  expect(args.join(" ")).toContain("runtok");
});

test("auto mode overrides permissionMode", () => {
  const args = claudeArgs(
    { projectPath: "/p", context: "hi", auto: true },
    { id: "r", token: "t" },
    config,
  );
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
});

test("project planner.sh is only trusted on opt-in", () => {
  expect(plannerRules("/p", false).some((r) => r.includes("/p/.claude"))).toBe(false);
  expect(plannerRules("/p", true).some((r) => r.includes("/p/.claude"))).toBe(true);
});

test("parsePayload validates and builds the prompt in order", () => {
  expect(parsePayload(null)).toBeString();
  expect(parsePayload([])).toBeString();
  expect(parsePayload({ projectPath: "/p", context: " " })).toBeString();
  expect(parsePayload({ projectPath: "/p", context: "a", auto: "yes" })).toBeString();
  expect(parsePayload({ projectPath: "/p", context: "a".repeat(300_000) })).toBeString();
  const ok = parsePayload({ projectPath: "/p", context: " ask ", extraContext: " more " });
  expect(typeof ok).toBe("object");
  expect(buildPrompt(ok as { context: string; extraContext?: string })).toBe(
    "ask\n\nExtra context:\nmore",
  );
});

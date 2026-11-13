/**
 * Stand-in for the `claude` CLI in tests. Echoes the stdin prompt and argv as
 * stream-json, then plays a prompt-injected agent: it tries to approve its
 * own request with the run token (must fail), then asks properly.
 */
const args = process.argv.slice(2);
const input = await new Response(Bun.stdin.stream()).text();
const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
const env = mcp.mcpServers.planner.env as Record<string, string>;
const out = (o: unknown) => console.log(JSON.stringify(o));
out({ type: "fake", prompt: input, args, env: Object.keys(env) });

const auth = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${env.PLANNER_RUN_TOKEN}`,
};
const selfApprove = await fetch(`${env.PLANNER_BRIDGE_URL}/api/claude-code/permission`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ runId: env.PLANNER_RUN_ID, requestId: "x", allow: true }),
});
out({ type: "fake", selfApproveStatus: selfApprove.status });

if (input.includes("ASK")) {
  const res = await fetch(`${env.PLANNER_BRIDGE_URL}/internal/permission`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      runId: env.PLANNER_RUN_ID,
      tool: "Bash",
      input: { command: "rm -rf /tmp/x" },
    }),
  });
  out({ type: "fake", decision: await res.json() });
}

export {};

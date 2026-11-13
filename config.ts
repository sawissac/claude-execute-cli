/**
 * Loads and validates `config.json` (merged over `config.example.json`).
 *
 * A missing token is generated and saved on first start. The file holds the
 * bridge's master token, so it is always written owner-only (0600) — also
 * when the user created it by copying the example — and the server warns if
 * someone loosened it later.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type Config = {
  host: string;
  port: number;
  token: string;
  allowedOrigins: string[];
  /** Folders a run may start in (and anything below them). Empty = any folder. */
  allowedProjectRoots: string[];
  timeoutMinutes: number;
  approvalTimeoutMinutes: number;
  maxConcurrentRuns: number;
  /** Let a request turn on `--permission-mode auto` for its run. */
  allowAutoMode: boolean;
  /**
   * Also auto-allow a `planner.sh` shipped inside the project folder. Off by
   * default: a cloned repo could ship its own script under that path and get
   * it run without approval.
   */
  trustProjectPlannerScript: boolean;
  claude: {
    bin: string;
    permissionMode: string;
    model: string;
    allowedTools: string[];
    extraArgs: string[];
  };
};

export const HERE = import.meta.dir;
export const CONFIG_PATH = process.env.PLANNER_CLAUDE_CONFIG ?? join(HERE, "config.json");
const EXAMPLE_PATH = join(HERE, "config.example.json");

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MIN_TOKEN_LENGTH = 32;

function readJson(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path} must hold a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const isPositive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Throws one error listing everything wrong, so a broken config fails at start, not mid-run. */
function validate(c: Config): void {
  const errors: string[] = [];
  if (!LOOPBACK_HOSTS.has(c.host)) {
    errors.push(`host must be a loopback address, got "${c.host}"`);
  }
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65_535) {
    errors.push("port must be an integer 1–65535");
  }
  if (typeof c.token !== "string" || c.token.length < MIN_TOKEN_LENGTH) {
    errors.push(`token must be at least ${MIN_TOKEN_LENGTH} characters (clear it to generate one)`);
  }
  if (!isStringArray(c.allowedOrigins)) {
    errors.push("allowedOrigins must be an array of strings");
  } else {
    for (const o of c.allowedOrigins) {
      if (o === "*" || o === "null" || !/^https?:\/\/[^/]+$/.test(o)) {
        errors.push(`allowedOrigins: "${o}" must be a full origin like https://example.com`);
      }
    }
  }
  if (!isStringArray(c.allowedProjectRoots) || !c.allowedProjectRoots.every((p) => isAbsolute(p))) {
    errors.push("allowedProjectRoots must be an array of absolute paths");
  }
  for (const key of ["timeoutMinutes", "approvalTimeoutMinutes", "maxConcurrentRuns"] as const) {
    if (!isPositive(c[key])) {
      errors.push(`${key} must be a positive number`);
    }
  }
  if (typeof c.allowAutoMode !== "boolean") {
    errors.push("allowAutoMode must be true or false");
  }
  if (typeof c.trustProjectPlannerScript !== "boolean") {
    errors.push("trustProjectPlannerScript must be true or false");
  }
  const cl = c.claude;
  if (!cl || typeof cl.bin !== "string" || !cl.bin) {
    errors.push("claude.bin must be a non-empty string");
  } else {
    if (typeof cl.permissionMode !== "string")
      errors.push("claude.permissionMode must be a string");
    if (typeof cl.model !== "string") errors.push("claude.model must be a string");
    if (!isStringArray(cl.allowedTools))
      errors.push("claude.allowedTools must be an array of strings");
    if (!isStringArray(cl.extraArgs)) errors.push("claude.extraArgs must be an array of strings");
  }
  if (errors.length) {
    throw new Error(`Invalid config (${CONFIG_PATH}):\n  - ${errors.join("\n  - ")}`);
  }
}

/** Write atomically and owner-only, so a crash never leaves a half-written token file. */
function saveConfig(config: Config): void {
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, CONFIG_PATH);
}

/** The token file must not be readable by other users of this machine. */
function checkPermissions(): void {
  if (process.platform === "win32" || !existsSync(CONFIG_PATH)) {
    return;
  }
  const mode = statSync(CONFIG_PATH).mode & 0o777;
  if (mode & 0o077) {
    chmodSync(CONFIG_PATH, 0o600);
    console.warn(
      `[planner-claude] ${CONFIG_PATH} was readable by others (mode ${mode.toString(8)}); ` +
        "set it to 600. Rotate the token if other people use this machine.",
    );
  }
}

export function loadConfig(): Config {
  const base = readJson(EXAMPLE_PATH) as unknown as Config;
  const own = (existsSync(CONFIG_PATH) ? readJson(CONFIG_PATH) : {}) as Partial<Config>;
  const config: Config = {
    ...base,
    ...own,
    claude: { ...base.claude, ...(own.claude ?? {}) },
  };
  config.allowedProjectRoots = (config.allowedProjectRoots ?? []).map((p) =>
    typeof p === "string" ? resolve(p) : p,
  );
  checkPermissions();
  if (!config.token) {
    config.token = `pcc_${randomBytes(32).toString("base64url")}`;
    saveConfig(config);
    console.log(`[planner-claude] generated a token and saved it to ${CONFIG_PATH}`);
  }
  validate(config);
  return config;
}

/** Request checks shared by the routes. Pure functions, so they are unit-tested. */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { LOOPBACK_HOSTS } from "./config.ts";

/**
 * Constant-time string compare. Hashing first gives both sides the same
 * length, so neither the length nor a prefix of the secret leaks.
 */
export function secretEquals(given: string, want: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b) && want.length > 0;
}

/** The token from `Authorization: Bearer <token>`, or "" when absent. */
export function bearer(request: Request): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return m?.[1] ?? "";
}

/**
 * True when the Host header names this machine. Blocks DNS rebinding: a page
 * on evil.example that resolves to 127.0.0.1 still sends `Host: evil.example`.
 * A malformed header is a refusal, not a crash.
 */
export function hostIsLoopback(host: string | null): boolean {
  if (!host) {
    return false;
  }
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** `child` is `root` or somewhere below it (both already resolved, no symlinks). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve a folder the client sent to its real path (symlinks followed), and
 * check it against `allowedRoots` (empty = anywhere). Returns the real path
 * or an error message.
 */
export function checkFolder(
  path: unknown,
  allowedRoots: string[],
): { ok: true; path: string } | { ok: false; status: number; error: string } {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    return { ok: false, status: 400, error: "path must be an absolute path." };
  }
  let real: string;
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return { ok: false, status: 404, error: `Folder not found: ${path}` };
    }
    real = realpathSync(path);
  } catch {
    return { ok: false, status: 404, error: `Folder not found: ${path}` };
  }
  if (allowedRoots.length) {
    const roots = allowedRoots.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return r;
      }
    });
    if (!roots.some((r) => isInside(r, real))) {
      return { ok: false, status: 403, error: `${path} is outside allowedProjectRoots.` };
    }
  }
  return { ok: true, path: real };
}

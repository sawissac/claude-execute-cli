import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFolder, corsHeaders, hostIsLoopback, isInside, secretEquals } from "../security.ts";

describe("secretEquals", () => {
  test("matches only the exact secret", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abd", "abc")).toBe(false);
    expect(secretEquals("abcd", "abc")).toBe(false);
    expect(secretEquals("", "")).toBe(false);
  });
});

describe("hostIsLoopback", () => {
  test("accepts loopback hosts with or without port", () => {
    for (const h of ["127.0.0.1:4319", "localhost", "[::1]:4319"])
      expect(hostIsLoopback(h)).toBe(true);
  });
  test("refuses others and malformed values instead of throwing", () => {
    for (const h of [null, "", "evil.example", "127.0.0.1.evil.example", "a b", "%%%"]) {
      expect(hostIsLoopback(h)).toBe(false);
    }
  });
});

test("corsHeaders only for allowed origins", () => {
  expect(
    corsHeaders("https://ok.example", ["https://ok.example"])["Access-Control-Allow-Origin"],
  ).toBe("https://ok.example");
  expect(corsHeaders("https://evil.example", ["https://ok.example"])).toEqual({});
  expect(corsHeaders(null, ["https://ok.example"])).toEqual({});
});

test("isInside", () => {
  expect(isInside("/a/b", "/a/b")).toBe(true);
  expect(isInside("/a/b", "/a/b/c")).toBe(true);
  expect(isInside("/a/b", "/a/bc")).toBe(false);
  expect(isInside("/a/b", "/a")).toBe(false);
  expect(isInside("/a/b", "/a/b/../c")).toBe(false);
});

describe("checkFolder", () => {
  const root = mkdtempSync(join(tmpdir(), "pcc-"));
  const inside = join(root, "proj");
  mkdirSync(inside);
  const outside = mkdtempSync(join(tmpdir(), "pcc-out-"));
  const link = join(root, "sneaky");
  symlinkSync(outside, link);

  test("rejects relative paths, NUL bytes and missing folders", () => {
    expect(checkFolder("rel/path", []).ok).toBe(false);
    expect(checkFolder(`${inside}\0x`, []).ok).toBe(false);
    expect(checkFolder(join(root, "nope"), []).ok).toBe(false);
    expect(checkFolder(42, []).ok).toBe(false);
  });
  test("any folder when no roots are set", () => {
    expect(checkFolder(outside, [])).toMatchObject({ ok: true });
  });
  test("enforces allowed roots after following symlinks", () => {
    expect(checkFolder(inside, [root])).toMatchObject({ ok: true });
    expect(checkFolder(outside, [root])).toMatchObject({ ok: false, status: 403 });
    expect(checkFolder(link, [root])).toMatchObject({ ok: false, status: 403 });
  });
});

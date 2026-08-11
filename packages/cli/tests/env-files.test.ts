import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { envFilePaths, placeholderKey } from "../src/probe";
import { KEY_NAME } from "../src/diagnose";
import { REPO_ROOT } from "../src/repo";

// The doctor's picture of the machine, checked against the machine's own source.
//
// Both of these are lists that live in two files, and both have already been
// wrong in the quiet direction: a doctor that looks in fewer places than the
// loader tells someone with a working key that they have none.

describe("the .env files doctor looks in", () => {
  it("are the ones apps/platform/src/cli/env.ts loads, in the same order", () => {
    const loader = readFileSync(path.join(REPO_ROOT, "apps", "platform", "src", "cli", "env.ts"), "utf8");
    // The loader builds its paths from `appDir` and `repoRoot`; read the joins
    // back rather than the resolved strings, which only exist at run time.
    const loaded = [...loader.matchAll(/path\.join\(([^)]*)\)/g)]
      .map((m) => (m[1] ?? "").replace(/\s+/g, ""))
      .filter((args) => args.includes('".env"'));
    expect(loaded).toEqual(['appDir,".env"', 'repoRoot,".env"', 'repoRoot,"apps","gmail",".env"']);

    expect(envFilePaths()).toEqual([
      path.join(REPO_ROOT, "apps", "platform", ".env"),
      path.join(REPO_ROOT, ".env"),
      path.join(REPO_ROOT, "apps", "gmail", ".env"),
    ]);
  });
});

describe("the placeholder doctor refuses to call a key", () => {
  it("is whatever .env.example currently ships", () => {
    const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    const line = new RegExp(`^${KEY_NAME}=(.*)$`, "m").exec(example);
    expect(line?.[1]).toBeTruthy();
    expect(placeholderKey()).toBe(line?.[1]);
  });
});

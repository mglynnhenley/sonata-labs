import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertCaptureUnchanged, captureSources, writeCaptured } from "./source.mjs";

test("image source capture excludes secrets, generated state, and symlink escapes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sonata-image-capture-"));
  try {
    for (const dir of ["app", "app/data", "app/.next", "app/node_modules"]) mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ["app/route.ts", "app/.env", "app/.env.local", "app/data/private.db", "app/.next/private.js", "app/node_modules/private.js", "app/tsconfig.tsbuildinfo"]) {
      writeFileSync(path.join(root, file), file);
    }
    symlinkSync(path.join(root, "app/.env"), path.join(root, "app/escaped-secret.ts"));
    assert.deepEqual([...captureSources(root, ["app"]).files.keys()], ["app/route.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("captured bytes stay consistent with their fingerprint while later edits fail the build", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sonata-image-race-"));
  try {
    mkdirSync(path.join(root, "app"));
    writeFileSync(path.join(root, "app/route.ts"), "original");
    const captured = captureSources(root, ["app"]);
    assertCaptureUnchanged(captured, captureSources(root, ["app"]));
    writeFileSync(path.join(root, "app/route.ts"), "changed while copying");
    writeCaptured(captured, "app/route.ts", path.join(root, "context/route.ts"));
    assert.equal(readFileSync(path.join(root, "context/route.ts"), "utf8"), "original");
    assert.throws(() => assertCaptureUnchanged(captured, captureSources(root, ["app"])), /Source changed/);
    writeFileSync(path.join(root, "app/route.ts"), "original");
    writeFileSync(path.join(root, "app/new-route.ts"), "new file during capture");
    assert.throws(() => assertCaptureUnchanged(captured, captureSources(root, ["app"])), /Source changed/);
    rmSync(path.join(root, "app/new-route.ts"));
    rmSync(path.join(root, "app/route.ts"));
    assert.throws(() => assertCaptureUnchanged(captured, captureSources(root, ["app"])), /Source changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

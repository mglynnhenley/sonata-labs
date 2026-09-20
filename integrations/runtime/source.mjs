import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const excluded = new Set(["node_modules", ".next", "data", ".git", ".context", "coverage", "test-results", "playwright-report"]);
const include = (name) => !excluded.has(name) && !name.startsWith(".env") && !name.endsWith(".tsbuildinfo");

/** Capture the exact bytes used by hashing, image contexts, and the local-source bundle. */
export function captureSources(root, directories, extraFiles = []) {
  const names = new Set(extraFiles);
  function visit(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!include(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) names.add(file);
    }
  }
  for (const directory of directories) visit(directory);
  const files = new Map([...names].sort().map((file) => [file, readFileSync(path.join(root, file))]));
  const hash = createHash("sha256");
  for (const [file, bytes] of files) hash.update(file).update("\0").update(bytes).update("\0");
  return { files, sha256: hash.digest("hex") };
}

export function writeCaptured(source, file, destination) {
  const bytes = source.files.get(file);
  if (!bytes) throw new Error(`Source file was not captured: ${file}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

export function assertCaptureUnchanged(before, after) {
  if (before.sha256 !== after.sha256) {
    throw new Error("Source changed while capturing the runtime images. Retry the build after the edits finish.");
  }
}

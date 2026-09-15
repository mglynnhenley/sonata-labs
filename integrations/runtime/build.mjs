import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCaptureUnchanged, captureSources, writeCaptured } from "./source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".context/runtime");
const apps = ["gmail", "gmail-ui", "slack", "calendar", "attio", "google-docs", "google-ads", "linkedin", "excel", "desk"];
const sourceDirectories = ["integrations/runtime", "packages/mcp/src", "packages/engine/src", "packages/core", "packages/ui", "packages/desks/src", "packages/scenarios/src", ...apps.map((app) => `apps/${app}`)];
function capture() {
  const manifests = ["package.json", "package-lock.json"];
  for (const area of ["apps", "packages"]) {
    for (const item of readdirSync(path.join(root, area)).sort()) {
      const manifest = `${area}/${item}/package.json`;
      if (existsSync(path.join(root, manifest))) manifests.push(manifest);
    }
  }
  return captureSources(root, sourceDirectories, manifests);
}
const source = capture();
const files = [...source.files.keys()];
const sourceSha256 = source.sha256;
const manifestPath = path.join(output, "images.json");
function docker(args, capture = false) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `docker ${args[0]} failed (${result.status}).`);
  return result.stdout?.trim();
}
if (!process.argv.includes("--force") && existsSync(manifestPath)) {
  const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (previous.sourceSha256 === sourceSha256 && [previous.apps, previous.agent].every((image) => {
    try { return docker(["image", "inspect", image.image, "--format", "{{.Id}}"], true) === image.id; } catch { return false; }
  })) {
    process.stdout.write(`${manifestPath}\n`);
    process.exit(0);
  }
}
mkdirSync(output, { recursive: true });
const context = path.join(output, `build-${process.pid}`);
rmSync(context, { recursive: true, force: true });
mkdirSync(context, { recursive: true });
try {
  const appsContext = path.join(context, "apps");
  const agentContext = path.join(context, "agent");
  mkdirSync(appsContext, { recursive: true });
  mkdirSync(agentContext, { recursive: true });
  for (const file of files.filter((file) => file.endsWith("/package.json") || file === "package.json" || file === "package-lock.json")) {
    const target = path.join(appsContext, "manifests", file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeCaptured(source, file, target);
  }
  // A workspace's source is copied separately, so package installation cannot accidentally
  // include the dashboard database, authored worlds, hidden files, or host native modules.
  for (const dir of ["packages/core", "packages/ui", "packages/desks", "packages/scenarios", ...apps.map((app) => `apps/${app}`)]) {
    for (const file of files.filter((file) => file.startsWith(`${dir}/`))) {
      writeCaptured(source, file, path.join(appsContext, "source", file));
    }
  }
  // Turbopack resolves workspace dependencies only inside its detected lockfile root.
  for (const file of ["package.json", "package-lock.json"]) {
    writeCaptured(source, file, path.join(appsContext, "source", file));
  }
  writeCaptured(source, "integrations/runtime/apps-entrypoint.mjs", path.join(appsContext, "apps-entrypoint.mjs"));
  writeCaptured(source, "integrations/runtime/Dockerfile.apps", path.join(appsContext, "Dockerfile"));
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["integrations/runtime/agent-entrypoint.ts"],
    outfile: path.join(agentContext, "mcp.mjs"),
    bundle: true, platform: "node", target: "node24", format: "esm", minify: true,
    metafile: true, sourcemap: false,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{ name: "captured-source", setup(plugin) {
      plugin.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        const relative = path.relative(root, args.path);
        if (relative.startsWith("node_modules/") || relative.startsWith("../")) return;
        const contents = source.files.get(relative);
        if (!contents) throw new Error(`Bundle source was not captured: ${relative}`);
        const extension = path.extname(relative).slice(1);
        return { contents, loader: ["ts", "tsx", "jsx"].includes(extension) ? extension : "js" };
      });
    } }],
  });
  const inputs = Object.entries(Object.values(bundle.metafile.outputs)[0].inputs)
    .filter(([, value]) => value.bytesInOutput > 0).map(([file]) => file).sort();
  const allowedSource = (file) => file.startsWith("node_modules/") || file.startsWith("packages/mcp/src/") ||
    file.startsWith("packages/engine/src/tools/") ||
    file.startsWith("packages/desks/src/") || file.startsWith("packages/scenarios/src/") ||
    ["http.ts", "gmailMime.ts", "slackClient.ts", "adapters/shared.ts", "adapters/attio.ts"].some((name) => file === `packages/engine/src/${name}`) ||
    ["ports.ts", "twin.ts", "excel.ts", "clock.ts", "spec.ts", "cast.ts", "types/world.ts", "types/episode.ts"].some((name) => file === `packages/core/src/${name}`) ||
    file === "integrations/runtime/agent-entrypoint.ts";
  const unexpected = inputs.filter((file) => !allowedSource(file));
  if (unexpected.length) throw new Error(`The agent bundle includes unexpected source: ${unexpected.join(", ")}`);
  writeFileSync(path.join(agentContext, "bundle-inputs.json"), JSON.stringify({ sourceSha256, inputs }, null, 2) + "\n");
  writeCaptured(source, "integrations/runtime/Dockerfile.agent", path.join(agentContext, "Dockerfile"));
  assertCaptureUnchanged(source, capture());
  const images = {};
  for (const kind of ["apps", "agent"]) {
    // Workspaces share the Docker daemon; one checkout must never retag another's runtime.
    const image = `sonata-${kind}:${sourceSha256.slice(0, 16)}`;
    docker(["build", "--label", `org.sonata.source-sha256=${sourceSha256}`, "--tag", image, path.join(context, kind)]);
    images[kind] = { image, id: docker(["image", "inspect", image, "--format", "{{.Id}}"], true) };
  }
  const manifest = { version: 1, sourceSha256, builtAt: new Date().toISOString(), ...images };
  writeFileSync(`${manifestPath}.tmp-${process.pid}`, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(`${manifestPath}.tmp-${process.pid}`, manifestPath);
  process.stdout.write(`${manifestPath}\n`);
} finally { rmSync(context, { recursive: true, force: true }); }

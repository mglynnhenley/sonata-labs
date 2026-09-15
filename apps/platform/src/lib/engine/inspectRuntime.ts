import { spawnSync } from "node:child_process";
import { repositoryRoot } from "./workplace";
import path from "node:path";

export function inspectRuntime() {
  const root = repositoryRoot();
  const python = process.env.SONATA_INSPECT_PYTHON || path.join(root, ".context", "inspect-venv", "bin", "python");
  const check = spawnSync(python, ["-c", "import sonata_inspect.worker, sonata_inspect.judging, mcp; from inspect_ai.model import get_model; get_model('openrouter/sonata/preflight', api_key='preflight')"], { cwd: root, timeout: 15000, encoding: "utf8" });
  if (check.error || check.status !== 0) throw new Error(
    "Inspect is not ready. From the repository root run: uv venv .context/inspect-venv --python 3.12, then " +
    'uv pip install --python .context/inspect-venv/bin/python -e "integrations/inspect[test]". No evaluation was started.',
  );
  return { root, python };
}


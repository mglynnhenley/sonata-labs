#!/usr/bin/env node
// The bin. Four lines of JavaScript because everything in this monorepo is
// consumed as TypeScript source with no build step, and node cannot import
// packages/engine's extensionless specifiers on its own. tsx's ESM hook teaches it
// to, which is the same thing `npm run dev` does for the twins.
//
// Keeping the shim this thin matters: what a user pastes into their agent is a
// path to this file, and a launcher that can fail in its own right is a launcher
// that will.
import { register } from "tsx/esm/api";

register();

const { run } = await import("../src/cli.ts");
await run();

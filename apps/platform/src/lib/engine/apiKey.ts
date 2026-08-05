import { setApiKey } from "@sonata/engine";
import { getApiKey } from "../settings";

// Handing the platform's key to the engine, at the moment model work starts.
//
// The engine used to read `process.env.OPENROUTER_API_KEY` and nothing else,
// which is fine for the CLI and wrong for this app: here the key is a row in
// platform.db that a user typed into Settings, and there is no environment
// variable to find. The symptom was not a missing key error at the door — the
// run started, the twins seeded, and then every director tick failed with
// "OPENROUTER_API_KEY is not set" while the Settings page said a key was saved.
// A world with a silent director still fires its beats, so the day looks like it
// is working and simply never answers anything the agent does.
//
// Called at the start of every path that can reach a model rather than once at
// boot, because the key can be replaced on the Settings page while this process
// keeps running. `setApiKey` drops the memoized client only when the value
// actually changed, so calling it per run costs nothing.

export function applyStoredApiKey(): void {
  setApiKey(getApiKey());
}

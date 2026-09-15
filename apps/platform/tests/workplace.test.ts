import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { copyWorkplaceBaseline, bindWorkplaceUrls, awaitedWithAbort, prepareWorkplace } from "../src/lib/engine/workplace";

describe("waiting for a shared image build", () => {
  it("cancels one run immediately while another waiter receives the completed build", async () => {
    let finish!: (value: string) => void;
    const shared = new Promise<string>(resolve => { finish = resolve; });
    const controller = new AbortController();
    const stopped = awaitedWithAbort(shared, controller.signal);
    const continuing = awaitedWithAbort(shared);
    controller.abort(new Error("run stopped during setup"));
    await expect(stopped).rejects.toThrow("run stopped during setup");
    finish("same immutable image");
    await expect(continuing).resolves.toBe("same immutable image");
  });

  it("retains a shared build failure and handles an already cancelled waiter", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    const failed = Promise.reject(new Error("image build failed"));
    await expect(awaitedWithAbort(failed, controller.signal)).rejects.toThrow("already stopped");
    await expect(awaitedWithAbort(failed)).rejects.toThrow("image build failed");
  });
});

describe("workplace baselines", () => {
  it("copies the snapshot into independent working files and excludes credentials and old audits", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sonata-workplace-"));
    const source = path.join(root, "source");
    mkdirSync(path.join(source, "data"), { recursive: true });
    writeFileSync(path.join(source, "app.ts"), "application source");
    writeFileSync(path.join(source, ".env"), "secret");
    writeFileSync(path.join(source, "data", "audit.db"), "previous run audit");
    const db = new Database(path.join(source, "data", "snapshot.db"));
    db.exec("CREATE TABLE work (value TEXT); INSERT INTO work VALUES ('baseline')");
    db.close();
    const a = path.join(root, "a"), b = path.join(root, "b");
    copyWorkplaceBaseline(source, a, true);
    copyWorkplaceBaseline(source, b, true);
    const working = new Database(path.join(a, "data", "working.db"));
    working.exec("UPDATE work SET value = 'A changed'");
    working.close();
    for (const target of [source, b]) {
      const file = path.join(target, "data", target === source ? "snapshot.db" : "working.db");
      const db = new Database(file);
      expect(db.prepare("SELECT value FROM work").pluck().get()).toBe("baseline");
      db.close();
    }
    expect(existsSync(path.join(a, "app.ts"))).toBe(false);
    expect(existsSync(path.join(a, ".env"))).toBe(false);
    expect(existsSync(path.join(a, "data", "audit.db"))).toBe(false);
  });

  it("rebinds local app links in nested seed content without changing external links or the template", () => {
    const seed = { messages: ["http://localhost:3950/?workbook=bank", "https://example.com:3950", "http://localhost:39500"] };
    const bound = bindWorkplaceUrls(seed, { urls: { excel: "http://127.0.0.1:51000" }, humanUrls: { excel: "http://127.0.0.1:51000" } });
    expect(bound.messages).toEqual(["http://127.0.0.1:51000/?workbook=bank", "https://example.com:3950", "http://localhost:39500"]);
    expect(seed.messages[0]).toBe("http://localhost:3950/?workbook=bank");
  });

  it("refuses a missing baseline instead of silently opening an empty world", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sonata-baseline-"));
    mkdirSync(path.join(root, "source"));
    expect(() => copyWorkplaceBaseline(path.join(root, "source"), path.join(root, "target"), true)).toThrow("No saved baseline");
  });
});

describe("a workplace that serves a continuity week", () => {
  it("refuses a desk with no case, and refuses a case id it does not recognise as one", async () => {
    // Two different silent failures this prevents. A desk with no case serves no
    // tools, which reads on the report as an agent that chose not to act. A case
    // id from somewhere else reaches a container env var, so it is shaped-checked
    // here rather than trusted.
    await expect(prepareWorkplace("desk-no-case", ["desk"], false))
      .rejects.toThrow(/must name the continuity case/);
    await expect(prepareWorkplace("desk-bad-case", ["desk"], false, { deskCase: "../../etc" }))
      .rejects.toThrow(/looks like E01/);
  });
});

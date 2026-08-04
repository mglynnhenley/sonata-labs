import { describe, it, expect } from "vitest";
import { diffSnapshots } from "@/lib/eval/judge/snapshot";
import type { MailboxSnapshot } from "@/lib/eval/judge/types";

// `diffSnapshots` is pure — two hand-built snapshots in, one MailboxDiff out.
// It is the single place where "the agent called messages.modify" turns into
// "this thread left the inbox", and everything downstream (the judge prompt, the
// run artifact) reads its output verbatim. So the properties under test are the
// contract, not the implementation: true set differences on labels, a count —
// never a list — for untouched threads, and an ordering that does not leak
// capture order.

type Thread = MailboxSnapshot["threads"][number];

function thread(threadId: string, over: Partial<Thread> = {}): Thread {
  return {
    threadId,
    subject: `subject ${threadId}`,
    from: `sender-${threadId}@example.com`,
    date: 1_700_000_000_000,
    labels: ["INBOX"],
    unread: false,
    starred: false,
    count: 1,
    ...over,
  };
}

function snapshot(threads: Thread[], capturedAt = 1_700_000_000_000): MailboxSnapshot {
  return {
    capturedAt,
    labels: [{ id: "INBOX", name: "INBOX", unread: threads.filter((t) => t.unread).length }],
    threads,
  };
}

describe("diffSnapshots — thread lifecycle", () => {
  it("reports a thread that only exists after as added, with its sender", () => {
    const before = snapshot([thread("t1")]);
    const after = snapshot([thread("t1"), thread("t2", { subject: "New reply", from: "a@b.c" })]);

    const diff = diffSnapshots(before, after);

    expect(diff.added).toEqual([{ threadId: "t2", subject: "New reply", from: "a@b.c" }]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("reports a thread that only exists before as removed", () => {
    const before = snapshot([thread("t1"), thread("t2", { subject: "Purged" })]);
    const after = snapshot([thread("t1")]);

    const diff = diffSnapshots(before, after);

    expect(diff.removed).toEqual([{ threadId: "t2", subject: "Purged" }]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("does not treat a trashed thread as removed — it is still present, just relabelled", () => {
    const before = snapshot([thread("t1", { labels: ["INBOX"] })]);
    const after = snapshot([thread("t1", { labels: ["TRASH"] })]);

    const diff = diffSnapshots(before, after);

    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({
      threadId: "t1",
      labelsAdded: ["TRASH"],
      labelsRemoved: ["INBOX"],
    });
  });

  it("handles simultaneous add and remove", () => {
    const before = snapshot([thread("gone", { subject: "Gone" })]);
    const after = snapshot([thread("new", { subject: "New" })]);

    const diff = diffSnapshots(before, after);

    expect(diff.added).toEqual([{ threadId: "new", subject: "New", from: "sender-new@example.com" }]);
    expect(diff.removed).toEqual([{ threadId: "gone", subject: "Gone" }]);
    expect(diff.unchangedCount).toBe(0);
  });
});

describe("diffSnapshots — label set differences", () => {
  it("computes labelsAdded and labelsRemoved as true set differences, sorted", () => {
    const before = snapshot([thread("t1", { labels: ["INBOX", "UNREAD", "Label_1"] })]);
    const after = snapshot([
      thread("t1", { labels: ["Label_1", "Label_9", "IMPORTANT"], unread: true }),
    ]);

    const diff = diffSnapshots(before, after);

    expect(diff.changed).toHaveLength(1);
    // Label_1 is in both, so it appears in neither array.
    expect(diff.changed[0].labelsAdded).toEqual(["IMPORTANT", "Label_9"]);
    expect(diff.changed[0].labelsRemoved).toEqual(["INBOX", "UNREAD"]);
  });

  it("is insensitive to the ordering of the label arrays it is handed", () => {
    const before = snapshot([thread("t1", { labels: ["UNREAD", "Label_1", "INBOX"] })]);
    const after = snapshot([thread("t1", { labels: ["Label_1", "INBOX", "UNREAD"] })]);

    const diff = diffSnapshots(before, after);

    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("reports duplicate-free differences even when a snapshot repeats a label", () => {
    const before = snapshot([thread("t1", { labels: ["INBOX", "INBOX"] })]);
    const after = snapshot([thread("t1", { labels: ["INBOX"] })]);

    const diff = diffSnapshots(before, after);

    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("emits empty label arrays when only unread flipped", () => {
    const before = snapshot([thread("t1", { unread: true })]);
    const after = snapshot([thread("t1", { unread: false })]);

    const diff = diffSnapshots(before, after);

    expect(diff.changed[0].labelsAdded).toEqual([]);
    expect(diff.changed[0].labelsRemoved).toEqual([]);
  });
});

describe("diffSnapshots — flag flips", () => {
  it("flags unread going true -> false", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { unread: true })]),
      snapshot([thread("t1", { unread: false })]),
    );
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].unreadChanged).toBe(true);
  });

  it("flags unread going false -> true", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { unread: false })]),
      snapshot([thread("t1", { unread: true })]),
    );
    expect(diff.changed[0].unreadChanged).toBe(true);
  });

  it("flags starred in both directions", () => {
    const on = diffSnapshots(
      snapshot([thread("t1", { starred: false })]),
      snapshot([thread("t1", { starred: true })]),
    );
    expect(on.changed[0].starredChanged).toBe(true);

    const off = diffSnapshots(
      snapshot([thread("t1", { starred: true })]),
      snapshot([thread("t1", { starred: false })]),
    );
    expect(off.changed[0].starredChanged).toBe(true);
  });

  it("omits the flag keys entirely when a flag did not move (a false costs tokens to say nothing)", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { unread: true, starred: false })]),
      snapshot([thread("t1", { unread: false, starred: false })]),
    );

    const entry = diff.changed[0];
    expect(entry.unreadChanged).toBe(true);
    expect("starredChanged" in entry).toBe(false);
    expect(Object.keys(entry).sort()).toEqual([
      "labelsAdded",
      "labelsRemoved",
      "messagesAdded",
      "subject",
      "threadId",
      "unreadChanged",
    ]);
  });

  it("carries both flags when both moved", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { unread: true, starred: true })]),
      snapshot([thread("t1", { unread: false, starred: false })]),
    );
    expect(diff.changed[0].unreadChanged).toBe(true);
    expect(diff.changed[0].starredChanged).toBe(true);
  });
});

describe("diffSnapshots — message counts", () => {
  it("reports messagesAdded when a reply lands on an existing thread", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { count: 2 })]),
      snapshot([thread("t1", { count: 5 })]),
    );
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].messagesAdded).toBe(3);
  });

  it("reports a negative messagesAdded when messages disappear", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { count: 4 })]),
      snapshot([thread("t1", { count: 1 })]),
    );
    expect(diff.changed[0].messagesAdded).toBe(-3);
  });

  it("counts a same-count thread as unchanged", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { count: 3 })]),
      snapshot([thread("t1", { count: 3 })]),
    );
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("carries messagesAdded: 0 on a thread changed for other reasons", () => {
    const diff = diffSnapshots(
      snapshot([thread("t1", { count: 2, labels: ["INBOX"] })]),
      snapshot([thread("t1", { count: 2, labels: [] })]),
    );
    expect(diff.changed[0].messagesAdded).toBe(0);
  });
});

describe("diffSnapshots — token discipline on unchanged threads", () => {
  it("counts untouched threads and lists none of them in any array", () => {
    const untouched = Array.from({ length: 40 }, (_, i) =>
      thread(`u${String(i).padStart(2, "0")}`, { labels: ["INBOX", "UNREAD"], unread: true }),
    );
    const touched = thread("moved", { subject: "Archive me", labels: ["INBOX"] });

    const before = snapshot([...untouched, touched]);
    const after = snapshot([...untouched, { ...touched, labels: [] }]);

    const diff = diffSnapshots(before, after);

    expect(diff.unchangedCount).toBe(40);
    expect(typeof diff.unchangedCount).toBe("number");
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].threadId).toBe("moved");

    // The point of the count: no untouched thread may appear anywhere in the
    // payload the judge is shown.
    const listed = [
      ...diff.added.map((t) => t.threadId),
      ...diff.removed.map((t) => t.threadId),
      ...diff.changed.map((t) => t.threadId),
    ];
    for (const t of untouched) expect(listed).not.toContain(t.threadId);
    expect(listed).toEqual(["moved"]);

    // And nothing sneaks the whole roster in via a stray field.
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain("u00");
    expect(serialized).not.toContain("u39");
  });

  it("does not count added or removed threads as unchanged", () => {
    const before = snapshot([thread("keep"), thread("drop")]);
    const after = snapshot([thread("keep"), thread("fresh")]);

    const diff = diffSnapshots(before, after);

    expect(diff.unchangedCount).toBe(1);
    expect(diff.added.map((t) => t.threadId)).toEqual(["fresh"]);
    expect(diff.removed.map((t) => t.threadId)).toEqual(["drop"]);
  });

  it("ignores fields the diff does not model — a changed subject alone is still unchanged", () => {
    // The diff is keyed on threadId and reports labels/flags/counts only. A
    // subject that drifts (Gmail re-deriving it from the newest message) must not
    // manufacture a phantom change with three empty deltas.
    const before = snapshot([thread("t1", { subject: "Old subject", date: 1 })]);
    const after = snapshot([thread("t1", { subject: "New subject", date: 2 })]);

    const diff = diffSnapshots(before, after);

    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });
});

describe("diffSnapshots — empty edge cases", () => {
  it("returns an all-empty diff for two empty mailboxes", () => {
    const diff = diffSnapshots(snapshot([]), snapshot([]));
    expect(diff).toEqual({ added: [], removed: [], changed: [], unchangedCount: 0 });
  });

  it("treats every thread as added when before is empty", () => {
    const diff = diffSnapshots(snapshot([]), snapshot([thread("a"), thread("b")]));
    expect(diff.added.map((t) => t.threadId)).toEqual(["a", "b"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("treats every thread as removed when after is empty", () => {
    const diff = diffSnapshots(snapshot([thread("a"), thread("b")]), snapshot([]));
    expect(diff.removed.map((t) => t.threadId)).toEqual(["a", "b"]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("handles a thread that lost every label", () => {
    const before = snapshot([thread("t1", { labels: ["INBOX", "UNREAD"] })]);
    const after = snapshot([thread("t1", { labels: [] })]);

    const diff = diffSnapshots(before, after);

    expect(diff.changed[0].labelsRemoved).toEqual(["INBOX", "UNREAD"]);
    expect(diff.changed[0].labelsAdded).toEqual([]);
  });

  it("handles a thread that started with no labels", () => {
    const before = snapshot([thread("t1", { labels: [] })]);
    const after = snapshot([thread("t1", { labels: ["Label_1"] })]);

    const diff = diffSnapshots(before, after);

    expect(diff.changed[0].labelsAdded).toEqual(["Label_1"]);
    expect(diff.changed[0].labelsRemoved).toEqual([]);
  });
});

describe("diffSnapshots — stable ordering", () => {
  // Capture order is whatever Gmail's pager returned; it must not leak into the
  // artifact, or two identical runs would produce diffs that look different.
  const beforeThreads = [
    thread("z1", { subject: "Zebra", labels: ["INBOX"] }),
    thread("a1", { subject: "Apple", labels: ["INBOX"] }),
    thread("m1", { subject: "Mango", labels: ["INBOX"] }),
    thread("d1", { subject: "Dropped" }),
    thread("d2", { subject: "Also dropped" }),
    thread("s2", { subject: "Same subject" }),
    thread("s1", { subject: "Same subject" }),
  ];
  const afterThreads = [
    thread("z1", { subject: "Zebra", labels: [] }),
    thread("a1", { subject: "Apple", labels: [] }),
    thread("m1", { subject: "Mango", labels: [] }),
    thread("s2", { subject: "Same subject", starred: true }),
    thread("s1", { subject: "Same subject", starred: true }),
    thread("n1", { subject: "New two" }),
    thread("n2", { subject: "New one" }),
  ];

  function shuffle<T>(xs: T[], seed: number): T[] {
    const out = [...xs];
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  it("sorts added, removed and changed by subject", () => {
    const diff = diffSnapshots(snapshot(beforeThreads), snapshot(afterThreads));

    expect(diff.added.map((t) => t.subject)).toEqual(["New one", "New two"]);
    expect(diff.removed.map((t) => t.subject)).toEqual(["Also dropped", "Dropped"]);
    expect(diff.changed.map((t) => t.subject)).toEqual([
      "Apple",
      "Mango",
      "Same subject",
      "Same subject",
      "Zebra",
    ]);
  });

  it("breaks subject ties on threadId, so identical subjects still order deterministically", () => {
    const diff = diffSnapshots(snapshot(beforeThreads), snapshot(afterThreads));
    const ties = diff.changed.filter((t) => t.subject === "Same subject");
    expect(ties.map((t) => t.threadId)).toEqual(["s1", "s2"]);
  });

  it("produces byte-identical output regardless of capture order", () => {
    const canonical = JSON.stringify(diffSnapshots(snapshot(beforeThreads), snapshot(afterThreads)));

    for (const seed of [1, 7, 42, 99, 1234]) {
      const diff = diffSnapshots(
        snapshot(shuffle(beforeThreads, seed)),
        snapshot(shuffle(afterThreads, seed * 3 + 1)),
      );
      expect(JSON.stringify(diff)).toBe(canonical);
    }
  });

  it("is not sensitive to capturedAt", () => {
    const a = diffSnapshots(snapshot(beforeThreads, 1), snapshot(afterThreads, 2));
    const b = diffSnapshots(snapshot(beforeThreads, 9_999), snapshot(afterThreads, 10_000));
    expect(a).toEqual(b);
  });

  it("does not mutate the snapshots it was given", () => {
    const before = snapshot(beforeThreads.map((t) => ({ ...t, labels: [...t.labels] })));
    const after = snapshot(afterThreads.map((t) => ({ ...t, labels: [...t.labels] })));
    const beforeCopy = structuredClone(before);
    const afterCopy = structuredClone(after);

    diffSnapshots(before, after);

    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });
});

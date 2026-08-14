// Acceptance harness: drive the sandbox with the OFFICIAL googleapis SDK, the
// same way a real agent would — only rootUrl is overridden. If this passes, an
// agent using googleapis works against the sandbox unchanged.
//
//   PORT=3600 npm run smoke
//
// Requires the server running on $PORT and a seeded workspace. It resets to the
// snapshot as its first act so it is repeatable, and therefore destroys whatever
// world is loaded — never point it at a twin that is mid-episode.

import { google, type docs_v1 } from "googleapis";
import { SEED_PLACEHOLDER } from "../src/lib/seed.js";

const OAuth2Client = google.auth.OAuth2;

const PORT = process.env.PORT || "3600";
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

// Pass an OAuth2Client with setCredentials — a string `auth` becomes a `key=`
// query param, NOT a bearer header (a classic footgun).
const auth = new OAuth2Client();
auth.setCredentials({ access_token: TOKEN });

const docs = google.docs({ version: "v1", auth, rootUrl: ROOT_URL });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}

async function expectError(name: string, fn: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await fn();
    check(name, false, "expected an error but call succeeded");
  } catch (e) {
    const status =
      (e as { response?: { status?: number }; code?: number }).response?.status ??
      (e as { code?: number }).code;
    check(name, status === code, { got: status, want: code });
  }
}

type Element = docs_v1.Schema$StructuralElement;

function bodyText(doc: docs_v1.Schema$Document): string {
  return (doc.body?.content ?? [])
    .flatMap((el) => el.paragraph?.elements ?? [])
    .map((el) => el.textRun?.content ?? "")
    .join("");
}

/** The Docs API has no list method, which is the point — find a seeded id the
 * way the control plane does, not the way a Drive-shaped clone would let you. */
async function seededDocuments(): Promise<Array<{ documentId: string; title: string }>> {
  const res = await fetch(`${ROOT_URL}/api/sandbox/snapshot`, {
    headers: { "x-sandbox-token": TOKEN },
  });
  const body = (await res.json()) as { documents?: Array<{ documentId: string; title: string }> };
  return body.documents ?? [];
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mGoogle Docs sandbox smoke — ${ROOT_URL}\x1b[0m`);

  const reset = await fetch(`${ROOT_URL}/api/sandbox/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": TOKEN },
    body: JSON.stringify({ note: "smoke" }),
  });
  check("reset to the pristine snapshot", reset.ok, reset.status);

  // --- reads -----------------------------------------------------------------
  console.log("\n\x1b[1mReads\x1b[0m");

  const seeded = await seededDocuments();
  const qbr = seeded.find((d) => d.title === "Q3 Business Review — draft");
  const northwind = seeded.find((d) => d.title === "Northwind escalation — incident notes");
  if (!qbr || !northwind) throw new Error("workspace is not seeded — run `npm run seed`");

  const got = await docs.documents.get({ documentId: qbr.documentId });
  check("documents.get returns the documentId", got.data.documentId === qbr.documentId);
  check("documents.get returns the title", got.data.title === qbr.title, got.data.title);

  const content = (got.data.body?.content ?? []) as Element[];
  check("body.content[0] is the section break", !!content[0]?.sectionBreak);
  check(
    "body.content[0].startIndex is omitted, not zero",
    content[0]?.startIndex === undefined,
    content[0]?.startIndex,
  );
  check("body.content[1].startIndex is 1", content[1]?.startIndex === 1, content[1]?.startIndex);
  check(
    "every element chains: content[k].startIndex === content[k-1].endIndex",
    content.every((el, k) => k === 0 || el.startIndex === content[k - 1].endIndex),
    content.map((el) => [el.startIndex, el.endIndex]),
  );
  check(
    "every paragraph element carries both indexes and a textStyle",
    content
      .slice(1)
      .flatMap((el) => el.paragraph?.elements ?? [])
      .every(
        (el) =>
          typeof el.startIndex === "number" &&
          typeof el.endIndex === "number" &&
          el.textRun?.textStyle !== undefined,
      ),
  );
  check(
    "the plain text contains the seed's placeholder",
    bodyText(got.data).includes(SEED_PLACEHOLDER),
    SEED_PLACEHOLDER,
  );

  const incident = await docs.documents.get({ documentId: northwind.documentId });
  const multiRun = (incident.data.body?.content ?? []).find(
    (el) => (el.paragraph?.elements?.length ?? 0) > 1,
  );
  check("a paragraph splits into more than one textRun where styling changes", !!multiRun);
  check(
    "the bolded run reports textStyle.bold",
    (multiRun?.paragraph?.elements ?? []).some((el) => el.textRun?.textStyle?.bold === true),
    multiRun?.paragraph?.elements?.map((el) => el.textRun?.textStyle),
  );

  const named = await docs.documents.get({ documentId: seeded.find((d) => d.title === "Audit evidence checklist")!.documentId });
  check(
    "namedRanges is keyed by name",
    !!named.data.namedRanges?.["Evidence owners"]?.namedRanges?.[0]?.namedRangeId,
    Object.keys(named.data.namedRanges ?? {}),
  );
  check("a document with no named ranges omits the key", got.data.namedRanges === undefined);
  const seededRange = named.data.namedRanges?.["Evidence owners"]?.namedRanges?.[0]?.ranges?.[0];
  check(
    "a body range is the two indexes and nothing else — no zero-valued segmentId",
    !!seededRange &&
      typeof seededRange.startIndex === "number" &&
      typeof seededRange.endIndex === "number" &&
      !("segmentId" in seededRange),
    seededRange,
  );

  const tabbed = await docs.documents.get({
    documentId: qbr.documentId,
    includeTabsContent: true,
  });
  check(
    "includeTabsContent returns tabs[0].documentTab.body",
    !!tabbed.data.tabs?.[0]?.documentTab?.body?.content?.length,
  );
  // The flag swaps views rather than adding one: upstream leaves the top-level
  // content fields unset under it, so an agent's `doc.tabs[0].documentTab.body`
  // is not a style choice but the only field with anything in it.
  check(
    "includeTabsContent leaves the top-level content fields unset",
    tabbed.data.body === undefined &&
      tabbed.data.documentStyle === undefined &&
      tabbed.data.namedStyles === undefined,
    Object.keys(tabbed.data),
  );
  check("a get without the flag carries no tabs key", got.data.tabs === undefined, Object.keys(got.data));

  // --- writes ----------------------------------------------------------------
  console.log("\n\x1b[1mWrites\x1b[0m");

  const created = await docs.documents.create({
    requestBody: { title: "Smoke test — please ignore" },
  });
  const documentId = created.data.documentId ?? "";
  check("documents.create mints a 44-char Docs id", /^1[A-Za-z0-9_-]{43}$/.test(documentId), documentId);
  check("documents.create honours the title", created.data.title === "Smoke test — please ignore");
  check(
    "a new document is a section break plus one empty paragraph",
    created.data.body?.content?.length === 2 &&
      created.data.body.content[1].endIndex === 2,
    created.data.body?.content?.map((el) => el.endIndex),
  );

  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertText: { text: "Hello", location: { index: 1 } } }] },
  });
  const afterInsert = await docs.documents.get({ documentId });
  check("insertText at index 1 lands the text", bodyText(afterInsert.data) === "Hello\n");
  check(
    "the following indexes shifted by the inserted length",
    afterInsert.data.body?.content?.[1]?.endIndex === 7,
    afterInsert.data.body?.content?.[1]?.endIndex,
  );

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ insertText: { text: "\nSecond", endOfSegmentLocation: { segmentId: "" } } }],
    },
  });
  const afterAppend = await docs.documents.get({ documentId });
  check("endOfSegmentLocation appends at the end", bodyText(afterAppend.data) === "Hello\nSecond\n");
  check("the append produced a second paragraph", (afterAppend.data.body?.content ?? []).length === 3);

  const replaced = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        { insertText: { text: " Hello", location: { index: 6 } } },
        { replaceAllText: { containsText: { text: "Hello" }, replaceText: "Goodbye" } },
      ],
    },
  });
  check(
    "replaceAllText reports occurrencesChanged",
    replaced.data.replies?.[1]?.replaceAllText?.occurrencesChanged === 2,
    replaced.data.replies,
  );
  check("replies has one entry per request", replaced.data.replies?.length === 2);
  check("a request with no response replies with {}", JSON.stringify(replaced.data.replies?.[0]) === "{}");

  const styled = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          updateParagraphStyle: {
            range: { startIndex: 1, endIndex: 1 },
            paragraphStyle: { namedStyleType: "HEADING_1" },
            fields: "namedStyleType",
          },
        },
      ],
    },
  });
  const afterStyle = await docs.documents.get({ documentId });
  const firstStyle = afterStyle.data.body?.content?.[1]?.paragraph?.paragraphStyle;
  check("updateParagraphStyle promotes the paragraph", firstStyle?.namedStyleType === "HEADING_1");
  check("a heading gets a headingId", /^h\./.test(firstStyle?.headingId ?? ""), firstStyle?.headingId);

  // The ordinary two-step agent flow — write a line, promote it, then add the
  // line under it — lands a newline inside the heading paragraph and splits it.
  // Both halves come back as HEADING_1, so both must carry an anchor: a heading
  // with an empty headingId is the vendor's way of saying "not a heading", and
  // the twin snapshot, which counts headings by namedStyleType, would report one
  // the agent reading paragraphStyle cannot find.
  const headingEnd = afterStyle.data.body?.content?.[1]?.endIndex ?? 2;
  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      // headingEnd - 1 is the heading's own newline: the last index inside it,
      // which is where an agent writes the line that follows it.
      requests: [{ insertText: { text: "\nAlso", location: { index: headingEnd - 1 } } }],
    },
  });
  const afterSplit = await docs.documents.get({ documentId });
  const splitStyles = (afterSplit.data.body?.content ?? [])
    .slice(1, 3)
    .map((el) => el.paragraph?.paragraphStyle);
  check(
    "a line added under a heading is itself a heading",
    splitStyles.length === 2 && splitStyles.every((s) => s?.namedStyleType === "HEADING_1"),
    splitStyles.map((s) => s?.namedStyleType),
  );
  check(
    "the paragraph split off a heading carries its own headingId",
    /^h\./.test(splitStyles[1]?.headingId ?? "") && splitStyles[1]?.headingId !== splitStyles[0]?.headingId,
    splitStyles.map((s) => s?.headingId),
  );

  const bookmark = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ createNamedRange: { name: "Smoke span", range: { startIndex: 1, endIndex: 4 } } }],
    },
  });
  check(
    "createNamedRange returns a kix id",
    /^kix\./.test(bookmark.data.replies?.[0]?.createNamedRange?.namedRangeId ?? ""),
    bookmark.data.replies,
  );
  const afterBookmark = await docs.documents.get({ documentId });
  check(
    "the named range comes back keyed by its name",
    !!afterBookmark.data.namedRanges?.["Smoke span"],
    Object.keys(afterBookmark.data.namedRanges ?? {}),
  );

  const lengthBefore = bodyText(afterBookmark.data).length;
  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 4 } } }] },
  });
  const afterDelete = await docs.documents.get({ documentId });
  check(
    "deleteContentRange shrinks the document by exactly the range length",
    bodyText(afterDelete.data).length === lengthBefore - 3,
    { before: lengthBefore, after: bodyText(afterDelete.data).length },
  );

  check(
    "revisionId changes between two consecutive batchUpdates",
    styled.data.writeControl?.requiredRevisionId !== bookmark.data.writeControl?.requiredRevisionId,
    [styled.data.writeControl, bookmark.data.writeControl],
  );

  const stale = afterInsert.data.revisionId ?? "";
  await expectError(
    "a stale writeControl.requiredRevisionId is rejected",
    () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{ insertText: { text: "x", location: { index: 1 } } }],
          writeControl: { requiredRevisionId: stale },
        },
      }),
    400,
  );

  // The seeded emoji, over the wire: it costs two indexes, and the index between
  // its halves is a number an agent can send but no edit may act on. A clone that
  // acts on it returns 200 and hands back U+FFFD — the character destroyed, with
  // nothing in the response to say so.
  const brief = seeded.find((d) => d.title === "Engineering onboarding brief")!;
  const emojiAt = bodyText((await docs.documents.get({ documentId: brief.documentId })).data).indexOf("😄");
  const between = emojiAt + 2; // the low surrogate's own index
  await expectError(
    "deleting one half of a surrogate pair is a 400",
    () =>
      docs.documents.batchUpdate({
        documentId: brief.documentId,
        requestBody: {
          requests: [{ deleteContentRange: { range: { startIndex: between, endIndex: between + 1 } } }],
        },
      }),
    400,
  );
  await docs.documents.batchUpdate({
    documentId: brief.documentId,
    requestBody: { requests: [{ insertText: { text: "!", location: { index: between } } }] },
  });
  const afterEmoji = bodyText((await docs.documents.get({ documentId: brief.documentId })).data);
  check(
    "an insert aimed between an emoji's halves lands after it, leaving it intact",
    // The emoji still reads as one character: a split pair would have reached
    // SQLite as half of one, come back UTF-8 encoded as U+FFFD, and failed this.
    afterEmoji.includes("😄!"),
    afterEmoji.slice(between - 12, between + 6),
  );

  // --- negatives -------------------------------------------------------------
  console.log("\n\x1b[1mNegatives\x1b[0m");

  await expectError(
    "an unknown documentId is a 404",
    () => docs.documents.get({ documentId: "1NoSuchDocument00000000000000000000000000Ab" }),
    404,
  );
  await expectError(
    "insertText at index 0 is a 400",
    () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ insertText: { text: "x", location: { index: 0 } } }] },
      }),
    400,
  );
  const end = afterDelete.data.body?.content?.slice(-1)[0]?.endIndex ?? 2;
  await expectError(
    "deleting the body's last newline is a 400",
    () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: end } } }],
        },
      }),
    400,
  );
  // The two silent successes this sandbox used to answer with. Both are here
  // rather than only in the unit suite because both were found over the wire:
  // they are what an agent gets back, and a 200 is what made them invisible.
  await expectError(
    "insertText setting both location and endOfSegmentLocation is a 400",
    () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            { insertText: { text: "ZZ", location: { index: 1 }, endOfSegmentLocation: {} } },
          ],
        },
      }),
    400,
  );
  await expectError(
    "updateParagraphStyle collapsed on the body's end index matches nothing and is a 400",
    () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              updateParagraphStyle: {
                range: { startIndex: end, endIndex: end },
                paragraphStyle: { namedStyleType: "HEADING_1" },
                fields: "namedStyleType",
              },
            },
          ],
        },
      }),
    400,
  );
  await expectError(
    "insertTable is an honest 501",
    () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ insertTable: { rows: 2, columns: 2 } }] },
      }),
    501,
  );

  const beforeAtomic = (await docs.documents.get({ documentId })).data.revisionId;
  await expectError(
    "a batch whose second request is invalid is a 400",
    () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            { insertText: { text: "should not land", location: { index: 1 } } },
            { deleteContentRange: { range: { startIndex: 0, endIndex: 2 } } },
          ],
        },
      }),
    400,
  );
  const afterAtomic = await docs.documents.get({ documentId });
  check(
    "the failed batch left the revisionId unchanged (atomicity)",
    afterAtomic.data.revisionId === beforeAtomic,
  );
  check(
    "the failed batch left the text unchanged",
    !bodyText(afterAtomic.data).includes("should not land"),
    bodyText(afterAtomic.data),
  );

  const strangerAuth = new OAuth2Client();
  strangerAuth.setCredentials({ access_token: "not-the-sandbox-token" });
  const stranger = google.docs({ version: "v1", auth: strangerAuth, rootUrl: ROOT_URL });
  await expectError(
    "a client with the wrong token is a 401",
    () => stranger.documents.get({ documentId }),
    401,
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\x1b[31msmoke crashed\x1b[0m", err);
  process.exit(2);
});

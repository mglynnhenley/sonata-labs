import { getDb } from "@/lib/db";
import { listDocumentRows } from "@/lib/store/documents";

export const dynamic = "force-dynamic";

// This is the API service and it has no editor UI — a Docs replica is phase 2,
// and UI port 4400 is reserved for it. A minimal landing page so the root is not
// a blank 404, listing the seeded document ids because the Docs API has no list
// method and a human otherwise has nothing to paste into a curl.

interface Listed {
  id: string;
  title: string;
}

function seededDocuments(): { documents: Listed[]; error: string | null } {
  try {
    return {
      documents: listDocumentRows(getDb()).map((row) => ({ id: row.id, title: row.title })),
      error: null,
    };
  } catch (err) {
    // An un-initialised database is the first thing that happens to anyone who
    // clones this repo, because data/*.db is gitignored. Say what to run instead
    // of rendering a 500.
    return { documents: [], error: (err as Error).message };
  }
}

export default function ApiHome() {
  const { documents, error } = seededDocuments();
  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 640,
        margin: "8vh auto",
        padding: "0 24px",
        lineHeight: 1.6,
        color: "#1f1f1f",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Google Docs Sandbox — API service</h1>
      <p style={{ color: "#5f6368", marginTop: 0 }}>
        A Google Docs API v1 clone the official <code>googleapis</code> SDK drives by overriding
        only <code>rootUrl</code>.
      </p>
      <ul>
        <li>
          <code>POST /v1/documents</code> — documents.create
        </li>
        <li>
          <code>GET /v1/documents/{"{documentId}"}</code> — documents.get
        </li>
        <li>
          <code>POST /v1/documents/{"{documentId}"}:batchUpdate</code> — the whole write surface
        </li>
        <li>
          <code>GET /api/health</code> — liveness, no credential
        </li>
        <li>
          <code>GET /api/activity</code> — the audit trail
        </li>
      </ul>
      <h2 style={{ fontSize: 16 }}>Documents in this workspace</h2>
      {error ? (
        <p style={{ color: "#5f6368" }}>
          No database yet — run <code>npm run db:init</code> then <code>npm run seed</code>.
        </p>
      ) : (
        <ul>
          {documents.map((doc) => (
            <li key={doc.id}>
              {doc.title} — <code>{doc.id}</code>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

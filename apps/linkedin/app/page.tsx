export const dynamic = "force-dynamic";

// This is the API service — it has no replica UI in this phase. A minimal
// landing page so the root is not a blank 404, and so that whoever lands here
// reads the partner-access paragraph, because they are exactly the person who
// might otherwise assume the clone is a route to data LinkedIn does not expose.
const ENDPOINTS: Array<[string, string]> = [
  ["GET /v2/userinfo", "who the agent is posting as (OpenID Connect)"],
  ["GET /rest/organizationAcls", "which company page it may act as"],
  ["GET /rest/organizations/{id}", "which company that URN names"],
  ["GET|POST /rest/posts", "read the page's recent posts, publish a new one"],
  ["GET|POST|DELETE /rest/posts/{urn}", "read, patch (incl. DRAFT → PUBLISHED), delete"],
  ["GET /rest/socialMetadata/{urn}", "engagement counts on a post or comment"],
  ["GET|POST /rest/socialActions/{urn}/comments", "read a thread, answer it"],
  ["POST /rest/reactions?actor=", "react to a post or a comment"],
  ["GET /api/health", "liveness and counts"],
  ["GET /api/activity", "the audit trail the judge reads"],
];

export default function ApiHome() {
  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 760,
        margin: "8vh auto",
        padding: "0 24px",
        lineHeight: 1.6,
        color: "#000000e6",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>LinkedIn Sandbox — API service</h1>
      <p style={{ color: "#00000099", marginTop: 0 }}>
        A LinkedIn-shaped REST API over a local SQLite copy of one company page. Nothing here
        reaches LinkedIn.
      </p>
      <ul style={{ paddingLeft: 20 }}>
        {ENDPOINTS.map(([path, what]) => (
          <li key={path}>
            <code>{path}</code> — {what}
          </li>
        ))}
      </ul>
      <p style={{ color: "#00000099" }}>
        Most of LinkedIn&rsquo;s API is partner-gated. Messaging, connections and invitations,
        profile and people search, follower and share statistics, and the Ads APIs are not
        implemented here and will not be — this is a local fake for agent benchmarking, not a
        route to data LinkedIn does not expose. See README.md.
      </p>
    </main>
  );
}

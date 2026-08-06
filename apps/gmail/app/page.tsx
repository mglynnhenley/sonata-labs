export const dynamic = "force-dynamic";

// This is the API service — it has no UI of its own (the Gmail-replica UI is the
// separate apps/gmail-ui service, which authenticates here as an OAuth client).
// A minimal landing page so the root isn't a blank 404.
export default function ApiHome() {
  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 640,
        margin: "8vh auto",
        padding: "0 24px",
        lineHeight: 1.6,
        color: "#1f2328",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Gmail Sandbox — API service</h1>
      <p style={{ color: "#57606a", marginTop: 0 }}>
        A provider-shaped Gmail API behind a real OAuth2 authorization server.
      </p>
      <ul>
        <li>
          <code>/gmail/v1/**</code> — the Gmail API (OAuth2 bearer token required)
        </li>
        <li>
          <code>/oauth/authorize</code>, <code>/oauth/token</code> — the authorization server
        </li>
        <li>
          <code>/api/health</code> — liveness
        </li>
      </ul>
      <p style={{ color: "#57606a" }}>
        The Gmail-replica web UI runs as a separate service and connects here as an OAuth client.
      </p>
    </main>
  );
}

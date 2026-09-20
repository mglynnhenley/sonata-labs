export const dynamic = "force-dynamic";

// This is the API service — it has no UI of its own (the Gmail-replica UI is the
// separate apps/gmail-ui service, which authenticates here as an OAuth client).
// The landing page exists for the human who opens this port by mistake: say
// what this is in plain words, and point at the door they actually wanted.
export default function ApiHome() {
  // Where the human-facing mailbox lives. The UI is its own service (the
  // API+800 pairing from the port scheme); overridable for moved deployments.
  const uiUrl = process.env.SONATA_GMAIL_UI_URL ?? "http://localhost:3901";
  return (
    <main
      style={{
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        maxWidth: 620,
        margin: "10vh auto",
        padding: "0 24px",
        lineHeight: 1.65,
        color: "#1f2328",
      }}
    >
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Gmail Sandbox</h1>
      <p style={{ fontSize: 17, color: "#57606a", marginTop: 0 }}>
        This port is the <strong>machine door</strong> — the fake Gmail API that
        AI agents and code connect to. There is nothing to see here.
      </p>

      <a
        href={uiUrl}
        style={{
          display: "block",
          background: "#ddf4ff",
          border: "1px solid #54aeff",
          borderRadius: 8,
          padding: "16px 20px",
          margin: "20px 0 28px",
          fontSize: 18,
          fontWeight: 600,
          color: "#0969da",
          textDecoration: "none",
        }}
      >
        📬 Looking for the inbox? Open the mailbox UI → {uiUrl}
      </a>

      <h2 style={{ fontSize: 15, textTransform: "uppercase", letterSpacing: 0.5, color: "#57606a" }}>
        What lives on this port
      </h2>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 15 }}>
        <tbody>
          {[
            ["/gmail/v1/**", "The Gmail-shaped API. Same routes as Google's real one, so unmodified SDKs and agents work here. Needs a bearer token."],
            ["/oauth/authorize, /oauth/token", "The sign-in machinery apps use to get that token."],
            ["/api/health", "One line of JSON saying whether this service is up and how many messages it holds."],
          ].map(([route, what]) => (
            <tr key={route} style={{ borderTop: "1px solid #d0d7de" }}>
              <td style={{ padding: "10px 16px 10px 0", whiteSpace: "nowrap", verticalAlign: "top" }}>
                <code style={{ background: "#f6f8fa", padding: "2px 6px", borderRadius: 4 }}>{route}</code>
              </td>
              <td style={{ padding: "10px 0", color: "#57606a" }}>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ color: "#8b949e", fontSize: 13, marginTop: 28 }}>
        Part of the Sonata Labs sandbox: every service here is a local
        stand-in for the real product, holding a simulated company an AI agent
        can work inside. Nothing on this machine talks to real Gmail.
      </p>
    </main>
  );
}

export const dynamic = "force-dynamic";

// This is the API service — it has no UI of its own. A minimal landing page so
// the root isn't a blank 404 for anyone who opens the port in a browser.
export default function ApiHome() {
  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 680,
        margin: "8vh auto",
        padding: "0 24px",
        lineHeight: 1.6,
        color: "#202124",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Google Ads Sandbox — API service</h1>
      <p style={{ color: "#5f6368", marginTop: 0 }}>
        A Google Ads-shaped REST API with a real GAQL parser, over a mutable SQLite copy of one
        advertiser account.
      </p>
      <ul>
        <li>
          <code>GET /v17/customers:listAccessibleCustomers</code>
        </li>
        <li>
          <code>POST /v17/customers/{"{customerId}"}/googleAds:search</code> and{" "}
          <code>:searchStream</code>
        </li>
        <li>
          <code>POST /v17/customers/{"{customerId}"}/campaigns:mutate</code> and{" "}
          <code>campaignBudgets:mutate</code>
        </li>
        <li>
          <code>/api/health</code>, <code>/api/activity</code> — liveness and the audit trail
        </li>
      </ul>
      <p style={{ color: "#5f6368" }}>
        Any <code>/v&lt;digits&gt;/</code> prefix is served, and the version you send is the one
        named in any error. Two credentials are required on every API call: an{" "}
        <code>authorization: Bearer</code> token and a non-empty <code>developer-token</code>{" "}
        header.
      </p>
    </main>
  );
}

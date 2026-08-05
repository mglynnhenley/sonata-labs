"use client";

import { useEffect } from "react";

// The last boundary. This one only fires when the root layout itself throws, so
// it replaces the whole document — no sidebar, and no stylesheet, because the
// layout that imported it is the thing that failed. Everything below is
// therefore inline, in the product's own palette, so even the worst failure in
// the dashboard still looks like the dashboard.

const BG = "#f2f1ec";
const SURFACE = "#fbfaf8";
const LINE = "#e3e0d7";
const INK = "#1b1a17";
const MUTED = "#5f5b52";
const PRIMARY = "#5b7089";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[sonata] the dashboard shell failed to render", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "32px",
          background: BG,
          color: INK,
          font: '15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <main
          style={{
            maxWidth: "460px",
            padding: "32px",
            borderRadius: "18px",
            border: `1px solid ${LINE}`,
            background: SURFACE,
            textAlign: "center",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 500 }}>Sonata could not start</h1>
          <p style={{ margin: "12px 0 0", color: MUTED, fontSize: "14px" }}>
            The dashboard shell itself failed to render, so nothing can be shown here. Your runs,
            scenarios and clones are untouched — they are files and rows on this machine.
          </p>
          <p style={{ margin: "12px 0 0", color: MUTED, fontSize: "14px" }}>
            Reload; if it happens again, the terminal running the dashboard has the full error.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "24px",
              padding: "9px 18px",
              borderRadius: "8px",
              border: "none",
              background: PRIMARY,
              color: SURFACE,
              fontSize: "14px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload the dashboard
          </button>
          <p style={{ margin: "18px 0 0", color: MUTED, fontSize: "12px", opacity: 0.8 }}>
            {error.message || "No message was reported."}
            {error.digest ? ` · ${error.digest}` : ""}
          </p>
        </main>
      </body>
    </html>
  );
}

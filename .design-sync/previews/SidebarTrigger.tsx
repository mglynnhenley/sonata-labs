import { SidebarTrigger } from "@sonata/ui";

const Wordmark = () => (
  <span style={{ fontWeight: 900, fontSize: 16, letterSpacing: "-0.02em", color: "#16181A" }}>
    Sonata Labs
  </span>
);

/** The sticky bar that stands in for the sidebar below the lg breakpoint. */
export const Bar = () => (
  <div style={{ width: 420, border: "1px solid #ECEAE2", borderRadius: 14, overflow: "hidden" }}>
    <SidebarTrigger onClick={() => {}} open={false} brand={<Wordmark />} />
    <div style={{ padding: "16px", fontSize: 13.5, color: "#5A6060", lineHeight: "20px" }}>
      On a narrow screen the sidebar folds into this bar; the button opens the
      drawer over the page.
    </div>
  </div>
);

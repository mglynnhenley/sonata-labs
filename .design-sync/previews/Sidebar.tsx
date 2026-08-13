import {
  Badge,
  IconBolt,
  IconCalendar,
  IconInbox,
  IconLayers,
  Sidebar,
  SidebarGroup,
  SidebarItem,
  SidebarUser,
} from "@sonata/ui";

const Wordmark = () => (
  <span style={{ fontWeight: 900, fontSize: 17, letterSpacing: "-0.02em", color: "#16181A" }}>
    Sonata Labs
  </span>
);

/**
 * Full shell composition. The transformed wrapper contains the sidebar's
 * fixed positioning (a transformed ancestor becomes the containing block),
 * and the inline height overrides h-dvh so the footer stays in frame.
 */
export const FullComposition = () => (
  <div
    style={{
      position: "relative",
      transform: "translateZ(0)",
      overflow: "hidden",
      height: 520,
      width: 254,
      display: "flex",
      borderRadius: 14,
      border: "1px solid #ECEAE2",
    }}
  >
    <Sidebar
      open
      brand={<Wordmark />}
      style={{ height: "100%" }}
      footer={<SidebarUser name="Matilda Henley" detail="Axiom Health workspace" href="#" />}
    >
      <SidebarGroup label="Workspace">
        <SidebarItem href="#" icon={<IconInbox size="md" />} active>
          Home
        </SidebarItem>
        <SidebarItem href="#" icon={<IconLayers size="md" />}>
          Clones
        </SidebarItem>
        <SidebarItem href="#" icon={<IconCalendar size="md" />}>
          Scenarios
        </SidebarItem>
      </SidebarGroup>
      <SidebarGroup label="Testing">
        <SidebarItem
          href="#"
          icon={<IconBolt size="md" />}
          trailing={
            <Badge status="running" size="sm">
              3 live
            </Badge>
          }
        >
          Runs
        </SidebarItem>
      </SidebarGroup>
    </Sidebar>
  </div>
);

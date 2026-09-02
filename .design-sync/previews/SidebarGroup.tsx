import {
  IconBolt,
  IconCalendar,
  IconInbox,
  IconLayers,
  SidebarGroup,
  SidebarItem,
} from "@sonata/ui";

/** Two labeled groups, the way the shell's nav is actually organised. */
export const Grouped = () => (
  <div style={{ width: 236 }}>
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
      <SidebarItem href="#" icon={<IconBolt size="md" />} count={8}>
        Runs
      </SidebarItem>
    </SidebarGroup>
  </div>
);

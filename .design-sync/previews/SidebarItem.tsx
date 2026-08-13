import {
  Badge,
  IconBolt,
  IconCalendar,
  IconInbox,
  IconLayers,
  IconMail,
  SidebarGroup,
  SidebarItem,
} from "@sonata/ui";

/** Every state, inside the unlabeled group that supplies the list context. */
export const States = () => (
  <div style={{ width: 236 }}>
    <SidebarGroup>
      <SidebarItem href="#" icon={<IconInbox size="md" />}>
        Home
      </SidebarItem>
      <SidebarItem href="#" icon={<IconBolt size="md" />} active>
        Runs
      </SidebarItem>
      <SidebarItem href="#" icon={<IconLayers size="md" />} count={12}>
        Clones
      </SidebarItem>
      <SidebarItem
        href="#"
        icon={<IconCalendar size="md" />}
        trailing={
          <Badge status="running" size="sm">
            live
          </Badge>
        }
      >
        Scenarios
      </SidebarItem>
      <SidebarItem href="#" icon={<IconMail size="md" />} disabled>
        Sources
      </SidebarItem>
    </SidebarGroup>
  </div>
);

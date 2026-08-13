import { SidebarUser } from "@sonata/ui";

/** Static block — derived initials, no chevron. */
export const Static = () => (
  <div style={{ width: 236 }}>
    <SidebarUser name="Matilda Henley" detail="matilda@sonatalabs.dev" />
  </div>
);

/** As a link — hover surface plus the trailing chevron. */
export const Linked = () => (
  <div style={{ width: 236 }}>
    <SidebarUser name="Matilda Henley" detail="Axiom Health workspace" href="#" />
  </div>
);

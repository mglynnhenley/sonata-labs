import type { Database } from "better-sqlite3";
import type { OrganizationAclRow, OrganizationRow } from "../linkedin/shape";

// The company page and who may act as it. The ACL half is not decoration: it is
// what makes POST /rest/posts refuse an organization the owner does not
// administer, which is the permission model an agent has to learn correctly.

export interface OrganizationInput {
  id: string;
  name: string;
  vanityName?: string | null;
}

export function insertOrganization(db: Database, input: OrganizationInput): OrganizationRow {
  db.prepare(
    `INSERT INTO organizations (id, name, vanity_name) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, vanity_name = excluded.vanity_name`,
  ).run(input.id, input.name, input.vanityName ?? null);
  const row = getOrganization(db, input.id);
  if (!row) throw new Error(`organization ${input.id} vanished after insert`);
  return row;
}

export function getOrganization(db: Database, id: string): OrganizationRow | null {
  return (
    (db.prepare("SELECT * FROM organizations WHERE id = ?").get(id) as OrganizationRow) ?? null
  );
}

export interface AclInput {
  organizationId: string;
  memberId: string;
  role?: string;
  state?: string;
}

export function insertAcl(db: Database, input: AclInput): void {
  db.prepare(
    `INSERT INTO organization_acls (organization_id, member_id, role, state) VALUES (?, ?, ?, ?)
     ON CONFLICT(organization_id, member_id, role) DO UPDATE SET state = excluded.state`,
  ).run(
    input.organizationId,
    input.memberId,
    input.role ?? "ADMINISTRATOR",
    input.state ?? "APPROVED",
  );
}

export interface AclQuery {
  role?: string;
  state?: string;
  start: number;
  count: number;
}

// Both finders fetch one row past the page so the route knows whether to emit a
// `next` link. Neither returns a total, because LinkedIn's organizationAcls
// samples do not carry one and an agent that learns to read it here would find
// it undefined against the real API.
function pageAcls(
  db: Database,
  where: string,
  params: unknown[],
  q: AclQuery,
): { rows: OrganizationAclRow[]; hasMore: boolean } {
  const clauses = [where];
  if (q.role) {
    clauses.push("role = ?");
    params.push(q.role);
  }
  if (q.state) {
    clauses.push("state = ?");
    params.push(q.state);
  }
  const rows = db
    .prepare(
      `SELECT * FROM organization_acls WHERE ${clauses.join(" AND ")}
       ORDER BY organization_id, member_id LIMIT ? OFFSET ?`,
    )
    .all(...params, q.count + 1, q.start) as OrganizationAclRow[];
  return { rows: rows.slice(0, q.count), hasMore: rows.length > q.count };
}

export function listAclsForMember(
  db: Database,
  memberId: string,
  q: AclQuery,
): { rows: OrganizationAclRow[]; hasMore: boolean } {
  return pageAcls(db, "member_id = ?", [memberId], q);
}

export function listAclsForOrganization(
  db: Database,
  organizationId: string,
  q: AclQuery,
): { rows: OrganizationAclRow[]; hasMore: boolean } {
  return pageAcls(db, "organization_id = ?", [organizationId], q);
}

/** The single check POST /rest/posts and the comment-as-a-page path both call. */
export function hasApprovedAdminAcl(
  db: Database,
  organizationId: string,
  memberId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM organization_acls
       WHERE organization_id = ? AND member_id = ? AND role = 'ADMINISTRATOR' AND state = 'APPROVED'`,
    )
    .get(organizationId, memberId);
  return row !== undefined;
}

export function countOrganizations(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM organizations").get() as { n: number }).n;
}

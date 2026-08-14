import type { Database } from "better-sqlite3";
import { badRequestError, notFoundError } from "./errors";
import { getObjectBySlug } from "../store/objects";
import { getMemberByEmail, getMemberById } from "../store/members";
import { findRecordByValue, getRecordRow } from "../store/records";

// Task links and assignees, normalised from every form Attio accepts. Shared by
// POST /v2/tasks and PATCH /v2/tasks/{task_id} so the two can never disagree
// about what an assignee is.
//
// Note the error split, which is Attio's and not ours: a malformed or
// unresolvable shape is 400 `validation_type`, while a well-formed reference to
// a record that does not exist is 404 `not_found`. `value_not_found` belongs to
// the records endpoints and is deliberately not used here.

export interface ResolvedLink {
  targetObject: string;
  targetRecordId: string;
}

export interface ResolvedAssignee {
  actorType: string;
  actorId: string;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveLinkedRecords(db: Database, raw: unknown): ResolvedLink[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw badRequestError("data.linked_records must be an array.");
  }
  return raw.map((entry) => {
    if (typeof entry === "string") {
      // The same email/domain shorthand the record-reference writer takes.
      const isEmail = entry.includes("@");
      const slug = isEmail ? "people" : "companies";
      const object = getObjectBySlug(db, slug);
      const found = object
        ? findRecordByValue(db, object.id, isEmail ? "email_addresses" : "domains", entry)
        : null;
      if (!found) {
        throw notFoundError(`Could not find a ${slug} record matching "${entry}".`);
      }
      return { targetObject: slug, targetRecordId: found.id };
    }
    if (!isRecordObject(entry)) {
      throw badRequestError(
        "Each linked record must be a {target_object, target_record_id} pair or an " +
          "email/domain shorthand.",
      );
    }
    const objectSlug = entry.target_object ?? entry.target_object_id;
    const recordId = entry.target_record_id;
    if (typeof objectSlug !== "string" || typeof recordId !== "string") {
      throw badRequestError(
        "Each linked record must carry target_object and target_record_id.",
      );
    }
    const object = getObjectBySlug(db, objectSlug);
    if (!object) {
      throw badRequestError(
        `Only standard or custom object records can be linked to; "${objectSlug}" is ` +
          `not an object in this workspace.`,
      );
    }
    if (!getRecordRow(db, object.id, recordId)) {
      throw notFoundError(`Record with ID "${recordId}" not found.`);
    }
    return { targetObject: object.api_slug, targetRecordId: recordId };
  });
}

export function resolveAssignees(db: Database, raw: unknown): ResolvedAssignee[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw badRequestError("data.assignees must be an array.");
  }
  return raw.map((entry) => {
    const member =
      typeof entry === "string"
        ? getMemberByEmail(db, entry)
        : isRecordObject(entry)
          ? typeof entry.referenced_actor_id === "string"
            ? getMemberById(db, entry.referenced_actor_id)
            : typeof entry.workspace_member_email_address === "string"
              ? getMemberByEmail(db, entry.workspace_member_email_address)
              : null
          : null;
    if (!member) {
      throw badRequestError(
        `Assignee ${JSON.stringify(entry)} does not resolve to a workspace member — ` +
          `list GET /v2/workspace_members to find one.`,
      );
    }
    return { actorType: "workspace-member", actorId: member.id };
  });
}

import { Types } from "mongoose";
import { ForbiddenError } from "./errors";

export const ROLES = ["owner", "admin", "manager", "sales_rep", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "workspace:manage"
  | "members:manage"
  | "pipeline:configure"
  | "records:read_all"
  | "records:create"
  | "records:update"
  | "records:assign"
  | "records:archive"
  | "reports:view"
  | "audit:view"
  | "apikeys:manage"
  | "billing:manage";

const MATRIX: Record<Permission, Role[]> = {
  "workspace:manage": ["owner", "admin"],
  "members:manage": ["owner", "admin"],
  "pipeline:configure": ["owner", "admin", "manager"],
  "records:read_all": ["owner", "admin", "manager", "viewer"],
  "records:create": ["owner", "admin", "manager", "sales_rep"],
  "records:update": ["owner", "admin", "manager", "sales_rep"],
  "records:assign": ["owner", "admin", "manager"],
  "records:archive": ["owner", "admin", "manager"],
  "reports:view": ["owner", "admin", "manager", "sales_rep", "viewer"],
  "audit:view": ["owner", "admin"],
  "apikeys:manage": ["owner", "admin"],
  "billing:manage": ["owner"],
};

export function can(role: Role, permission: Permission) {
  return MATRIX[permission].includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(MATRIX) as Permission[]).filter((p) => can(role, p));
}

export interface WorkspaceContext {
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  role: Role;
}

export function requirePermission(ctx: WorkspaceContext, permission: Permission) {
  if (!can(ctx.role, permission)) throw new ForbiddenError();
}

/**
 * Base tenant filter for a collection. Sales reps only see records they own;
 * every other role sees the whole workspace (viewers read-only).
 */
export function scopeFilter(ctx: WorkspaceContext, ownerField: string = "ownerId"): Record<string, unknown> {
  const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId };
  if (!can(ctx.role, "records:read_all")) filter[ownerField] = ctx.userId;
  return filter;
}

/** Owner/admin may assign to anyone; managers too. Sales reps may only assign to themselves. */
export function resolveOwner(ctx: WorkspaceContext, requested?: string | null): Types.ObjectId {
  if (!requested) return ctx.userId;
  if (requested === String(ctx.userId)) return ctx.userId;
  if (!can(ctx.role, "records:assign")) throw new ForbiddenError("You cannot assign records to other members");
  return new Types.ObjectId(requested);
}

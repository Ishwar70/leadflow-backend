import type { Types } from "mongoose";
import { Activity, ACTIVITY_TYPES } from "../models/Activity";
import { AuditLog, Notification, NOTIFICATION_TYPES } from "../models/System";
import { User } from "../models/User";
import type { WorkspaceContext } from "./permissions";
import type { EntityType } from "../models/Task";

const SECRET_KEYS = new Set(["passwordHash", "tokenHash", "keyHash", "resetTokenHash"]);

function sanitize(value: unknown): unknown {
  if (!value || typeof value !== "object") return value ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!SECRET_KEYS.has(k)) out[k] = v;
  }
  return out;
}

const nameCache = new Map<string, string>();

async function actorName(actorId: Types.ObjectId | null) {
  if (!actorId) return "System";
  const key = String(actorId);
  if (nameCache.has(key)) return nameCache.get(key)!;
  const user = await User.findById(actorId).select("name").lean();
  const name = user?.name ?? "Unknown";
  if (nameCache.size > 500) nameCache.clear();
  nameCache.set(key, name);
  return name;
}

export async function audit(
  ctx: Pick<WorkspaceContext, "workspaceId"> & { userId: Types.ObjectId | null },
  action: string,
  entityType: string,
  entityId: Types.ObjectId | null,
  opts: { entityName?: string; before?: unknown; after?: unknown } = {},
) {
  await AuditLog.create({
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    actorName: await actorName(ctx.userId),
    action,
    entityType,
    entityId,
    entityName: opts.entityName ?? "",
    before: sanitize(opts.before),
    after: sanitize(opts.after),
  });
}

export async function logActivity(
  ctx: Pick<WorkspaceContext, "workspaceId"> & { userId: Types.ObjectId | null },
  input: {
    type: (typeof ACTIVITY_TYPES)[number];
    links: Array<{ entityType: EntityType; entityId: Types.ObjectId }>;
    summary: string;
    body?: string;
    isSystem?: boolean;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  },
) {
  return Activity.create({
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    type: input.type,
    links: input.links,
    summary: input.summary,
    body: input.body ?? "",
    isSystem: input.isSystem ?? true,
    metadata: input.metadata ?? {},
    occurredAt: input.occurredAt ?? new Date(),
  });
}

export async function notify(input: {
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  type: (typeof NOTIFICATION_TYPES)[number];
  title: string;
  body?: string;
  link?: string;
}) {
  await Notification.create(input);
}

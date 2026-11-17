import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit";
import { NotFoundError } from "../../lib/errors";
import { created, ok, paramId, parse } from "../../lib/http";
import { requirePermission } from "../../lib/permissions";
import { randomToken, sha256 } from "../../lib/tokens";
import { ctxOf } from "../../middleware/auth";
import { ApiKey, AuditLog, Notification } from "../../models/System";

export const auditRouter = Router();
export const notificationRouter = Router();
export const apiKeyRouter = Router();

auditRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "audit:view");
  const q = parse(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      entityType: z.string().trim().max(30).optional(),
    }),
    req.query,
  );
  const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId };
  if (q.entityType) filter.entityType = q.entityType;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
});

notificationRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const filter = { workspaceId: ctx.workspaceId, userId: ctx.userId };
  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(30).lean(),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);
  ok(res, { items, unread });
});

notificationRouter.post("/read-all", async (req, res) => {
  const ctx = ctxOf(req);
  await Notification.updateMany({ workspaceId: ctx.workspaceId, userId: ctx.userId, readAt: null }, { readAt: new Date() });
  ok(res, { read: true });
});

notificationRouter.post("/:id/read", async (req, res) => {
  const ctx = ctxOf(req);
  await Notification.updateOne(
    { _id: paramId(req.params.id), workspaceId: ctx.workspaceId, userId: ctx.userId },
    { readAt: new Date() },
  );
  ok(res, { read: true });
});

apiKeyRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "apikeys:manage");
  const keys = await ApiKey.find({ workspaceId: ctx.workspaceId }).sort({ createdAt: -1 }).populate("createdBy", "name").lean();
  ok(res, keys);
});

apiKeyRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "apikeys:manage");
  const { name } = parse(z.object({ name: z.string().trim().min(1, "Name is required").max(80) }), req.body);
  const secret = `lf_live_${randomToken(24)}`;
  const key = await ApiKey.create({
    workspaceId: ctx.workspaceId,
    name,
    prefix: secret.slice(0, 12),
    keyHash: sha256(secret),
    createdBy: ctx.userId,
  });
  await audit(ctx, "api_key.created", "api_key", key._id, { entityName: name });
  created(res, { _id: key._id, name, prefix: key.prefix, key: secret, createdAt: key.createdAt });
});

apiKeyRouter.delete("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "apikeys:manage");
  const key = await ApiKey.findOneAndUpdate(
    { _id: paramId(req.params.id), workspaceId: ctx.workspaceId, revokedAt: null },
    { revokedAt: new Date() },
  );
  if (!key) throw new NotFoundError("API key");
  await audit(ctx, "api_key.revoked", "api_key", key._id, { entityName: key.name });
  ok(res, { revoked: true });
});

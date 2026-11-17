import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const AuditLogSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "System" },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, default: null },
    entityName: { type: String, default: "" },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "audit_logs" },
);
AuditLogSchema.index({ workspaceId: 1, createdAt: -1 });
AuditLogSchema.index({ workspaceId: 1, entityType: 1, entityId: 1 });

export type AuditLogDoc = InferSchemaType<typeof AuditLogSchema>;
export const AuditLog: Model<AuditLogDoc> = models.AuditLog || model("AuditLog", AuditLogSchema);

export const NOTIFICATION_TYPES = [
  "lead_assigned",
  "task_due",
  "task_overdue",
  "deal_stage",
  "invitation_accepted",
  "import_completed",
] as const;

const NotificationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    link: { type: String, default: "" },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);
NotificationSchema.index({ workspaceId: 1, userId: 1, createdAt: -1 });

export type NotificationDoc = InferSchemaType<typeof NotificationSchema>;
export const Notification: Model<NotificationDoc> =
  models.Notification || model("Notification", NotificationSchema);

const ApiKeySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true, select: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "api_keys" },
);
ApiKeySchema.index({ workspaceId: 1, createdAt: -1 });

export type ApiKeyDoc = InferSchemaType<typeof ApiKeySchema>;
export const ApiKey: Model<ApiKeyDoc> = models.ApiKey || model("ApiKey", ApiKeySchema);

import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { ENTITY_TYPES } from "./Task";

export const ACTIVITY_TYPES = [
  "note",
  "call",
  "meeting",
  "email",
  "whatsapp",
  "created",
  "status_change",
  "assigned",
  "deal_stage",
  "deal_won",
  "deal_lost",
  "converted",
  "task_completed",
] as const;

export const MANUAL_ACTIVITY_TYPES = ["note", "call", "meeting", "email", "whatsapp"] as const;

const LinkSchema = new Schema(
  {
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
  },
  { _id: false },
);

const ActivitySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    links: { type: [LinkSchema], default: [] },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    summary: { type: String, required: true, maxlength: 300 },
    body: { type: String, default: "", maxlength: 10000 },
    isSystem: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

ActivitySchema.index({ workspaceId: 1, "links.entityType": 1, "links.entityId": 1, occurredAt: -1 });
ActivitySchema.index({ workspaceId: 1, occurredAt: -1 });

export type ActivityDoc = InferSchemaType<typeof ActivitySchema>;
export const Activity: Model<ActivityDoc> = models.Activity || model("Activity", ActivitySchema);

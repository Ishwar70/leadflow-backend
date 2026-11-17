import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const ENTITY_TYPES = ["lead", "contact", "company", "deal"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const TaskSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", maxlength: 4000 },
    type: { type: String, enum: ["call", "email", "meeting", "follow_up", "general"], default: "general" },
    priority: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ["open", "completed"], default: "open" },
    completedAt: { type: Date, default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", required: true },
    relatedType: { type: String, enum: [...ENTITY_TYPES, null], default: null },
    relatedId: { type: Schema.Types.ObjectId, default: null },
    relatedName: { type: String, default: "" },
    reminderSentAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

TaskSchema.index({ workspaceId: 1, assignedTo: 1, dueAt: 1, status: 1 });
TaskSchema.index({ workspaceId: 1, relatedType: 1, relatedId: 1 });
TaskSchema.index({ status: 1, dueAt: 1, reminderSentAt: 1 });

export type TaskDoc = InferSchemaType<typeof TaskSchema>;
export const Task: Model<TaskDoc> = models.Task || model("Task", TaskSchema);

import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const StageSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  order: { type: Number, required: true },
  probability: { type: Number, min: 0, max: 100, default: 10 },
  type: { type: String, enum: ["open", "won", "lost"], default: "open" },
  color: { type: String, default: "#6366f1" },
});

const PipelineSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    isDefault: { type: Boolean, default: false },
    stages: { type: [StageSchema], default: [] },
  },
  { timestamps: true },
);
PipelineSchema.index({ workspaceId: 1, isDefault: -1 });

export type PipelineDoc = InferSchemaType<typeof PipelineSchema>;
export const Pipeline: Model<PipelineDoc> = models.Pipeline || model("Pipeline", PipelineSchema);

export const DEFAULT_STAGES = [
  { name: "Discovery", order: 0, probability: 10, type: "open", color: "#6366f1" },
  { name: "Qualified", order: 1, probability: 25, type: "open", color: "#8b5cf6" },
  { name: "Proposal", order: 2, probability: 50, type: "open", color: "#0ea5e9" },
  { name: "Negotiation", order: 3, probability: 75, type: "open", color: "#f59e0b" },
  { name: "Won", order: 4, probability: 100, type: "won", color: "#10b981" },
  { name: "Lost", order: 5, probability: 0, type: "lost", color: "#f43f5e" },
] as const;

const DealSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    pipelineId: { type: Schema.Types.ObjectId, ref: "Pipeline", required: true },
    stageId: { type: Schema.Types.ObjectId, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Company", default: null },
    contactId: { type: Schema.Types.ObjectId, ref: "Contact", default: null },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    value: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "INR" },
    probability: { type: Number, min: 0, max: 100, default: 10 },
    expectedCloseDate: { type: Date, default: null },
    status: { type: String, enum: ["open", "won", "lost"], default: "open" },
    finalAmount: { type: Number, default: null },
    closedAt: { type: Date, default: null },
    lostReason: { type: String, default: null },
    stageChangedAt: { type: Date, default: Date.now },
    searchText: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

DealSchema.index({ workspaceId: 1, pipelineId: 1, stageId: 1 });
DealSchema.index({ workspaceId: 1, status: 1, closedAt: -1 });
DealSchema.index({ workspaceId: 1, ownerId: 1 });
DealSchema.index({ workspaceId: 1, companyId: 1 });

export type DealDoc = InferSchemaType<typeof DealSchema>;
export const Deal: Model<DealDoc> = models.Deal || model("Deal", DealSchema);

const DealStageHistorySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    dealId: { type: Schema.Types.ObjectId, ref: "Deal", required: true },
    fromStageId: { type: Schema.Types.ObjectId, default: null },
    toStageId: { type: Schema.Types.ObjectId, required: true },
    fromStageName: { type: String, default: null },
    toStageName: { type: String, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "deal_stage_history" },
);
DealStageHistorySchema.index({ workspaceId: 1, dealId: 1, createdAt: -1 });

export const DealStageHistory = models.DealStageHistory || model("DealStageHistory", DealStageHistorySchema);

import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const LEAD_STATUSES = ["new", "contacted", "qualified", "unqualified", "converted"] as const;
export const LEAD_SOURCES = ["website", "referral", "ads", "email", "phone", "whatsapp", "event", "other"] as const;

const LeadSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, trim: true, default: "", maxlength: 80 },
    email: { type: String, trim: true, default: null },
    normalizedEmail: { type: String, default: null },
    phone: { type: String, trim: true, default: null },
    normalizedPhone: { type: String, default: null },
    companyName: { type: String, trim: true, default: "" },
    jobTitle: { type: String, trim: true, default: "" },
    source: { type: String, enum: LEAD_SOURCES, default: "other" },
    status: { type: String, enum: LEAD_STATUSES, default: "new" },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    estimatedValue: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "INR" },
    tags: [{ type: String, trim: true }],
    city: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    lastContactedAt: { type: Date, default: null },
    nextFollowUpAt: { type: Date, default: null },
    convertedAt: { type: Date, default: null },
    convertedContactId: { type: Schema.Types.ObjectId, ref: "Contact", default: null },
    convertedCompanyId: { type: Schema.Types.ObjectId, ref: "Company", default: null },
    convertedDealId: { type: Schema.Types.ObjectId, ref: "Deal", default: null },
    idempotencyKey: { type: String, default: undefined },
    searchText: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

LeadSchema.index({ workspaceId: 1, createdAt: -1 });
LeadSchema.index({ workspaceId: 1, status: 1, ownerId: 1 });
LeadSchema.index({ workspaceId: 1, normalizedEmail: 1 });
LeadSchema.index({ workspaceId: 1, normalizedPhone: 1 });
LeadSchema.index({ workspaceId: 1, archivedAt: 1, searchText: 1 });
LeadSchema.index(
  { workspaceId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

export type LeadDoc = InferSchemaType<typeof LeadSchema>;
export const Lead: Model<LeadDoc> = models.Lead || model("Lead", LeadSchema);

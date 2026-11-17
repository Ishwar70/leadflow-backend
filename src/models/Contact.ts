import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const ContactSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: null },
    normalizedEmail: { type: String, default: null },
    phone: { type: String, trim: true, default: null },
    normalizedPhone: { type: String, default: null },
    jobTitle: { type: String, trim: true, default: "" },
    companyId: { type: Schema.Types.ObjectId, ref: "Company", default: null },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    tags: [{ type: String, trim: true }],
    city: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    searchText: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ContactSchema.index({ workspaceId: 1, createdAt: -1 });
ContactSchema.index({ workspaceId: 1, companyId: 1 });
ContactSchema.index({ workspaceId: 1, normalizedEmail: 1 });
ContactSchema.index({ workspaceId: 1, ownerId: 1 });

export type ContactDoc = InferSchemaType<typeof ContactSchema>;
export const Contact: Model<ContactDoc> = models.Contact || model("Contact", ContactSchema);

const CompanySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    domain: { type: String, trim: true, lowercase: true, default: "" },
    industry: { type: String, trim: true, default: "" },
    size: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    searchText: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

CompanySchema.index({ workspaceId: 1, createdAt: -1 });
CompanySchema.index({ workspaceId: 1, ownerId: 1 });
CompanySchema.index({ workspaceId: 1, domain: 1 });

export type CompanyDoc = InferSchemaType<typeof CompanySchema>;
export const Company: Model<CompanyDoc> = models.Company || model("Company", CompanySchema);

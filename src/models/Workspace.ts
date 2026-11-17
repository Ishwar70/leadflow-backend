import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { ROLES } from "../lib/permissions";

const WorkspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    industry: { type: String, default: "Software services" },
    size: { type: String, default: "1-10" },
    timezone: { type: String, default: "Asia/Kolkata" },
    country: { type: String, default: "India" },
    currency: { type: String, default: "INR" },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    isDemo: { type: Boolean, default: false },
    settings: {
      autoAssignPublicLeads: { type: Boolean, default: true },
      roundRobinCursor: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

export type WorkspaceDoc = InferSchemaType<typeof WorkspaceSchema>;
export const Workspace: Model<WorkspaceDoc> = models.Workspace || model("Workspace", WorkspaceSchema);

const MembershipSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: ["active", "deactivated"], default: "active" },
  },
  { timestamps: true, collection: "workspace_memberships" },
);
MembershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
MembershipSchema.index({ userId: 1, status: 1 });

export type MembershipDoc = InferSchemaType<typeof MembershipSchema>;
export const Membership: Model<MembershipDoc> = models.Membership || model("Membership", MembershipSchema);

const InvitationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES.filter((r) => r !== "owner"), required: true },
    tokenHash: { type: String, required: true, select: false },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "accepted", "revoked"], default: "pending" },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
InvitationSchema.index({ workspaceId: 1, email: 1, status: 1 });
InvitationSchema.index({ tokenHash: 1 });

export type InvitationDoc = InferSchemaType<typeof InvitationSchema>;
export const Invitation: Model<InvitationDoc> = models.Invitation || model("Invitation", InvitationSchema);

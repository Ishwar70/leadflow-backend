import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    activeWorkspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    resetTokenHash: { type: String, default: null, select: false },
    resetTokenExpires: { type: Date, default: null, select: false },
    failedLogins: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof UserSchema>;
export const User: Model<UserDoc> = models.User || model("User", UserSchema);

import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { appUrl, env } from "../../config/env";
import { AppError, ConflictError, UnauthorizedError, ValidationError } from "../../lib/errors";
import { ok, parse } from "../../lib/http";
import { emailEnabled, emailLayout, sendEmail } from "../../lib/email";
import { clearSessionCookie, randomToken, setSessionCookie, sha256 } from "../../lib/tokens";
import { requireAuth } from "../../middleware/auth";
import { User } from "../../models/User";
import { getSession } from "../workspaces/workspace.service";

export const authRouter = Router();

// Requests may arrive through the frontend's proxy, where many users share an IP,
// so limits are keyed per IP + email; per-account lockout still stops brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}|${String(req.body?.email ?? "").toLowerCase()}`,
  skip: () => env().NODE_ENV === "test",
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many attempts, try again later" } },
});

const demoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env().NODE_ENV === "test",
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many demo sessions, try again later" } },
});

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a number");

const RegisterSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password,
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

authRouter.post("/register", authLimiter, async (req, res) => {
  const input = parse(RegisterSchema, req.body);
  if (await User.exists({ email: input.email })) {
    throw new ConflictError("EMAIL_TAKEN", "An account with this email already exists", { email: "Email already registered" });
  }
  const user = await User.create({
    name: input.name,
    email: input.email,
    passwordHash: await bcrypt.hash(input.password, 10),
  });
  setSessionCookie(res, String(user._id));
  ok(res, await getSession(user._id), undefined, 201);
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const input = parse(LoginSchema, req.body);
  const user = await User.findOne({ email: input.email }).select("+passwordHash +failedLogins +lockUntil");
  if (!user) throw new UnauthorizedError("Invalid email or password");
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new AppError(423, "ACCOUNT_LOCKED", `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }
  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    user.failedLogins = (user.failedLogins ?? 0) + 1;
    if (user.failedLogins >= MAX_FAILED) {
      user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedLogins = 0;
    }
    await user.save();
    throw new UnauthorizedError("Invalid email or password");
  }
  if (user.failedLogins || user.lockUntil) {
    user.failedLogins = 0;
    user.lockUntil = null;
    await user.save();
  }
  setSessionCookie(res, String(user._id));
  ok(res, await getSession(user._id));
});

authRouter.post("/demo", demoLimiter, async (req, res) => {
  if (!env().DEMO_MODE) throw new AppError(404, "NOT_FOUND", "Demo mode is disabled");
  const { role } = parse(
    z.object({ role: z.enum(["owner", "admin", "manager", "sales_rep", "viewer"]).default("owner") }),
    req.body ?? {},
  );
  const email = `${role.replace("_", "")}@demo.leadflow.app`;
  const user = await User.findOne({ email });
  if (!user) throw new AppError(503, "DEMO_NOT_SEEDED", "Demo workspace has not been seeded yet");
  setSessionCookie(res, String(user._id));
  ok(res, await getSession(user._id));
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  ok(res, { loggedOut: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const session = await getSession(req.userId!);
  if (!session) throw new UnauthorizedError();
  ok(res, session);
});

authRouter.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  if (!emailEnabled()) {
    throw new AppError(503, "EMAIL_NOT_CONFIGURED", "Password reset email is not configured on this deployment");
  }
  const user = await User.findOne({ email });
  if (user) {
    const token = randomToken();
    await User.updateOne(
      { _id: user._id },
      { resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + 60 * 60 * 1000) },
    );
    const url = `${appUrl()}/reset-password?token=${token}`;
    await sendEmail(
      email,
      "Reset your LeadFlow password",
      emailLayout("Reset your password", "This link is valid for 60 minutes. If you did not request it, you can ignore this email.", "Reset password", url),
    );
  }
  ok(res, { message: "If that account exists, a reset link has been sent." });
});

authRouter.post("/reset-password", authLimiter, async (req, res) => {
  const input = parse(z.object({ token: z.string().min(10), password }), req.body);
  const user = await User.findOne({
    resetTokenHash: sha256(input.token),
    resetTokenExpires: { $gt: new Date() },
  });
  if (!user) throw new ValidationError("This reset link is invalid or has expired");
  await User.updateOne(
    { _id: user._id },
    { passwordHash: await bcrypt.hash(input.password, 10), resetTokenHash: null, resetTokenExpires: null },
  );
  setSessionCookie(res, String(user._id));
  ok(res, await getSession(user._id));
});

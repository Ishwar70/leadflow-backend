import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { env } from "../config/env";

export const AUTH_COOKIE = "lf_token";
const SESSION_DAYS = 7;

export function signSession(userId: string) {
  return jwt.sign({ sub: userId }, env().JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

export function verifySession(token: string): string | null {
  try {
    const payload = jwt.verify(token, env().JWT_SECRET) as jwt.JwtPayload;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, userId: string) {
  res.cookie(AUTH_COOKIE, signSession(userId), {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(AUTH_COOKIE, { path: "/" });
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

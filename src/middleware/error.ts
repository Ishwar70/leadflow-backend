import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { AppError } from "../lib/errors";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found" } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const fieldErrors: Record<string, string> = {};
    for (const [k, v] of Object.entries(err.errors)) fieldErrors[k] = v.message;
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid data", fieldErrors } });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ success: false, error: { code: "INVALID_ID", message: "Invalid identifier" } });
  }
  if (typeof err === "object" && err && (err as { type?: string }).type === "entity.too.large") {
    return res.status(413).json({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
  }
  if (typeof err === "object" && err && (err as { code?: number }).code === 11000) {
    return res.status(409).json({ success: false, error: { code: "DUPLICATE", message: "Duplicate record" } });
  }
  console.error(JSON.stringify({ level: "error", path: req.path, message: (err as Error)?.message, stack: (err as Error)?.stack }));
  return res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
}

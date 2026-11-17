export class AppError extends Error {
  details?: unknown;
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity = "Resource") {
    super(404, "NOT_FOUND", `${entity} not found`);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super(403, "FORBIDDEN", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(400, "VALIDATION_ERROR", message, fieldErrors);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, fieldErrors?: Record<string, string>) {
    super(409, code, message, fieldErrors);
  }
}
